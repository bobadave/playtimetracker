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
  putOnField,
  rewindQuarterStartTime
} = require('./helpers');
// Requiring '../src/server' again here reuses the module already cached (and
// pointed at the isolated test database) by helpers.js above.
const { isQuarterTimedOut, QUARTER_TIME_LIMIT_MS } = require('../src/server');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

function endQuarter(fetchAs, gameId) {
  return fetchAs(`/api/game/${gameId}/end-quarter`, { method: 'POST' });
}

test('isQuarterTimedOut is a pure function of a quarter start_time and the 10 minute limit', () => {
  assert.equal(isQuarterTimedOut(null), false);
  assert.equal(isQuarterTimedOut(undefined), false);
  assert.equal(isQuarterTimedOut(new Date().toISOString()), false);
  assert.equal(
    isQuarterTimedOut(new Date(Date.now() - (QUARTER_TIME_LIMIT_MS + 1000)).toISOString()),
    true
  );
});

test('quarter lifecycle: no open quarter on creation, opened by the first player, unchanged by the second', async () => {
  const { cookie } = await registerAndLogIn('QuarterLifecycle');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Quarter Lifecycle Team');
  const [p1, p2] = await Promise.all([
    createPlayer(fetchAs, team.id, 'P1'),
    createPlayer(fetchAs, team.id, 'P2')
  ]);
  const game = await createGame(fetchAs, team.id, 'Lifecycle Field');

  const beforeAnyPlayer = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(beforeAnyPlayer.game.current_quarter, 1);
  assert.equal(beforeAnyPlayer.game.quarters.length, 0, 'no game_quarter row should exist until someone is clocked in');

  const seg1 = await putOnField(fetchAs, p1.id, game.id);
  assert.equal(seg1.status, 201);
  const afterP1 = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(afterP1.game.quarters.length, 1);
  const [quarter1] = afterP1.game.quarters;
  assert.equal(quarter1.quarter_number, 1);
  assert.ok(quarter1.start_time);
  assert.equal(quarter1.end_time, null);

  const seg2 = await putOnField(fetchAs, p2.id, game.id);
  assert.equal(seg2.status, 201);
  const afterP2 = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(afterP2.game.quarters.length, 1, 'a second clock-in in the same quarter must not open a second row');
  assert.equal(afterP2.game.quarters[0].start_time, quarter1.start_time);
});

test('a quarter past its 10 minute limit auto-closes active players and advances the game to the next quarter', async () => {
  const { cookie } = await registerAndLogIn('QuarterTimeout');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Quarter Timeout Team');
  const [p1, p2] = await Promise.all([
    createPlayer(fetchAs, team.id, 'P1'),
    createPlayer(fetchAs, team.id, 'P2')
  ]);
  const game = await createGame(fetchAs, team.id, 'Timeout Field');

  await putOnField(fetchAs, p1.id, game.id);
  await putOnField(fetchAs, p2.id, game.id);

  await rewindQuarterStartTime(game.id, 1, QUARTER_TIME_LIMIT_MS + 60 * 1000);

  const afterTimeout = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(Number(afterTimeout.game.is_active), 0);
  assert.equal(afterTimeout.game.current_quarter, 2, 'the game should have advanced to quarter 2');
  assert.equal(afterTimeout.game.finished_at, null, 'quarter 1 ending is not the end of the game');
  assert.ok(afterTimeout.game.quarters[0].end_time, 'quarter 1 should now be closed out');

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

  const rejoinBeforeQuarterStart = await putOnField(fetchAs, p1.id, game.id);
  assert.equal(rejoinBeforeQuarterStart.status, 409, 'quarter 2 has not been started yet');

  const startQuarter2 = await fetchAs(`/api/game/${game.id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ isActive: true })
  });
  assert.equal(startQuarter2.status, 200, 'unlike a fully finished game, advancing to the next quarter can be started');

  const rejoinAfterQuarterStart = await putOnField(fetchAs, p1.id, game.id);
  assert.equal(rejoinAfterQuarterStart.status, 201);

  const gameAfterRejoin = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(gameAfterRejoin.game.quarters.length, 2);
  assert.equal(gameAfterRejoin.game.quarters[1].quarter_number, 2);
  assert.equal(gameAfterRejoin.game.quarters[1].end_time, null);
});

test('recorded play time is capped at the quarter boundary, even when enforcement runs long after it', async () => {
  const { cookie } = await registerAndLogIn('CapCheck');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Cap Check Team');
  const player = await createPlayer(fetchAs, team.id, 'Capped');
  const game = await createGame(fetchAs, team.id, 'Cap Check Field');

  await putOnField(fetchAs, player.id, game.id);

  // Push the quarter's start_time so far into the past that "now" (when enforcement
  // runs below) is many hours past the 10-minute boundary — simulating nobody loading
  // the page for a long stretch after the quarter should have already ended.
  const farPastMs = QUARTER_TIME_LIMIT_MS + 20 * 60 * 60 * 1000;
  await rewindQuarterStartTime(game.id, 1, farPastMs);

  await fetchAs(`/api/game/${game.id}`); // triggers enforcement

  const playersAfter = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  const capped = playersAfter.find((p) => p.id === player.id);

  // Recorded time must never exceed the quarter's 10-minute limit, regardless of how
  // late enforcement actually ran.
  assert.ok(capped.totalSeconds <= QUARTER_TIME_LIMIT_MS / 1000);
  assert.ok(capped.totalSeconds > QUARTER_TIME_LIMIT_MS / 1000 - 5, 'should be close to the full 10 minutes, not near-zero');
});

test('timing out one game\'s quarter does not affect a sibling game on the same team', async () => {
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

  await rewindQuarterStartTime(gameA.id, 1, QUARTER_TIME_LIMIT_MS + 60 * 1000);

  const gameAAfter = await (await fetchAs(`/api/game/${gameA.id}`)).json();
  assert.equal(Number(gameAAfter.game.is_active), 0);
  assert.equal(gameAAfter.game.current_quarter, 2);

  const gameBAfter = await (await fetchAs(`/api/game/${gameB.id}`)).json();
  assert.equal(Number(gameBAfter.game.is_active), 1);
  assert.equal(gameBAfter.game.current_quarter, 1);

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

  await rewindQuarterStartTime(gameA.id, 1, QUARTER_TIME_LIMIT_MS + 60 * 1000);

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

  const pauseB = await fetchAsB(`/api/game/${gameB.id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ isActive: false })
  });
  assert.equal(pauseB.status, 200, 'the untouched team\'s game keeps its normal, non-timed-out lifecycle');
});

