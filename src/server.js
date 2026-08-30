const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_GAME_ID = 1;

app.use(express.json());

function resolveGameId(gameId) {
  const parsed = Number(gameId ?? DEFAULT_GAME_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GAME_ID;
}

function summarizeActivityRows(rows, now = Date.now()) {
  let totalMs = 0;
  let activeStart = null;

  for (const row of rows) {
    const timestampMs = new Date(row.timestamp).getTime();

    if (Number(row.in_play) === 1) {
      activeStart = timestampMs;
      continue;
    }

    if (activeStart !== null) {
      totalMs += timestampMs - activeStart;
      activeStart = null;
    }
  }

  const lastRow = rows[rows.length - 1];
  if (lastRow && Number(lastRow.in_play) === 1 && activeStart !== null) {
    totalMs += now - activeStart;
  }

  return Math.max(0, totalMs / 1000);
}

async function getPlayerSummary(playerId, gameId) {
  const resolvedGameId = resolveGameId(gameId);
  const rows = await db.all(
    'SELECT * FROM player_activity WHERE game_id = ? AND player_id = ? ORDER BY timestamp ASC',
    [resolvedGameId, playerId]
  );

  const lastRow = rows[rows.length - 1];
  return {
    totalSeconds: summarizeActivityRows(rows),
    isInStage: !!lastRow && Number(lastRow.in_play) === 1
  };
}

async function getCumulativePlayerSeconds(playerId) {
  const rows = await db.all(
    'SELECT * FROM player_activity WHERE player_id = ? ORDER BY timestamp ASC',
    [playerId]
  );

  return summarizeActivityRows(rows);
}

async function getActivitySummaryMap(gameId) {
  const resolvedGameId = resolveGameId(gameId);
  const rows = await db.all(
    'SELECT * FROM player_activity WHERE game_id = ? ORDER BY player_id ASC, timestamp ASC',
    [resolvedGameId]
  );

  const grouped = new Map();
  for (const row of rows) {
    const key = Number(row.player_id);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(row);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([playerId, playerRows]) => {
      const lastRow = playerRows[playerRows.length - 1];
      return [String(playerId), {
        totalSeconds: summarizeActivityRows(playerRows),
        isInStage: !!lastRow && Number(lastRow.in_play) === 1
      }];
    })
  );
}

async function getCumulativeSummaryMap() {
  const rows = await db.all(
    'SELECT * FROM player_activity ORDER BY player_id ASC, timestamp ASC'
  );

  const grouped = new Map();
  for (const row of rows) {
    const key = Number(row.player_id);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(row);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([playerId, playerRows]) => [String(playerId), summarizeActivityRows(playerRows)])
  );
}

app.get('/api/game', async (req, res) => {
  const game = await db.get('SELECT * FROM games WHERE id = ?', [DEFAULT_GAME_ID]);
  res.json({ game });
});

app.get('/api/game/:gameId', async (req, res) => {
  const gameId = resolveGameId(req.params.gameId);
  const game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  res.json({ game });
});

app.get('/api/games', async (req, res) => {
  const games = await db.all('SELECT * FROM games ORDER BY id ASC');
  res.json({ games });
});

app.post('/api/games', async (req, res) => {
  const { name, location, month, day, year, date } = req.body || {};

  const normalizedDate = date || (() => {
    const monthValue = String(month ?? '').padStart(2, '0');
    const dayValue = String(day ?? '').padStart(2, '0');
    const yearValue = String(year ?? '');

    if (!monthValue || !dayValue || !yearValue) {
      return null;
    }

    return `${yearValue}-${monthValue}-${dayValue}`;
  })();

  if (!location || !normalizedDate) {
    return res.status(400).json({ message: 'Location and date are required.' });
  }

  const dateValue = new Date(`${normalizedDate}T00:00:00`);
  if (Number.isNaN(dateValue.getTime())) {
    return res.status(400).json({ message: 'The selected date is invalid.' });
  }

  const gameName = name && String(name).trim() ? String(name).trim() : 'Soccer Match';

  const result = await db.run(
    'INSERT INTO games (name, created_at, location, date, is_active) VALUES (?, ?, ?, ?, ?)',
    [gameName, new Date().toISOString(), String(location).trim(), normalizedDate, 1]
  );

  const newGame = await db.get('SELECT * FROM games WHERE id = ?', [result.id]);
  return res.status(201).json({ game: newGame });
});

