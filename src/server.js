require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const mailer = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_GAME_ID = 1;
const DEFAULT_TEAM_ID = 1;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'soccer-tracker-demo-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION
  }
}));

function getSessionUserId(req) {
  const userId = Number(req.session?.userId);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

function parseUserTeamIds(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((teamId) => Number(teamId)).filter((teamId) => Number.isFinite(teamId) && teamId > 0) : [];
  } catch (error) {
    return [];
  }
}

async function syncUserTeamMembership(userId, teamId) {
  if (!userId || !teamId) {
    return;
  }

  await db.run(
    'INSERT OR IGNORE INTO user_team_memberships (user_id, team_id) VALUES (?, ?)',
    [userId, teamId]
  );

  const rows = await db.all(
    'SELECT team_id FROM user_team_memberships WHERE user_id = ? ORDER BY team_id ASC',
    [userId]
  );

  const teamIds = rows.map((row) => Number(row.team_id));
  await db.run('UPDATE users SET team_ids = ? WHERE id = ?', [JSON.stringify(teamIds), userId]);
}

async function removeUserTeamMembership(userId, teamId) {
  await db.run(
    'DELETE FROM user_team_memberships WHERE user_id = ? AND team_id = ?',
    [userId, teamId]
  );

  const rows = await db.all(
    'SELECT team_id FROM user_team_memberships WHERE user_id = ? ORDER BY team_id ASC',
    [userId]
  );

  const teamIds = rows.map((row) => Number(row.team_id));
  await db.run('UPDATE users SET team_ids = ? WHERE id = ?', [JSON.stringify(teamIds), userId]);
}

async function getCurrentUserTeamIds(userId) {
  if (!userId) {
    return [];
  }

  const user = await db.get('SELECT team_ids FROM users WHERE id = ?', [userId]);
  return parseUserTeamIds(user?.team_ids || '[]');
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendVerificationEmail(user) {
  const token = generateVerificationToken();
  await db.run('UPDATE users SET verification_token = ? WHERE id = ?', [token, user.id]);

  const verificationUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  console.log(`[Email Verification] Sent to ${user.email}`);
  console.log(`[Email Verification] Verify here: ${verificationUrl}`);

  await mailer.sendMail({
    to: user.email,
    subject: 'Verify your Game Time Tracker account',
    text: `Hi ${user.first_name},\n\nPlease verify your email address by visiting the link below:\n${verificationUrl}\n\nIf you did not create this account, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.first_name)},</p><p>Please verify your email address by clicking the link below:</p><p><a href="${verificationUrl}">${verificationUrl}</a></p><p>If you did not create this account, you can ignore this email.</p>`
  });

  return verificationUrl;
}

async function sendPasswordResetEmail(user) {
  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.run(
    'UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?',
    [token, expiresAt, user.id]
  );

  const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  console.log(`[Password Reset] Sent to ${user.email}`);
  console.log(`[Password Reset] Reset here: ${resetUrl}`);

  await mailer.sendMail({
    to: user.email,
    subject: 'Reset your Game Time Tracker password',
    text: `Hi ${user.first_name},\n\nWe received a request to reset your password. This link expires in 1 hour:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.first_name)},</p><p>We received a request to reset your password. This link expires in 1 hour:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, you can safely ignore this email.</p>`
  });

  return resetUrl;
}

async function userHasTeamAccess(userId, teamId) {
  const currentTeamId = Number(teamId);
  if (!userId || !Number.isFinite(currentTeamId) || currentTeamId <= 0) {
    return false;
  }

  const teamIds = await getCurrentUserTeamIds(userId);
  return teamIds.includes(currentTeamId);
}

function requireAuth(req, res, next) {
  if (!getSessionUserId(req)) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  return next();
}

function resolveGameId(gameId) {
  const parsed = Number(gameId ?? DEFAULT_GAME_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GAME_ID;
}

function resolveTeamId(teamId) {
  const parsed = Number(teamId ?? DEFAULT_TEAM_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TEAM_ID;
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
    `
      SELECT pa.* FROM player_activity pa
      INNER JOIN games g ON g.id = pa.game_id
      WHERE pa.player_id = ? AND g.archived = 0
      ORDER BY pa.timestamp ASC
    `,
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
  const rows = await db.all(`
    SELECT pa.* FROM player_activity pa
    INNER JOIN games g ON g.id = pa.game_id
    WHERE g.archived = 0
    ORDER BY pa.player_id ASC, pa.timestamp ASC
  `);

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
  const game = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [DEFAULT_GAME_ID]);
  res.json({ game });
});

app.get('/api/game/:gameId', async (req, res) => {
  const gameId = resolveGameId(req.params.gameId);
  const game = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [gameId]);
  res.json({ game });
});

