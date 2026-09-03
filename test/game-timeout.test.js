const test = require('node:test');
const assert = require('node:assert/strict');

const {
  db,
  startTestServer,
  stopTestServer,
  registerAndLogIn,
  authedFetch,
  createTeam,
  createPlayer,
  createGame,
  putOnField
} = require('./helpers');
// Requiring '../src/server' again here reuses the module already cached (and
// pointed at the isolated test database) by helpers.js above.
const { isGameTimedOut, GAME_TIME_LIMIT_MS } = require('../src/server');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

// Shifts a game's start_time AND every existing player_activity row for that game
// back by the same delta, so the whole session (clock-ins included) is consistently
// simulated as having happened `msAgo` in the past — not just the start_time column.
async function rewindGameStartTime(gameId, msAgo) {
  const game = await db.get('SELECT start_time FROM games WHERE id = ?', [gameId]);
  const currentStartMs = new Date(game.start_time).getTime();
  const newStartMs = Date.now() - msAgo;
  const deltaMs = newStartMs - currentStartMs;

  const rows = await db.all('SELECT id, timestamp FROM player_activity WHERE game_id = ?', [gameId]);
  for (const row of rows) {
    const shifted = new Date(new Date(row.timestamp).getTime() + deltaMs).toISOString();
    await db.run('UPDATE player_activity SET timestamp = ? WHERE id = ?', [shifted, row.id]);
  }

  await db.run('UPDATE games SET start_time = ? WHERE id = ?', [new Date(newStartMs).toISOString(), gameId]);
}

test('isGameTimedOut is a pure function of start_time and the 1 hour limit', () => {
  assert.equal(isGameTimedOut(null), false);
  assert.equal(isGameTimedOut({ start_time: null }), false);
  assert.equal(isGameTimedOut({ start_time: new Date().toISOString() }), false);
  assert.equal(
    isGameTimedOut({ start_time: new Date(Date.now() - (GAME_TIME_LIMIT_MS + 1000)).toISOString() }),
    true
  );
});

test('start_time lifecycle: null on creation, stamped by first player, unchanged by second', async () => {
  const { cookie } = await registerAndLogIn('Lifecycle');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Lifecycle Team');
  const [p1, p2] = await Promise.all([
    createPlayer(fetchAs, team.id, 'P1'),
    createPlayer(fetchAs, team.id, 'P2')
  ]);
  const game = await createGame(fetchAs, team.id, 'Lifecycle Field');

  assert.equal(game.start_time, null);

  const seg1 = await putOnField(fetchAs, p1.id, game.id);
  assert.equal(seg1.status, 201);
  const afterP1 = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.ok(afterP1.game.start_time);
  const firstStartTime = afterP1.game.start_time;

  const seg2 = await putOnField(fetchAs, p2.id, game.id);
  assert.equal(seg2.status, 201);
  const afterP2 = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(afterP2.game.start_time, firstStartTime);
});