app.put('/api/game/status', async (req, res) => {
  const { isActive, gameId } = req.body || {};
  const resolvedGameId = resolveGameId(gameId ?? DEFAULT_GAME_ID);

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive is required.' });
  }

  const game = await db.get('SELECT * FROM games WHERE id = ?', [resolvedGameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!isActive) {
    const activePlayers = await db.all(
      'SELECT DISTINCT player_id FROM player_activity WHERE game_id = ? AND in_play = 1',
      [resolvedGameId]
    );

    for (const { player_id } of activePlayers) {
      const lastActivity = await db.get(
        'SELECT * FROM player_activity WHERE game_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1',
        [resolvedGameId, player_id]
      );

      if (lastActivity && Number(lastActivity.in_play) === 1) {
        await db.run(
          'INSERT INTO player_activity (game_id, player_id, in_play, timestamp) VALUES (?, ?, ?, ?)',
          [resolvedGameId, player_id, 0, new Date().toISOString()]
        );
      }
    }
  }

  await db.run('UPDATE games SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, resolvedGameId]);
  const updatedGame = await db.get('SELECT * FROM games WHERE id = ?', [resolvedGameId]);

  return res.json({ game: updatedGame });
});

app.put('/api/game/:gameId/status', async (req, res) => {
  const { isActive } = req.body || {};
  const gameId = resolveGameId(req.params.gameId);

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive is required.' });
  }

  const game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!isActive) {
    const activePlayers = await db.all(
      'SELECT DISTINCT player_id FROM player_activity WHERE game_id = ? AND in_play = 1',
      [gameId]
    );

    for (const { player_id } of activePlayers) {
      const lastActivity = await db.get(
        'SELECT * FROM player_activity WHERE game_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1',
        [gameId, player_id]
      );

      if (lastActivity && Number(lastActivity.in_play) === 1) {
        await db.run(
          'INSERT INTO player_activity (game_id, player_id, in_play, timestamp) VALUES (?, ?, ?, ?)',
          [gameId, player_id, 0, new Date().toISOString()]
        );
      }
    }
  }

  await db.run('UPDATE games SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, gameId]);
  const updatedGame = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);

  return res.json({ game: updatedGame });
});

app.get('/api/players', async (req, res) => {
  const gameId = DEFAULT_GAME_ID;
  const includeArchived = req.query.includeArchived === 'true';
  const whereClause = includeArchived ? '' : 'WHERE archive = 0';
  const players = await db.all(`SELECT * FROM players ${whereClause} ORDER BY id ASC`);

  const gameSummaryMap = await getActivitySummaryMap(gameId);
  const cumulativeMap = await getCumulativeSummaryMap();

  const payload = players.map((player) => {
    const summary = gameSummaryMap[String(player.id)] || { totalSeconds: 0, isInStage: false };
    const cumulativeSeconds = cumulativeMap[String(player.id)] || 0;

    return {
      id: player.id,
      firstName: player.first_name,
      lastName: player.last_name,
      archive: Number(player.archive) === 1,
      fullName: `${player.first_name} ${player.last_name}`,
      inStage: summary.isInStage,
      totalSeconds: summary.totalSeconds,
      cumulativeSeconds,
      totalMinutes: summary.totalSeconds / 60,
      cumulativeMinutes: cumulativeSeconds / 60
    };
  });

  res.json(payload);
});

app.post('/api/players', async (req, res) => {
  const { firstName, lastName } = req.body || {};
  const trimmedFirst = String(firstName ?? '').trim();
  const trimmedLast = String(lastName ?? '').trim();

  if (!trimmedFirst || !trimmedLast) {
    return res.status(400).json({ message: 'First name and last name are required.' });
  }

  const result = await db.run(
    'INSERT INTO players (first_name, last_name, archive, created_at) VALUES (?, ?, ?, ?)',
    [trimmedFirst, trimmedLast, 0, new Date().toISOString()]
  );

  const player = await db.get('SELECT * FROM players WHERE id = ?', [result.id]);
  return res.status(201).json({ player });
});

app.put('/api/players/unarchive', async (req, res) => {
  await db.run('UPDATE players SET archive = 0 WHERE archive = 1');
  return res.json({ updated: true });
});

app.put('/api/players/:id', async (req, res) => {
  const playerId = Number(req.params.id);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    return res.status(400).json({ message: 'A valid player ID is required.' });
  }

  const { firstName, lastName, archive } = req.body || {};
  const updates = [];
  const values = [];

  if (typeof firstName === 'string') {
    const trimmedFirst = firstName.trim();
    if (!trimmedFirst) {
      return res.status(400).json({ message: 'First name cannot be empty.' });
    }
    updates.push('first_name = ?');
    values.push(trimmedFirst);
  }

  if (typeof lastName === 'string') {
    const trimmedLast = lastName.trim();
    if (!trimmedLast) {
      return res.status(400).json({ message: 'Last name cannot be empty.' });
    }
    updates.push('last_name = ?');
    values.push(trimmedLast);
  }

  if (typeof archive === 'boolean') {
    updates.push('archive = ?');
    values.push(archive ? 1 : 0);
  }

  if (!updates.length) {
    return res.status(400).json({ message: 'No player changes provided.' });
  }

  await db.run(`UPDATE players SET ${updates.join(', ')} WHERE id = ?`, [...values, playerId]);
  const player = await db.get('SELECT * FROM players WHERE id = ?', [playerId]);
  return res.json({ player });
});

