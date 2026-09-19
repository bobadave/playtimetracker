const db = require('../db');
const { DEFAULT_GAME_ID } = require('../config');

const QUARTER_TIME_LIMIT_MS = 10 * 60 * 1000;
const TOTAL_QUARTERS = 4;

function resolveGameId(gameId) {
  const parsed = Number(gameId ?? DEFAULT_GAME_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GAME_ID;
}

// Closes out every player currently marked in_play for this game, at the given
// timestamp. Used both when a quarter ends (timeout or manual) and when the game is
// merely paused mid-quarter (where the timestamp is just "now" — nothing to cap).
async function closeOutActivePlayers(gameId, closeOutTimestamp) {
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
        [gameId, player_id, 0, closeOutTimestamp]
      );
    }
  }
}

// The still-open (end_time IS NULL) game_quarter row for a game's current quarter, if
// that quarter has actually started (i.e. someone has been clocked in during it).
async function getOpenQuarter(gameId, quarterNumber) {
  return db.get(
    'SELECT * FROM game_quarter WHERE game_id = ? AND quarter_number = ? AND end_time IS NULL',
    [gameId, quarterNumber]
  );
}

async function getQuarterRows(gameId) {
  return db.all(
    'SELECT * FROM game_quarter WHERE game_id = ? ORDER BY quarter_number ASC',
    [gameId]
  );
}

function isQuarterTimedOut(quarterStartTime) {
  if (!quarterStartTime) {
    return false;
  }

  const startMs = new Date(quarterStartTime).getTime();
  return Number.isFinite(startMs) && Date.now() - startMs > QUARTER_TIME_LIMIT_MS;
}

function isGameFinished(game) {
  return !!(game && game.finished_at);
}

// Ends whichever quarter is currently open (if any) and advances the game to the next
// one — used both when the 10-minute limit is detected as elapsed and when a coach
// manually ends the quarter early via the "End Quarter" button. Recorded play time is
// capped at the quarter's own 10-minute boundary even if this runs long after that
// boundary passed (nobody loaded the page in time); ending early naturally never hits
// that cap since "now" is always before the boundary in that case.
async function endCurrentQuarter(game) {
  const nowMs = Date.now();
  const openQuarter = await getOpenQuarter(game.id, game.current_quarter);

  const startMs = openQuarter ? new Date(openQuarter.start_time).getTime() : NaN;
  const boundaryMs = Number.isFinite(startMs) ? startMs + QUARTER_TIME_LIMIT_MS : nowMs;
  const endTimestamp = new Date(Math.min(nowMs, boundaryMs)).toISOString();

  await closeOutActivePlayers(game.id, endTimestamp);

  if (openQuarter) {
    await db.run('UPDATE game_quarter SET end_time = ? WHERE id = ?', [endTimestamp, openQuarter.id]);
  }

  const isLastQuarter = Number(game.current_quarter) >= TOTAL_QUARTERS;
  const nextQuarter = isLastQuarter ? game.current_quarter : Number(game.current_quarter) + 1;
  const finishedAt = isLastQuarter ? endTimestamp : null;

  await db.run(
    'UPDATE games SET is_active = 0, current_quarter = ?, finished_at = ? WHERE id = ?',
    [nextQuarter, finishedAt, game.id]
  );

  return { ...game, is_active: 0, current_quarter: nextQuarter, finished_at: finishedAt };
}

async function enforceQuarterTimeLimit(game) {
  if (!game || isGameFinished(game) || Number(game.is_active) !== 1) {
    return game;
  }

  const openQuarter = await getOpenQuarter(game.id, game.current_quarter);
  if (!openQuarter || !isQuarterTimedOut(openQuarter.start_time)) {
    return game;
  }

  return endCurrentQuarter(game);
}

module.exports = {
  QUARTER_TIME_LIMIT_MS,
  TOTAL_QUARTERS,
  resolveGameId,
  closeOutActivePlayers,
  getOpenQuarter,
  getQuarterRows,
  isQuarterTimedOut,
  isGameFinished,
  endCurrentQuarter,
  enforceQuarterTimeLimit
};