test('a game past the 1 hour limit auto-closes active players and cannot accept new players or be resumed', async () => {
  const { cookie } = await registerAndLogIn('Timeout');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Timeout Team');
  const [p1, p2] = await Promise.all([
    createPlayer(fetchAs, team.id, 'P1'),
    createPlayer(fetchAs, team.id, 'P2')
  ]);
  const game = await createGame(fetchAs, team.id, 'Timeout Field');

  await putOnField(fetchAs, p1.id, game.id);
  await putOnField(fetchAs, p2.id, game.id);

  await rewindGameStartTime(game.id, GAME_TIME_LIMIT_MS + 60 * 60 * 1000);

  const afterTimeout = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(Number(afterTimeout.game.is_active), 0);

  const latestRowsPerPlayer = await db.all(
    `SELECT in_play FROM player_activity pa
     WHERE game_id = ? AND id = (
       SELECT MAX(id) FROM player_activity WHERE game_id = pa.game_id AND player_id = pa.player_id
     )`,
    [game.id]
  );
  assert.ok(
    latestRowsPerPlayer.every((row) => Number(row.in_play) === 0),
    'every player\'s latest activity row should be a close-out (in_play = 0)'
  );

  const playersAfter = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.ok(playersAfter.every((player) => player.inStage === false));

  const rejoinResponse = await putOnField(fetchAs, p1.id, game.id);
  assert.equal(rejoinResponse.status, 409);

  const resumeResponse = await fetchAs(`/api/game/${game.id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ isActive: true })
  });
  assert.equal(resumeResponse.status, 409);
});

test('recorded play time is capped at the timeout boundary, even when enforcement runs long after it', async () => {
  const { cookie } = await registerAndLogIn('CapCheck');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Cap Check Team');
  const player = await createPlayer(fetchAs, team.id, 'Capped');
  const game = await createGame(fetchAs, team.id, 'Cap Check Field');

  await putOnField(fetchAs, player.id, game.id);

  // Push start_time so far into the past that "now" (when enforcement runs below)
  // is many hours past the 1 hour boundary — simulating nobody loading the page
  // for a long stretch after the game should have already ended.
  const farPastMs = GAME_TIME_LIMIT_MS + 20 * 60 * 60 * 1000;
  await rewindGameStartTime(game.id, farPastMs);

  await fetchAs(`/api/game/${game.id}`); // triggers enforcement

  const playersAfter = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  const capped = playersAfter.find((p) => p.id === player.id);

  // Recorded time must never exceed the game's 1 hour limit, regardless of how
  // late enforcement actually ran.
  assert.ok(capped.totalSeconds <= GAME_TIME_LIMIT_MS / 1000);
  assert.ok(capped.totalSeconds > GAME_TIME_LIMIT_MS / 1000 - 5, 'should be close to the full hour, not near-zero');
});

test('timing out one game does not affect a sibling game on the same team', async () => {
  const { cookie } = await registerAndLogIn('SiblingIso');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Sibling Team');
  const [p1, p2] = await Promise.all([
    createPlayer(fetchAs, team.id, 'P1'),
    createPlayer(fetchAs, team.id, 'P2')
  ]);
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');

  await putOnField(fetchAs, p1.id, gameA.id);
  await putOnField(fetchAs, p2.id, gameB.id);

  await rewindGameStartTime(gameA.id, GAME_TIME_LIMIT_MS + 60 * 60 * 1000);

  const gameAAfter = await (await fetchAs(`/api/game/${gameA.id}`)).json();
  assert.equal(Number(gameAAfter.game.is_active), 0);

  const gameBAfter = await (await fetchAs(`/api/game/${gameB.id}`)).json();
  assert.equal(Number(gameBAfter.game.is_active), 1);

  const playersInB = await (await fetchAs(`/api/players/${gameB.id}?teamId=${team.id}`)).json();
  const p2InB = playersInB.find((player) => player.id === p2.id);
  assert.equal(p2InB.inStage, true, 'player in the untouched sibling game must remain on the field');

  const gameBActivity = await db.all('SELECT * FROM player_activity WHERE game_id = ? ORDER BY id', [gameB.id]);
  assert.equal(gameBActivity.length, 1, 'no close-out row should have leaked into the sibling game');
  assert.equal(Number(gameBActivity[0].in_play), 1);
});

test('timing out one team\'s game does not affect a different team\'s game or players', async () => {
  const userA = await registerAndLogIn('TeamIsoA');
  const userB = await registerAndLogIn('TeamIsoB');
  const fetchAsA = authedFetch(userA.cookie);
  const fetchAsB = authedFetch(userB.cookie);

  const teamA = await createTeam(fetchAsA, 'Team A');
  const teamB = await createTeam(fetchAsB, 'Team B');
  const playerA = await createPlayer(fetchAsA, teamA.id, 'PlayerA');
  const playerB = await createPlayer(fetchAsB, teamB.id, 'PlayerB');
  const gameA = await createGame(fetchAsA, teamA.id, 'Team A Field');
  const gameB = await createGame(fetchAsB, teamB.id, 'Team B Field');

  await putOnField(fetchAsA, playerA.id, gameA.id);
  await putOnField(fetchAsB, playerB.id, gameB.id);

  await rewindGameStartTime(gameA.id, GAME_TIME_LIMIT_MS + 60 * 60 * 1000);

  const gameAAfter = await (await fetchAsA(`/api/game/${gameA.id}`)).json();
  assert.equal(Number(gameAAfter.game.is_active), 0);

  const gameBAfter = await (await fetchAsB(`/api/game/${gameB.id}`)).json();
  assert.equal(Number(gameBAfter.game.is_active), 1);

  const playersInB = await (await fetchAsB(`/api/players/${gameB.id}?teamId=${teamB.id}`)).json();
  const playerBStatus = playersInB.find((player) => player.id === playerB.id);
  assert.equal(playerBStatus.inStage, true, 'player on a different team must remain unaffected');

  const gameBActivity = await db.all('SELECT * FROM player_activity WHERE game_id = ? ORDER BY id', [gameB.id]);
  assert.equal(gameBActivity.length, 1, 'no close-out row should have leaked across teams');
  assert.equal(Number(gameBActivity[0].in_play), 1);

  const resumeB = await fetchAsB(`/api/game/${gameB.id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ isActive: false })
  });
  assert.equal(resumeB.status, 200, 'the untouched team\'s game keeps its normal, non-timed-out lifecycle');
});