app.get('/api/games', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamIdParam = req.query.teamId;
  const teamId = teamIdParam === undefined ? null : resolveTeamId(teamIdParam);

  if (teamId !== null && !(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const archivedOnly = req.query.archived === 'true';
  const conditions = [`g.archived = ${archivedOnly ? 1 : 0}`];
  const params = [];

  if (teamId !== null) {
    conditions.push('g.team_id = ?');
    params.push(teamId);
  }

  const games = await db.all(
    `
      SELECT g.*, t.team_name AS team_name
      FROM games g
      LEFT JOIN teams t ON t.id = g.team_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY g.id ASC
    `,
    params
  );

  return res.json({ games });
});

app.post('/api/games', async (req, res) => {
  const { name, location, month, day, year, date, team_id } = req.body || {};

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
  const resolvedTeamId = resolveTeamId(team_id ?? DEFAULT_TEAM_ID);

  const result = await db.run(
    'INSERT INTO games (name, created_at, location, date, is_active, team_id) VALUES (?, ?, ?, ?, ?, ?)',
    [gameName, new Date().toISOString(), String(location).trim(), normalizedDate, 1, resolvedTeamId]
  );

  const newGame = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [result.id]);
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

app.put('/api/games/unarchive', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamId = resolveTeamId(req.body?.teamId ?? DEFAULT_TEAM_ID);
  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const result = await db.run(
    'UPDATE games SET archived = 0 WHERE team_id = ? AND archived = 1',
    [teamId]
  );

  return res.json({ updated: result.changes });
});

app.put('/api/games/:gameId', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  const game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const { name, location, date, isActive } = req.body || {};

  const trimmedName = String(name ?? '').trim();
  const trimmedLocation = String(location ?? '').trim();
  const normalizedDate = String(date ?? '').trim();

  if (!trimmedName || !trimmedLocation || !normalizedDate) {
    return res.status(400).json({ message: 'Name, location, and date are required.' });
  }

  const dateValue = new Date(`${normalizedDate}T00:00:00`);
  if (Number.isNaN(dateValue.getTime())) {
    return res.status(400).json({ message: 'The selected date is invalid.' });
  }

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive is required.' });
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

  await db.run(
    'UPDATE games SET name = ?, location = ?, date = ?, is_active = ? WHERE id = ?',
    [trimmedName, trimmedLocation, normalizedDate, isActive ? 1 : 0, gameId]
  );

  const updatedGame = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [gameId]);

  return res.json({ game: updatedGame });
});

app.put('/api/games/:gameId/archive', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  const game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const { archived } = req.body || {};
  if (typeof archived !== 'boolean') {
    return res.status(400).json({ message: 'archived is required.' });
  }

  await db.run('UPDATE games SET archived = ? WHERE id = ?', [archived ? 1 : 0, gameId]);
  const updatedGame = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [gameId]);

  return res.json({ game: updatedGame });
});