app.get('/api/players/:gameId', async (req, res) => {
  const gameId = resolveGameId(req.params.gameId);
  const players = await db.all('SELECT * FROM players WHERE archive = 0 ORDER BY id ASC');

  const gameSummaryMap = await getActivitySummaryMap(gameId);

  const payload = players.map((player) => {
    const summary = gameSummaryMap[String(player.id)] || { totalSeconds: 0, isInStage: false };

    return {
      id: player.id,
      firstName: player.first_name,
      lastName: player.last_name,
      archive: Number(player.archive) === 1,
      fullName: `${player.first_name} ${player.last_name}`,
      inStage: summary.isInStage,
      totalSeconds: summary.totalSeconds,
      totalMinutes: summary.totalSeconds / 60
    };
  });

  res.json(payload);
});

app.get('/api/stage', async (req, res) => {
  const gameId = DEFAULT_GAME_ID;
  const activePlayers = await db.all(
    `
      SELECT p.id, p.first_name, p.last_name
      FROM players p
      INNER JOIN (
        SELECT player_id, MAX(id) AS latest_activity_id
        FROM player_activity
        WHERE game_id = ?
        GROUP BY player_id
      ) latest
        ON latest.player_id = p.id
      INNER JOIN player_activity a
        ON a.id = latest.latest_activity_id
      WHERE a.in_play = 1 AND p.archive = 0
      ORDER BY p.id ASC
    `,
    [gameId]
  );

  res.json(
    activePlayers.map((player) => ({
      id: player.id,
      firstName: player.first_name,
      lastName: player.last_name,
      fullName: `${player.first_name} ${player.last_name}`
    }))
  );
});

app.get('/api/stage/:gameId', async (req, res) => {
  const gameId = resolveGameId(req.params.gameId);
  const activePlayers = await db.all(
    `
      SELECT p.id, p.first_name, p.last_name
      FROM players p
      INNER JOIN (
        SELECT player_id, MAX(id) AS latest_activity_id
        FROM player_activity
        WHERE game_id = ?
        GROUP BY player_id
      ) latest
        ON latest.player_id = p.id
      INNER JOIN player_activity a
        ON a.id = latest.latest_activity_id
      WHERE a.in_play = 1 AND p.archive = 0
      ORDER BY p.id ASC
    `,
    [gameId]
  );

  res.json(
    activePlayers.map((player) => ({
      id: player.id,
      firstName: player.first_name,
      lastName: player.last_name,
      fullName: `${player.first_name} ${player.last_name}`
    }))
  );
});

app.post('/api/segments', async (req, res) => {
  const { playerId, inPlay, gameId } = req.body;

  if (!playerId || typeof inPlay !== 'boolean') {
    return res.status(400).json({ message: 'playerId and inPlay are required.' });
  }

  const resolvedGameId = resolveGameId(gameId);
  const playerExists = await db.get('SELECT id FROM players WHERE id = ? AND archive = 0', [playerId]);
  if (!playerExists) {
    return res.status(404).json({ message: 'Player not found or archived.' });
  }

  const lastActivity = await db.get(
    'SELECT * FROM player_activity WHERE game_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1',
    [resolvedGameId, playerId]
  );

  if (inPlay && lastActivity && Number(lastActivity.in_play) === 1) {
    return res.status(409).json({ message: 'Player is already active on the stage.' });
  }

  if (!inPlay && (!lastActivity || Number(lastActivity.in_play) === 0)) {
    return res.status(409).json({ message: 'Player is not currently active on the stage.' });
  }

  const timestamp = new Date().toISOString();
  const result = await db.run(
    'INSERT INTO player_activity (game_id, player_id, in_play, timestamp) VALUES (?, ?, ?, ?)',
    [resolvedGameId, playerId, inPlay ? 1 : 0, timestamp]
  );

  const segment = {
    id: result.id,
    gameId: resolvedGameId,
    playerId,
    inPlay,
    timestamp
  };

  const summary = await getPlayerSummary(playerId, resolvedGameId);

  return res.status(201).json({ segment, summary });
});

app.get('/', (req, res) => {
  res.redirect('/games');
});

app.get('/roster', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'roster.html'));
});

app.get('/games', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'games.html'));
});

app.get('/new-game', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'new-game.html'));
});

app.get('/games/:gameId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function startServer() {
  await db.initialize();

  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`Soccer game tracker running at http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  resolveGameId,
  summarizeActivityRows,
  getPlayerSummary,
  getCumulativePlayerSeconds,
  getActivitySummaryMap,
  getCumulativeSummaryMap,
  startServer
};
