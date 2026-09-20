const express = require('express');
const db = require('../db');
const { DEFAULT_GAME_ID, DEFAULT_TEAM_ID } = require('../config');
const { getSessionUserId } = require('../lib/session');
const { resolveTeamId, userHasTeamAccess } = require('../lib/teams');
const { resolveGameId, enforceQuarterTimeLimit } = require('../lib/gameTime');
const { getActivitySummaryMap, getCumulativeSummaryMap, getGamesPlayedCountMap } = require('../lib/activity');
const { getGoalCountMap, getCumulativeGoalMap } = require('../lib/goals');

const router = express.Router();

router.get('/api/players', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = DEFAULT_GAME_ID;
  const includeArchived = req.query.includeArchived === 'true';
  const teamId = resolveTeamId(req.query.teamId ?? DEFAULT_TEAM_ID);

  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const players = await db.all(
    includeArchived
      ? 'SELECT * FROM players WHERE team_id = ? ORDER BY id ASC'
      : 'SELECT * FROM players WHERE team_id = ? AND archive = 0 ORDER BY id ASC',
    [teamId]
  );

  const gameSummaryMap = await getActivitySummaryMap(gameId);
  const cumulativeMap = await getCumulativeSummaryMap();
  const cumulativeGoalMap = await getCumulativeGoalMap();
  const gamesPlayedMap = await getGamesPlayedCountMap();

  const payload = players.map((player) => {
    const summary = gameSummaryMap[String(player.id)] || { totalSeconds: 0, isInStage: false };
    const cumulativeSeconds = cumulativeMap[String(player.id)] || 0;
    const cumulativeGoals = cumulativeGoalMap[String(player.id)] || 0;
    const gamesPlayed = gamesPlayedMap[String(player.id)] || 0;
    // Average is over games the player actually appeared in, not every game the team
    // has played — a game they sat out entirely shouldn't drag this number down.
    const averageSecondsPerGame = gamesPlayed > 0 ? cumulativeSeconds / gamesPlayed : 0;

    return {
      id: player.id,
      firstName: player.first_name,
      lastName: player.last_name,
      archive: Number(player.archive) === 1,
      fullName: `${player.first_name} ${player.last_name}`,
      inStage: summary.isInStage,
      totalSeconds: summary.totalSeconds,
      cumulativeSeconds,
      cumulativeGoals,
      gamesPlayed,
      averageSecondsPerGame,
      totalMinutes: summary.totalSeconds / 60,
      cumulativeMinutes: cumulativeSeconds / 60,
      averageMinutesPerGame: averageSecondsPerGame / 60
    };
  });

  res.json(payload);
});

router.post('/api/players', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { firstName, lastName, teamId } = req.body || {};
  const trimmedFirst = String(firstName ?? '').trim();
  const trimmedLast = String(lastName ?? '').trim();
  const resolvedTeamId = resolveTeamId(teamId ?? DEFAULT_TEAM_ID);

  if (!trimmedFirst || !trimmedLast) {
    return res.status(400).json({ message: 'First name and last name are required.' });
  }

  if (!(await userHasTeamAccess(currentUserId, resolvedTeamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const result = await db.run(
    'INSERT INTO players (first_name, last_name, archive, team_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [trimmedFirst, trimmedLast, 0, resolvedTeamId, new Date().toISOString()]
  );

  const player = await db.get('SELECT * FROM players WHERE id = ?', [result.id]);
  return res.status(201).json({ player });
});

router.put('/api/players/unarchive', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamId = resolveTeamId(req.body?.teamId ?? DEFAULT_TEAM_ID);
  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const result = await db.run('UPDATE players SET archive = 0 WHERE archive = 1 AND team_id = ?', [teamId]);
  return res.json({ updated: result.changes });
});

router.put('/api/players/:id', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const playerId = Number(req.params.id);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    return res.status(400).json({ message: 'A valid player ID is required.' });
  }

  const existingPlayer = await db.get('SELECT team_id FROM players WHERE id = ?', [playerId]);
  if (!existingPlayer) {
    return res.status(404).json({ message: 'Player not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, existingPlayer.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
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

router.get('/api/players/:gameId', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  const teamId = resolveTeamId(req.query.teamId ?? DEFAULT_TEAM_ID);
  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  await enforceQuarterTimeLimit(game);

  const players = await db.all('SELECT * FROM players WHERE team_id = ? AND archive = 0 ORDER BY id ASC', [teamId]);

  const gameSummaryMap = await getActivitySummaryMap(gameId);
  const goalCountMap = await getGoalCountMap(gameId);

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
      totalMinutes: summary.totalSeconds / 60,
      goals: goalCountMap[String(player.id)] || 0
    };
  });

  res.json(payload);
});

module.exports = router;