app.get('/api/players', async (req, res) => {
  const gameId = DEFAULT_GAME_ID;
  const includeArchived = req.query.includeArchived === 'true';
  const teamId = resolveTeamId(req.query.teamId ?? DEFAULT_TEAM_ID);
  const players = await db.all(
    includeArchived
      ? 'SELECT * FROM players WHERE team_id = ? ORDER BY id ASC'
      : 'SELECT * FROM players WHERE team_id = ? AND archive = 0 ORDER BY id ASC',
    [teamId]
  );

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
  const { firstName, lastName, teamId } = req.body || {};
  const trimmedFirst = String(firstName ?? '').trim();
  const trimmedLast = String(lastName ?? '').trim();
  const resolvedTeamId = resolveTeamId(teamId ?? DEFAULT_TEAM_ID);

  if (!trimmedFirst || !trimmedLast) {
    return res.status(400).json({ message: 'First name and last name are required.' });
  }

  const result = await db.run(
    'INSERT INTO players (first_name, last_name, archive, team_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [trimmedFirst, trimmedLast, 0, resolvedTeamId, new Date().toISOString()]
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
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  const teamId = resolveTeamId(req.query.teamId ?? DEFAULT_TEAM_ID);
  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const players = await db.all('SELECT * FROM players WHERE team_id = ? AND archive = 0 ORDER BY id ASC', [teamId]);

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

app.get('/api/teams', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamIds = await getCurrentUserTeamIds(currentUserId);

  if (!teamIds.length) {
    return res.json({ teams: [] });
  }

  const placeholders = teamIds.map(() => '?').join(', ');
  const teams = await db.all(`SELECT * FROM teams WHERE id IN (${placeholders}) ORDER BY team_name COLLATE NOCASE ASC`, teamIds);
  const gameCounts = await db.all('SELECT team_id, COUNT(*) AS game_count FROM games GROUP BY team_id');
  const playerCounts = await db.all('SELECT team_id, COUNT(*) AS player_count FROM players GROUP BY team_id');

  const gameMap = new Map(gameCounts.map((row) => [Number(row.team_id), Number(row.game_count)]));
  const playerMap = new Map(playerCounts.map((row) => [Number(row.team_id), Number(row.player_count)]));

  return res.json({
    teams: teams.map((team) => ({
      id: team.id,
      teamName: team.team_name,
      gameCount: gameMap.get(Number(team.id)) || 0,
      playerCount: playerMap.get(Number(team.id)) || 0
    }))
  });
});

app.post('/api/teams', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { teamName } = req.body || {};
  const trimmedName = String(teamName ?? '').trim();

  if (!trimmedName) {
    return res.status(400).json({ message: 'Team name is required.' });
  }

  const existing = await db.get('SELECT id FROM teams WHERE team_name = ?', [trimmedName]);
  if (existing) {
    return res.status(409).json({ message: 'A team with that name already exists.' });
  }

  const result = await db.run('INSERT INTO teams (team_name, user_admin_id) VALUES (?, ?)', [trimmedName, currentUserId]);
  await syncUserTeamMembership(currentUserId, result.id);
  const team = await db.get('SELECT * FROM teams WHERE id = ?', [result.id]);

  return res.status(201).json({ team });
});

app.get('/api/teams/directory', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const memberTeamIds = await getCurrentUserTeamIds(currentUserId);
  const teams = await db.all('SELECT * FROM teams ORDER BY team_name COLLATE NOCASE ASC');
  const joinableTeams = teams.filter((team) => !memberTeamIds.includes(Number(team.id)));

  return res.json({
    teams: joinableTeams.map((team) => ({
      id: team.id,
      teamName: team.team_name
    }))
  });
});

app.post('/api/teams/join', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamId = Number(req.body?.teamId);
  if (!Number.isFinite(teamId) || teamId <= 0) {
    return res.status(400).json({ message: 'A team must be selected.' });
  }

  const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);
  if (!team) {
    return res.status(404).json({ message: 'Team not found.' });
  }

  if (await userHasTeamAccess(currentUserId, teamId)) {
    return res.status(409).json({ message: 'You are already a member of that team.' });
  }

  await syncUserTeamMembership(currentUserId, teamId);

  return res.status(201).json({ team });
});

