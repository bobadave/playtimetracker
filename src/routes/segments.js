const express = require('express');
const db = require('../db');
const { DEFAULT_GAME_ID } = require('../config');
const { getSessionUserId } = require('../lib/session');
const { userHasTeamAccess } = require('../lib/teams');
const { resolveGameId, enforceGameTimeLimit } = require('../lib/gameTime');
const { getPlayerSummary } = require('../lib/activity');

const router = express.Router();

router.get('/api/stage', async (req, res) => {
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

router.get('/api/stage/:gameId', async (req, res) => {
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

router.post('/api/segments', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { playerId, inPlay, gameId } = req.body;

  if (!playerId || typeof inPlay !== 'boolean') {
    return res.status(400).json({ message: 'playerId and inPlay are required.' });
  }

  const resolvedGameId = resolveGameId(gameId);
  const playerExists = await db.get('SELECT id FROM players WHERE id = ? AND archive = 0', [playerId]);
  if (!playerExists) {
    return res.status(404).json({ message: 'Player not found or archived.' });
  }

  let game = await db.get('SELECT * FROM games WHERE id = ?', [resolvedGameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  game = await enforceGameTimeLimit(game);

  if (inPlay && Number(game.is_active) !== 1) {
    return res.status(409).json({ message: 'This game has ended and can no longer accept players.' });
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

  if (inPlay && !game.start_time) {
    await db.run('UPDATE games SET start_time = ? WHERE id = ?', [timestamp, resolvedGameId]);
  }

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

module.exports = router;
