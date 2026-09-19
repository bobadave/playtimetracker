const express = require('express');
const db = require('../db');
const { DEFAULT_GAME_ID, DEFAULT_TEAM_ID } = require('../config');
const { getSessionUserId } = require('../lib/session');
const { resolveTeamId, userHasTeamAccess, getCurrentUserTeamIds } = require('../lib/teams');
const {
  resolveGameId,
  isGameFinished,
  closeOutActivePlayers,
  enforceQuarterTimeLimit,
  endCurrentQuarter,
  getQuarterRows
} = require('../lib/gameTime');

const router = express.Router();

router.get('/api/game', async (req, res) => {
  const game = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [DEFAULT_GAME_ID]);
  res.json({ game });
});

router.get('/api/game/:gameId', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  const game = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [gameId]);

  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const enforcedGame = await enforceQuarterTimeLimit(game);
  const quarters = await getQuarterRows(gameId);
  res.json({ game: { ...enforcedGame, quarters } });
});

router.get('/api/games', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamIdParam = req.query.teamId;
  const teamId = teamIdParam === undefined ? null : resolveTeamId(teamIdParam);

  if (teamId !== null && !(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const archivedOnly = req.query.archived === 'true';
  const conditions = [`g.archived = ${archivedOnly ? 1 : 0}`];
  const params = [];

  if (teamId !== null) {
    conditions.push('g.team_id = ?');
    params.push(teamId);
  } else {
    const memberTeamIds = await getCurrentUserTeamIds(currentUserId);
    if (memberTeamIds.length === 0) {
      return res.json({ games: [] });
    }
    conditions.push(`g.team_id IN (${memberTeamIds.map(() => '?').join(', ')})`);
    params.push(...memberTeamIds);
  }

  const games = await db.all(
    `
      SELECT g.*, t.team_name AS team_name
      FROM games g
      LEFT JOIN teams t ON t.id = g.team_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY g.id ASC
    `,
    params
  );

  // A quarter can time out without anyone ever loading the game's individual page
  // (which is otherwise what triggers enforcement) — apply the same check here so the
  // list never shows a game as still "Active" once its current quarter has timed out.
  const enforcedGames = [];
  for (const game of games) {
    enforcedGames.push(await enforceQuarterTimeLimit(game));
  }

  return res.json({ games: enforcedGames });
});

router.post('/api/games', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { name, location, month, day, year, date, team_id } = req.body || {};

  const normalizedDate = date || (() => {
    const monthValue = String(month ?? '').padStart(2, '0');
    const dayValue = String(day ?? '').padStart(2, '0');
    const yearValue = String(year ?? '');

    if (!monthValue || !dayValue || !yearValue) {
      return null;
    }

    return `${yearValue}-${monthValue}-${dayValue}`;
  })();

  if (!location || !normalizedDate) {
    return res.status(400).json({ message: 'Location and date are required.' });
  }

  const dateValue = new Date(`${normalizedDate}T00:00:00`);
  if (Number.isNaN(dateValue.getTime())) {
    return res.status(400).json({ message: 'The selected date is invalid.' });
  }

  const gameName = name && String(name).trim() ? String(name).trim() : 'Soccer Match';
  const resolvedTeamId = resolveTeamId(team_id ?? DEFAULT_TEAM_ID);

  if (!(await userHasTeamAccess(currentUserId, resolvedTeamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  // New games start paused (is_active = 0) so a coach can drag players onto the field
  // to set up the lineup without that starting the clock — play only begins once
  // "Game Start" is pressed.
  const result = await db.run(
    'INSERT INTO games (name, created_at, location, date, is_active, team_id) VALUES (?, ?, ?, ?, ?, ?)',
    [gameName, new Date().toISOString(), String(location).trim(), normalizedDate, 0, resolvedTeamId]
  );

  const newGame = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [result.id]);
  return res.status(201).json({ game: newGame });
});

router.put('/api/game/status', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { isActive, gameId } = req.body || {};
  const resolvedGameId = resolveGameId(gameId ?? DEFAULT_GAME_ID);

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive is required.' });
  }

  let game = await db.get('SELECT * FROM games WHERE id = ?', [resolvedGameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  game = await enforceQuarterTimeLimit(game);

  if (isActive && isGameFinished(game)) {
    return res.status(409).json({ message: 'This game has already finished and cannot be resumed.' });
  }

  if (!isActive) {
    // Pausing mid-quarter only stops individual players' clocks — it does not end the
    // quarter itself, so there's no boundary to cap against, just "now".
    await closeOutActivePlayers(resolvedGameId, new Date().toISOString());
  }

  await db.run('UPDATE games SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, resolvedGameId]);
  const updatedGame = await db.get('SELECT * FROM games WHERE id = ?', [resolvedGameId]);
  const quarters = await getQuarterRows(resolvedGameId);

  return res.json({ game: { ...updatedGame, quarters } });
});

router.put('/api/game/:gameId/status', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const { isActive } = req.body || {};
  const gameId = resolveGameId(req.params.gameId);

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive is required.' });
  }

  let game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  game = await enforceQuarterTimeLimit(game);

  if (isActive && isGameFinished(game)) {
    return res.status(409).json({ message: 'This game has already finished and cannot be resumed.' });
  }

  if (!isActive) {
    await closeOutActivePlayers(gameId, new Date().toISOString());
  }

  await db.run('UPDATE games SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, gameId]);
  const updatedGame = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  const quarters = await getQuarterRows(gameId);

  return res.json({ game: { ...updatedGame, quarters } });
});

// Immediately ends whichever quarter is currently in progress, without waiting for its
// 10-minute limit — used by the "End Quarter" button. Shares the exact same
// end-of-quarter logic (close out active players, advance to the next quarter or mark
// the game finished) as automatic timeout enforcement.
router.post('/api/game/:gameId/end-quarter', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  let game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  game = await enforceQuarterTimeLimit(game);

  if (isGameFinished(game)) {
    return res.status(409).json({ message: 'This game has already finished.' });
  }

  if (Number(game.is_active) !== 1) {
    return res.status(409).json({ message: 'No quarter is currently in progress.' });
  }

  const updatedGame = await endCurrentQuarter(game);
  const quarters = await getQuarterRows(gameId);

  return res.json({ game: { ...updatedGame, quarters } });
});

router.put('/api/games/unarchive', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const teamId = resolveTeamId(req.body?.teamId ?? DEFAULT_TEAM_ID);
  if (!(await userHasTeamAccess(currentUserId, teamId))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const result = await db.run(
    'UPDATE games SET archived = 0 WHERE team_id = ? AND archived = 1',
    [teamId]
  );

  return res.json({ updated: result.changes });
});

router.put('/api/games/:gameId', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  let game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const { name, location, date, isActive } = req.body || {};

  const trimmedName = String(name ?? '').trim();
  const trimmedLocation = String(location ?? '').trim();
  const normalizedDate = String(date ?? '').trim();

  if (!trimmedName || !trimmedLocation || !normalizedDate) {
    return res.status(400).json({ message: 'Name, location, and date are required.' });
  }

  const dateValue = new Date(`${normalizedDate}T00:00:00`);
  if (Number.isNaN(dateValue.getTime())) {
    return res.status(400).json({ message: 'The selected date is invalid.' });
  }

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive is required.' });
  }

  game = await enforceQuarterTimeLimit(game);

  if (isActive && isGameFinished(game)) {
    return res.status(409).json({ message: 'This game has already finished and cannot be resumed.' });
  }

  if (!isActive) {
    await closeOutActivePlayers(gameId, new Date().toISOString());
  }

  await db.run(
    'UPDATE games SET name = ?, location = ?, date = ?, is_active = ? WHERE id = ?',
    [trimmedName, trimmedLocation, normalizedDate, isActive ? 1 : 0, gameId]
  );

  const updatedGame = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [gameId]);

  return res.json({ game: updatedGame });
});

router.put('/api/games/:gameId/archive', async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const gameId = resolveGameId(req.params.gameId);
  const game = await db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return res.status(404).json({ message: 'Game not found.' });
  }

  if (!(await userHasTeamAccess(currentUserId, game.team_id))) {
    return res.status(403).json({ message: 'You do not have access to this team.' });
  }

  const { archived } = req.body || {};
  if (typeof archived !== 'boolean') {
    return res.status(400).json({ message: 'archived is required.' });
  }

  await db.run('UPDATE games SET archived = ? WHERE id = ?', [archived ? 1 : 0, gameId]);
  const updatedGame = await db.get(`
    SELECT g.*, t.team_name AS team_name
    FROM games g
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ?
  `, [gameId]);

  return res.json({ game: updatedGame });
});

module.exports = router;