app.get('/api/teams/:teamId', async (req, res) => {
  const teamId = resolveTeamId(req.params.teamId);
  const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);

  if (!team) {
    return res.status(404).json({ message: 'Team not found.' });
  }

  return res.json({ team });
});

app.put('/api/teams/:teamId', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const { teamName } = req.body || {};
  const trimmedName = String(teamName ?? '').trim();
  if (!trimmedName) {
    return res.status(400).json({ message: 'Team name is required.' });
  }

  const existing = await db.get('SELECT id FROM teams WHERE team_name = ? AND id != ?', [trimmedName, teamId]);
  if (existing) {
    return res.status(409).json({ message: 'A team with that name already exists.' });
  }

  await db.run('UPDATE teams SET team_name = ? WHERE id = ?', [trimmedName, teamId]);
  const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);

  return res.json({ team });
});

app.delete('/api/teams/:teamId/membership', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(404).json({ message: 'That team is not in your teams list.' });
  }

  await removeUserTeamMembership(currentUserId, teamId);

  return res.json({ success: true });
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

app.get('/api/session', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.json({ user: null });
  }

  const user = await db.get('SELECT id, first_name, last_name, email, team_ids, email_verified, created_at FROM users WHERE id = ?', [userId]);
  if (!user) {
    req.session.destroy(() => undefined);
    return res.json({ user: null });
  }

  return res.json({
    user: {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      emailVerified: Number(user.email_verified) === 1,
      teamIds: parseUserTeamIds(user.team_ids),
      createdAt: user.created_at
    }
  });
});

app.get('/verify-email', async (req, res) => {
  const token = String(req.query.token ?? '').trim();
  if (!token) {
    return res.status(400).send('<html><body><h1>Verification Error</h1><p>Missing verification token.</p><p><a href="/login">Return to login</a></p></body></html>');
  }

  const user = await db.get('SELECT * FROM users WHERE verification_token = ?', [token]);
  if (!user) {
    return res.status(400).send('<html><body><h1>Verification Failed</h1><p>This verification link is invalid or has already been used.</p><p><a href="/login">Return to login</a></p></body></html>');
  }

  if (Number(user.email_verified) === 1) {
    return res.send('<html><body><h1>Email Already Verified</h1><p>Your email has already been verified.</p><p><a href="/login">Go to login</a></p></body></html>');
  }

  await db.run(
    'UPDATE users SET email_verified = 1, verification_token = NULL, verified_at = ? WHERE id = ?',
    [new Date().toISOString(), user.id]
  );

  return res.send('<html><body><h1>Email Verified</h1><p>Your account has been verified. You can now log in.</p><p><a href="/login">Go to login</a></p></body></html>');
});

app.post('/api/password-reset/request', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    return res.status(404).json({ message: 'No account was found with that email address.' });
  }

  await sendPasswordResetEmail(user);

  return res.json({
    message: 'If an account exists for that email, a password reset link has been sent.'
  });
});

app.post('/api/password-reset/confirm', async (req, res) => {
  const { token, password } = req.body || {};
  const resetToken = String(token ?? '').trim();
  const trimmedPassword = String(password ?? '');

  if (!resetToken || trimmedPassword.length < 6) {
    return res.status(400).json({ message: 'A valid reset token and a password with at least 6 characters are required.' });
  }

  const user = await db.get(
    'SELECT * FROM users WHERE reset_token = ? AND reset_expires_at IS NOT NULL',
    [resetToken]
  );

  if (!user) {
    return res.status(400).json({ message: 'This password reset link is invalid or has expired.' });
  }

  const expiresAt = new Date(user.reset_expires_at).getTime();
  if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
    await db.run('UPDATE users SET reset_token = NULL, reset_expires_at = NULL WHERE id = ?', [user.id]);
    return res.status(400).json({ message: 'This password reset link has expired. Please request a new one.' });
  }

  const passwordHash = await bcrypt.hash(trimmedPassword, 10);
  await db.run(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?',
    [passwordHash, user.id]
  );

  return res.json({ message: 'Your password has been updated successfully.' });
});

