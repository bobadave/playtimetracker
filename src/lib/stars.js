const db = require('../db');
const { resolveGameId } = require('./gameTime');

const STAR_ACTION_TYPES = ['effort', 'spirit', 'improvement'];

// Per-game totals (SUM of value, not a count) for each star-rated action, scoped to a
// single game — mirrors getGoalCountMap's per-game scoping.
// Returns one player-id -> total map per action type, e.g. { effort: {...}, spirit: {...} }.
async function getStarsCountMaps(gameId) {
  const resolvedGameId = resolveGameId(gameId);
  const rows = await db.all(`
    SELECT player_id, action, SUM(value) AS total
    FROM player_action
    WHERE game_id = ? AND action IN (${STAR_ACTION_TYPES.map(() => '?').join(', ')})
    GROUP BY player_id, action
  `, [resolvedGameId, ...STAR_ACTION_TYPES]);

  const maps = Object.fromEntries(STAR_ACTION_TYPES.map((action) => [action, {}]));
  for (const row of rows) {
    maps[row.action][String(row.player_id)] = Number(row.total);
  }

  return maps;
}

// All-time leaderboard totals (SUM of value, not a count) for each star-rated action,
// scoped to non-archived games — mirrors getCumulativeGoalMap's archived-game exclusion.
// Returns one player-id -> total map per action type, e.g. { effort: {...}, spirit: {...} }.
async function getCumulativeStarsMaps() {
  const rows = await db.all(`
    SELECT pa.player_id, pa.action, SUM(pa.value) AS total
    FROM player_action pa
    INNER JOIN games g ON g.id = pa.game_id
    WHERE pa.action IN (${STAR_ACTION_TYPES.map(() => '?').join(', ')}) AND g.archived = 0
    GROUP BY pa.player_id, pa.action
  `, STAR_ACTION_TYPES);

  const maps = Object.fromEntries(STAR_ACTION_TYPES.map((action) => [action, {}]));
  for (const row of rows) {
    maps[row.action][String(row.player_id)] = Number(row.total);
  }

  return maps;
}

module.exports = {
  STAR_ACTION_TYPES,
  getStarsCountMaps,
  getCumulativeStarsMaps
};
