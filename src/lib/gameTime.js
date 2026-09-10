const db = require('../db');
const { DEFAULT_GAME_ID } = require('../config');

const GAME_TIME_LIMIT_MS = 60 * 60 * 1000;

function resolveGameId(gameId) {
  const parsed = Number(gameId ?? DEFAULT_GAME_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GAME_ID;
}

async function closeOutActivePlayers(gameId, game) {
  const resolvedGame = game || await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  const startMs = resolvedGame && resolvedGame.start_time ? new Date(resolvedGame.start_time).getTime() : NaN;
  const timeoutBoundaryMs = Number.isFinite(startMs) ? startMs + GAME_TIME_LIMIT_MS : Infinity;
  // Recorded play time must never exceed the game's timeout window, even if the close-out
  // (manual end or auto-enforcement) is processed well after the boundary has passed.
  const closeOutTimestamp = new Date(Math.min(Date.now(), timeoutBoundaryMs)).toISOString();

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

function isGameTimedOut(game) {
  if (!game || !game.start_time) {
    return false;
  }

  const startMs = new Date(game.start_time).getTime();
  return Number.isFinite(startMs) && Date.now() - startMs > GAME_TIME_LIMIT_MS;
}

async function enforceGameTimeLimit(game) {
  if (!game || Number(game.is_active) !== 1 || !isGameTimedOut(game)) {
    return game;
  }

  await closeOutActivePlayers(game.id, game);
  await db.run('UPDATE games SET is_active = 0 WHERE id = ?', [game.id]);

  return { ...game, is_active: 0 };
}

module.exports = {
  GAME_TIME_LIMIT_MS,
  resolveGameId,
  closeOutActivePlayers,
  isGameTimedOut,
  enforceGameTimeLimit
};