app.post('/api/register', async (req, res) => {
  const { firstName, lastName, email, password } = req.body || {};
  const trimmedFirst = String(firstName ?? '').trim();
  const trimmedLast = String(lastName ?? '').trim();
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const trimmedPassword = String(password ?? '');

  if (!trimmedFirst || !trimmedLast || !normalizedEmail || trimmedPassword.length < 6) {
    return res.status(400).json({ message: 'First name, last name, email, and a password with at least 6 characters are required.' });
  }

  const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existingUser) {
    return res.status(409).json({ message: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(trimmedPassword, 10);
  const result = await db.run(
    'INSERT INTO users (first_name, last_name, email, password_hash, team_ids, email_verified, verification_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [trimmedFirst, trimmedLast, normalizedEmail, passwordHash, JSON.stringify([]), 0, null, new Date().toISOString()]
  );

  const user = await db.get('SELECT id, first_name, last_name, email, team_ids, email_verified FROM users WHERE id = ?', [result.id]);
  const verificationUrl = await sendVerificationEmail(user);

  return res.status(201).json({
    message: 'Registration successful. Check your email to verify your account before logging in.',
    verificationUrl,
    user: {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      emailVerified: Number(user.email_verified) === 1,
      teamIds: parseUserTeamIds(user.team_ids)
    }
  });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const trimmedPassword = String(password ?? '');

  if (!normalizedEmail || !trimmedPassword) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const passwordMatches = await bcrypt.compare(trimmedPassword, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  if (Number(user.email_verified) !== 1) {
    return res.status(403).json({ message: 'Please verify your email before logging in. Check your inbox for a verification link.' });
  }

  req.session.userId = user.id;

  return res.json({
    user: {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      emailVerified: true,
      teamIds: parseUserTeamIds(user.team_ids)
    }
  });
});

app.post('/api/resend-verification', async (req, res) => {
  const normalizedEmail = String(req.body?.email ?? '').trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user) {
    return res.status(404).json({ message: 'No account was found with that email address.' });
  }

  if (Number(user.email_verified) === 1) {
    return res.status(409).json({ message: 'This account is already verified. You can log in.' });
  }

  await sendVerificationEmail(user);

  return res.json({ message: 'Verification email resent. Please check your inbox.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ message: 'Unable to log out.' });
    }

    return res.json({ success: true });
  });
});

app.get('/', (req, res) => {
  res.redirect(req.session?.userId ? '/teams' : '/login');
});

app.get('/login', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

app.get('/forgot-password', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html'));
});

app.get('/roster', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.redirect(`/t${DEFAULT_TEAM_ID}/roster`);
});

app.get('/t:teamId/roster', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'roster.html'));
});

app.get('/games', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.redirect(`/t${DEFAULT_TEAM_ID}/games`);
});

app.get('/t:teamId/games', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'games.html'));
});

app.get('/new-game', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.redirect(`/t${DEFAULT_TEAM_ID}/new-game`);
});

app.get('/t:teamId/new-game', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'new-game.html'));
});

app.get('/teams', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'teams.html'));
});

app.get('/profile', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'profile.html'));
});

app.get('/games/:gameId', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const game = await db.get('SELECT team_id FROM games WHERE id = ?', [resolveGameId(req.params.gameId)]);
  const teamId = game && game.team_id ? game.team_id : DEFAULT_TEAM_ID;
  return res.redirect(`/t${teamId}/games/${req.params.gameId}`);
});

app.get('/t:teamId/games/:gameId', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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
  resolveTeamId,
  summarizeActivityRows,
  getPlayerSummary,
  getCumulativePlayerSeconds,
  getActivitySummaryMap,
  getCumulativeSummaryMap,
  startServer
};
