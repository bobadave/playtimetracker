const express = require('express');
const path = require('path');
const db = require('../db');
const { DEFAULT_TEAM_ID } = require('../config');
const { resolveGameId } = require('../lib/gameTime');
const { resolveTeamId, userHasTeamAccess } = require('../lib/teams');

const router = express.Router();
const publicDir = path.join(__dirname, '..', '..', 'public');

router.get('/', (req, res) => {
  res.redirect(req.session?.userId ? '/teams' : '/login');
});

router.get('/login', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'login.html'));
});

router.get('/register', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'register.html'));
});

router.get('/forgot-password', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'forgot-password.html'));
});

router.get('/reset-password', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'reset-password.html'));
});

router.get('/roster', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.redirect(`/t${DEFAULT_TEAM_ID}/roster`);
});

router.get('/t:teamId/roster', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'roster.html'));
});

router.get('/games', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.redirect(`/t${DEFAULT_TEAM_ID}/games`);
});

router.get('/t:teamId/games', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'games.html'));
});

router.get('/new-game', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.redirect(`/t${DEFAULT_TEAM_ID}/new-game`);
});

router.get('/t:teamId/new-game', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'new-game.html'));
});

router.get('/teams', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.sendFile(path.join(publicDir, 'teams.html'));
});

router.get('/profile', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  return res.sendFile(path.join(publicDir, 'profile.html'));
});

router.get('/games/:gameId', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const game = await db.get('SELECT team_id FROM games WHERE id = ?', [resolveGameId(req.params.gameId)]);
  const teamId = game && game.team_id ? game.team_id : DEFAULT_TEAM_ID;
  return res.redirect(`/t${teamId}/games/${req.params.gameId}`);
});

router.get('/t:teamId/games/:gameId', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/login');
  }

  const teamId = resolveTeamId(req.params.teamId);
  if (!(await userHasTeamAccess(req.session.userId, teamId))) {
    return res.redirect('/teams');
  }

  return res.sendFile(path.join(publicDir, 'index.html'));
});

router.use(express.static(publicDir));

router.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

module.exports = router;
