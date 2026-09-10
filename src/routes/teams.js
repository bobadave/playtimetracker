const express = require('express');
const db = require('../db');
const { getSessionUserId } = require('../lib/session');
const {
  resolveTeamId,
  userHasTeamAccess,
  getCurrentUserTeamIds,
  syncUserTeamMembership,
  removeUserTeamMembership
} = require('../lib/teams');

const router = express.Router();

router.get('/api/teams', async (req, res) => {
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

router.post('/api/teams', async (req, res) => {
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

router.get('/api/teams/directory', async (req, res) => {
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

router.post('/api/teams/join', async (req, res) => {
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

router.get('/api/teams/:teamId', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamId = resolveTeamId(req.params.teamId);

  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);

  if (!team) {
    return res.status(404).json({ message: 'Team not found.' });
  }

  return res.json({ team });
});

router.put('/api/teams/:teamId', async (req, res) => {
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

router.delete('/api/teams/:teamId/membership', async (req, res) => {
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

module.exports = router;
