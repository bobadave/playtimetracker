const db = require('../db');
const { resolveGameId } = require('./gameTime');

const PLAYER_ACTION_TYPES = new Set(['goal']);

async function getGoalCountMap(gameId) {
  const resolvedGameId = resolveGameId(gameId);
  const rows = await db.all(
    "SELECT player_id, COUNT(*) AS total FROM player_action WHERE game_id = ? AND action = 'goal' GROUP BY player_id",
    [resolvedGameId]
  );

  return Object.fromEntries(rows.map((row) => [String(row.player_id), Number(row.total)]));
}

async function getCumulativeGoalMap() {
  const rows = await db.all(`
    SELECT pa.player_id, COUNT(*) AS total
    FROM player_action pa
    INNER JOIN games g ON g.id = pa.game_id
    WHERE pa.action = 'goal' AND g.archived = 0
    GROUP BY pa.player_id
  `);

  return Object.fromEntries(rows.map((row) => [String(row.player_id), Number(row.total)]));
}

module.exports = {
  PLAYER_ACTION_TYPES,
  getGoalCountMap,
  getCumulativeGoalMap
};
