const express = require('express');
const db = require('../db');
const { getSessionUserId } = require('../lib/session');
const { userHasTeamAccess } = require('../lib/teams');
const { resolveGameId } = require('../lib/gameTime');
const { PLAYER_ACTION_TYPES } = require('../lib/goals');

const router = express.Router();

router.post('/api/player-actions', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { playerId, gameId, action } = req.body || {};
  const resolvedPlayerId = Number(playerId);

  if (!Number.isFinite(resolvedPlayerId) || resolvedPlayerId <= 0) {
    return res.status(400).json({ message: 'A valid playerId is required.' });
  }

  if (!PLAYER_ACTION_TYPES.has(action)) {
    return res.status(400).json({ message: 'A valid action is required.' });
  }

  const resolvedGameId = resolveGameId(gameId);
  const player = await db.get('SELECT * FROM players WHERE id = ? AND archive = 0', [resolvedPlayerId]);
  if (!player) {
    return res.status(404).json({ message: 'Player not found or archived.' });
  }

  const game = await db.get('SELECT * FROM games WHERE id = ?', [resolvedGameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const lastActivity = await db.get(
    'SELECT * FROM player_activity WHERE game_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1',
    [resolvedGameId, resolvedPlayerId]
  );

  if (!lastActivity || Number(lastActivity.in_play) !== 1) {
    return res.status(409).json({ message: 'Player must be on the field to log this action.' });
  }

  const timestamp = new Date().toISOString();
  const result = await db.run(
    'INSERT INTO player_action (game_id, player_id, action, timestamp) VALUES (?, ?, ?, ?)',
    [resolvedGameId, resolvedPlayerId, action, timestamp]
  );

  const goalCountRow = await db.get(
    "SELECT COUNT(*) AS total FROM player_action WHERE game_id = ? AND player_id = ? AND action = 'goal'",
    [resolvedGameId, resolvedPlayerId]
  );

  return res.status(201).json({
    playerAction: {
      id: result.id,
      gameId: resolvedGameId,
      playerId: resolvedPlayerId,
      action,
      timestamp
    },
    goalCount: Number(goalCountRow.total)
  });
});

router.delete('/api/player-actions', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { playerId, gameId, action } = req.query || {};
  const resolvedPlayerId = Number(playerId);

  if (!Number.isFinite(resolvedPlayerId) || resolvedPlayerId <= 0) {
    return res.status(400).json({ message: 'A valid playerId is required.' });
  }

  if (!PLAYER_ACTION_TYPES.has(action)) {
    return res.status(400).json({ message: 'A valid action is required.' });
  }

  const resolvedGameId = resolveGameId(gameId);
  const player = await db.get('SELECT * FROM players WHERE id = ? AND archive = 0', [resolvedPlayerId]);
  if (!player) {
    return res.status(404).json({ message: 'Player not found or archived.' });
  }

  const game = await db.get('SELECT * FROM games WHERE id = ?', [resolvedGameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const lastAction = await db.get(
    'SELECT * FROM player_action WHERE game_id = ? AND player_id = ? AND action = ? ORDER BY id DESC LIMIT 1',
    [resolvedGameId, resolvedPlayerId, action]
  );

  if (!lastAction) {
    return res.status(404).json({ message: 'No matching action found to remove.' });
  }

  await db.run('DELETE FROM player_action WHERE id = ?', [lastAction.id]);

  const goalCountRow = await db.get(
    "SELECT COUNT(*) AS total FROM player_action WHERE game_id = ? AND player_id = ? AND action = 'goal'",
    [resolvedGameId, resolvedPlayerId]
  );

  return res.json({ goalCount: Number(goalCountRow.total) });
});

module.exports = router;
