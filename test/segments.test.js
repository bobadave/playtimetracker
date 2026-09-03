const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  registerAndLogIn,
  authedFetch,
  createTeam,
  createPlayer,
  createGame,
  putOnField,
  takeOffField
} = require('./helpers');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

test('POST /api/segments requires authentication and both playerId and a boolean inPlay', async () => {
  const unauthed = await authedFetch(null)('/api/segments', {
    method: 'POST',
    body: JSON.stringify({ playerId: 1, inPlay: true, gameId: 1 })
  });
  assert.equal(unauthed.status, 401);

  const { cookie } = await registerAndLogIn('SegmentValidation');
  const fetchAs = authedFetch(cookie);

  const missingPlayerId = await fetchAs('/api/segments', {
    method: 'POST',
    body: JSON.stringify({ inPlay: true, gameId: 1 })
  });
  assert.equal(missingPlayerId.status, 400);

  const nonBooleanInPlay = await fetchAs('/api/segments', {
    method: 'POST',
    body: JSON.stringify({ playerId: 1, inPlay: 'yes', gameId: 1 })
  });
  assert.equal(nonBooleanInPlay.status, 400);
});

test('clocking in an unknown or archived player is rejected with 404', async () => {
  const { cookie } = await registerAndLogIn('SegmentPlayerCheck');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Segment Player Team');
  const game = await createGame(fetchAs, team.id, 'Field');
  const player = await createPlayer(fetchAs, team.id, 'Archived', 'Player');
  await fetchAs(`/api/players/${player.id}`, { method: 'PUT', body: JSON.stringify({ archive: true }) });

  const unknownPlayer = await putOnField(fetchAs, 999999, game.id);
  assert.equal(unknownPlayer.status, 404);

  const archivedPlayer = await putOnField(fetchAs, player.id, game.id);
  assert.equal(archivedPlayer.status, 404);
});

test('clocking in on an unknown game is 404, and on a game the caller lacks access to is 403', async () => {
  const owner = await registerAndLogIn('SegmentGameOwner');
  const outsider = await registerAndLogIn('SegmentGameOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Segment Game Team');
  const player = await createPlayer(ownerFetch, team.id, 'Player', 'One');
  const game = await createGame(ownerFetch, team.id, 'Field');

  const unknownGame = await putOnField(ownerFetch, player.id, 999999);
  assert.equal(unknownGame.status, 404);

  const noAccessGame = await putOnField(outsiderFetch, player.id, game.id);
  assert.equal(noAccessGame.status, 403);
});

test('a player cannot be clocked in twice in a row, and cannot be clocked out unless already active', async () => {
  const { cookie } = await registerAndLogIn('SegmentStateMachine');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'State Machine Team');
  const player = await createPlayer(fetchAs, team.id, 'Player', 'Two');
  const game = await createGame(fetchAs, team.id, 'Field');

  const clockOutWithoutClockIn = await takeOffField(fetchAs, player.id, game.id);
  assert.equal(clockOutWithoutClockIn.status, 409);

  const firstClockIn = await putOnField(fetchAs, player.id, game.id);
  assert.equal(firstClockIn.status, 201);

  const duplicateClockIn = await putOnField(fetchAs, player.id, game.id);
  assert.equal(duplicateClockIn.status, 409);

  const clockOut = await takeOffField(fetchAs, player.id, game.id);
  assert.equal(clockOut.status, 201);

  const duplicateClockOut = await takeOffField(fetchAs, player.id, game.id);
  assert.equal(duplicateClockOut.status, 409);

  const clockInAgain = await putOnField(fetchAs, player.id, game.id);
  assert.equal(clockInAgain.status, 201, 'a player should be able to re-enter after being clocked out');
});

test('the stage endpoint reflects only players whose latest activity row is in_play, scoped to that game', async () => {
  const { cookie } = await registerAndLogIn('StageEndpoint');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Stage Team');
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');
  const playerOnA = await createPlayer(fetchAs, team.id, 'On', 'FieldA');
  const playerOnB = await createPlayer(fetchAs, team.id, 'On', 'FieldB');

  await putOnField(fetchAs, playerOnA.id, gameA.id);
  await putOnField(fetchAs, playerOnB.id, gameB.id);

  const stageA = await (await fetchAs(`/api/stage/${gameA.id}`)).json();
  assert.deepEqual(stageA.map((p) => p.id), [playerOnA.id]);

  const stageB = await (await fetchAs(`/api/stage/${gameB.id}`)).json();
  assert.deepEqual(stageB.map((p) => p.id), [playerOnB.id]);

  await takeOffField(fetchAs, playerOnA.id, gameA.id);
  const stageAAfter = await (await fetchAs(`/api/stage/${gameA.id}`)).json();
  assert.deepEqual(stageAAfter, []);
});

test('a completed clock-in/clock-out segment is reflected in the player\'s totalSeconds and inStage flips correctly', async () => {
  const { cookie } = await registerAndLogIn('SegmentSummary');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Summary Team');
  const player = await createPlayer(fetchAs, team.id, 'Summary', 'Player');
  const game = await createGame(fetchAs, team.id, 'Field');

  const clockInResponse = await putOnField(fetchAs, player.id, game.id);
  const { summary: inSummary } = await clockInResponse.json();
  assert.equal(inSummary.isInStage, true);

  const players = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.equal(players.find((p) => p.id === player.id).inStage, true);

  const clockOutResponse = await takeOffField(fetchAs, player.id, game.id);
  const { summary: outSummary } = await clockOutResponse.json();
  assert.equal(outSummary.isInStage, false);
  assert.ok(outSummary.totalSeconds >= 0);
});