test('POST /api/game/:gameId/end-quarter requires auth, team access, and an in-progress quarter', async () => {
  const owner = await registerAndLogIn('EndQuarterOwner');
  const outsider = await registerAndLogIn('EndQuarterOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'End Quarter Team');
  const player = await createPlayer(ownerFetch, team.id, 'Player', 'One');

  // Created via the raw endpoint (not the createGame test helper, which activates the
  // game for the convenience of every other test) so it starts genuinely paused.
  const created = await ownerFetch('/api/games', {
    method: 'POST',
    body: JSON.stringify({ location: 'End Quarter Field', date: '2026-09-19', team_id: team.id })
  });
  const { game } = await created.json();

  const unauthed = await authedFetch(null)(`/api/game/${game.id}/end-quarter`, { method: 'POST' });
  assert.equal(unauthed.status, 401);

  const unknownGame = await endQuarter(ownerFetch, 999999);
  assert.equal(unknownGame.status, 404);

  const noAccess = await endQuarter(outsiderFetch, game.id);
  assert.equal(noAccess.status, 403);

  const notInProgress = await endQuarter(ownerFetch, game.id);
  assert.equal(notInProgress.status, 409, 'the game was just created paused — no quarter is in progress yet');

  await ownerFetch(`/api/game/${game.id}/status`, { method: 'PUT', body: JSON.stringify({ isActive: true }) });

  const endedWithNoOneOnField = await endQuarter(ownerFetch, game.id);
  assert.equal(endedWithNoOneOnField.status, 200, 'a started-but-empty quarter can still be ended (nothing to close out)');
  assert.equal((await endedWithNoOneOnField.json()).game.current_quarter, 2);

  await ownerFetch(`/api/game/${game.id}/status`, { method: 'PUT', body: JSON.stringify({ isActive: true }) });
  await putOnField(ownerFetch, player.id, game.id);

  const ended = await endQuarter(ownerFetch, game.id);
  assert.equal(ended.status, 200);
  const { game: endedGame } = await ended.json();
  assert.equal(Number(endedGame.is_active), 0);
  assert.equal(endedGame.current_quarter, 3);
  assert.equal(endedGame.quarters.length, 1, 'the empty quarter 1 never opened a row; only quarter 2 (which had a player) did');
  assert.equal(endedGame.quarters[0].quarter_number, 2);
  assert.ok(endedGame.quarters[0].end_time);
});

test('ending a quarter early does not cap it at the full 10 minutes', async () => {
  const { cookie } = await registerAndLogIn('EndQuarterEarly');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'End Quarter Early Team');
  const player = await createPlayer(fetchAs, team.id, 'Early', 'Ender');
  const game = await createGame(fetchAs, team.id, 'Early Field');

  await putOnField(fetchAs, player.id, game.id);
  await endQuarter(fetchAs, game.id);

  const players = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  const played = players.find((p) => p.id === player.id);
  assert.ok(played.totalSeconds < 5, 'ending immediately after clocking in should record only a few seconds, not 10 minutes');
});

test('a game progresses through all 4 quarters and finishes after the 4th, at which point it cannot be resumed', async () => {
  const { cookie } = await registerAndLogIn('FullGame');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Full Game Team');
  const player = await createPlayer(fetchAs, team.id, 'Full', 'Timer');
  const game = await createGame(fetchAs, team.id, 'Full Game Field');

  for (let quarter = 1; quarter <= 4; quarter += 1) {
    const startResponse = await fetchAs(`/api/game/${game.id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ isActive: true })
    });
    assert.equal(startResponse.status, 200, `quarter ${quarter} should be startable`);

    await putOnField(fetchAs, player.id, game.id);

    const endResponse = await endQuarter(fetchAs, game.id);
    assert.equal(endResponse.status, 200);
    const { game: endedGame } = await endResponse.json();

    if (quarter < 4) {
      assert.equal(endedGame.current_quarter, quarter + 1);
      assert.equal(endedGame.finished_at, null);
    } else {
      assert.equal(endedGame.current_quarter, 4, 'current_quarter does not advance past the last quarter');
      assert.ok(endedGame.finished_at, 'the game should be marked finished after quarter 4 ends');
    }
  }

  const resumeAfterFinish = await fetchAs(`/api/game/${game.id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ isActive: true })
  });
  assert.equal(resumeAfterFinish.status, 409);

  const clockInAfterFinish = await putOnField(fetchAs, player.id, game.id);
  assert.equal(clockInAfterFinish.status, 409);

  const endQuarterAfterFinish = await endQuarter(fetchAs, game.id);
  assert.equal(endQuarterAfterFinish.status, 409);

  const finalGame = await (await fetchAs(`/api/game/${game.id}`)).json();
  assert.equal(finalGame.game.quarters.length, 4);
  assert.ok(finalGame.game.quarters.every((q) => q.end_time), 'every quarter should be closed out');
});
