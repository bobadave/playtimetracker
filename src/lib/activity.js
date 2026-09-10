const db = require('../db');
const { resolveGameId } = require('./gameTime');

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

module.exports = {
  summarizeActivityRows,
  getPlayerSummary,
  getCumulativePlayerSeconds,
  getActivitySummaryMap,
  getCumulativeSummaryMap
};
