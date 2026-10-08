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
  putOnField
} = require('./helpers');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

function setAbsences(fetchAs, gameId, absentPlayerIds) {
  return fetchAs(`/api/game/${gameId}/absences`, {
    method: 'PUT',
    body: JSON.stringify({ absentPlayerIds })
  });
}

test('PUT /api/game/:gameId/absences requires authentication, a known game, and a valid absentPlayerIds array', async () => {
  const unauthed = await authedFetch(null)('/api/game/1/absences', {
    method: 'PUT',
    body: JSON.stringify({ absentPlayerIds: [] })
  });
  assert.equal(unauthed.status, 401);

  const { cookie } = await registerAndLogIn('AttendanceValidation');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Attendance Validation Team');
  const game = await createGame(fetchAs, team.id, 'Field');

  const notAnArray = await setAbsences(fetchAs, game.id, 'not-an-array');
  assert.equal(notAnArray.status, 400);

  const notNumeric = await setAbsences(fetchAs, game.id, ['abc']);
  assert.equal(notNumeric.status, 400);

  const unknownGame = await setAbsences(fetchAs, 999999, []);
  assert.equal(unknownGame.status, 404);
});

test('a game the caller lacks access to is rejected with 403', async () => {
  const owner = await registerAndLogIn('AttendanceOwner');
  const outsider = await registerAndLogIn('AttendanceOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Attendance Access Team');
  const game = await createGame(ownerFetch, team.id, 'Field');

  const response = await setAbsences(outsiderFetch, game.id, []);
  assert.equal(response.status, 403);
});

test('marking a player absent keeps them in the per-game players list, flagged absent, without touching other players', async () => {
  const { cookie } = await registerAndLogIn('AttendanceFlag');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Attendance Flag Team');
  const absentee = await createPlayer(fetchAs, team.id, 'Absent', 'Player');
  const present = await createPlayer(fetchAs, team.id, 'Present', 'Player');
  const game = await createGame(fetchAs, team.id, 'Field');

  const beforeRoster = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.equal(beforeRoster.find((p) => p.id === absentee.id).absent, false, 'nobody starts absent');

  const response = await setAbsences(fetchAs, game.id, [absentee.id]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).absentPlayerIds, [absentee.id]);

  const afterRoster = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.equal(afterRoster.find((p) => p.id === absentee.id).absent, true, 'the marked player is now absent');
  assert.equal(afterRoster.find((p) => p.id === present.id).absent, false, 'an untouched player stays present');
  assert.equal(afterRoster.length, beforeRoster.length, 'absent players stay in the list (flagged), not removed from it');
});

test('re-syncing the absence list replaces it entirely, and re-checking a player clears their absence', async () => {
  const { cookie } = await registerAndLogIn('AttendanceResync');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Attendance Resync Team');
  const playerA = await createPlayer(fetchAs, team.id, 'Player', 'A');
  const playerB = await createPlayer(fetchAs, team.id, 'Player', 'B');
  const game = await createGame(fetchAs, team.id, 'Field');

  await setAbsences(fetchAs, game.id, [playerA.id]);
  let roster = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.equal(roster.find((p) => p.id === playerA.id).absent, true);
  assert.equal(roster.find((p) => p.id === playerB.id).absent, false);

  // Manage Bench always submits the full desired set — this call should fully replace
  // the previous one: A comes back (not submitted as absent), B is now absent.
  await setAbsences(fetchAs, game.id, [playerB.id]);
  roster = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.equal(roster.find((p) => p.id === playerA.id).absent, false, 'A was not resubmitted as absent, so they are back');
  assert.equal(roster.find((p) => p.id === playerB.id).absent, true);
});

test('absence is scoped to one game and does not leak into another game for the same team', async () => {
  const { cookie } = await registerAndLogIn('AttendanceGameScope');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Attendance Game Scope Team');
  const player = await createPlayer(fetchAs, team.id, 'Scoped', 'Player');
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');

  await setAbsences(fetchAs, gameA.id, [player.id]);

  const rosterA = await (await fetchAs(`/api/players/${gameA.id}?teamId=${team.id}`)).json();
  assert.equal(rosterA.find((p) => p.id === player.id).absent, true);

  const rosterB = await (await fetchAs(`/api/players/${gameB.id}?teamId=${team.id}`)).json();
  assert.equal(rosterB.find((p) => p.id === player.id).absent, false, "gameA's absence must not affect gameB");
});

test('marking an on-field player absent closes out their active segment immediately', async () => {
  const { cookie } = await registerAndLogIn('AttendanceCloseOut');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Attendance Close Out Team');
  const player = await createPlayer(fetchAs, team.id, 'OnField', 'Player');
  const game = await createGame(fetchAs, team.id, 'Field');

  await putOnField(fetchAs, player.id, game.id);
  const whileOnField = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.equal(whileOnField.find((p) => p.id === player.id).inStage, true);

  await setAbsences(fetchAs, game.id, [player.id]);

  const afterAbsent = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  const absentPlayer = afterAbsent.find((p) => p.id === player.id);
  assert.equal(absentPlayer.absent, true);
  assert.equal(absentPlayer.inStage, false, 'being marked absent clocks the player off the field');
});

test('a player id from another team is ignored rather than recorded', async () => {
  const { cookie } = await registerAndLogIn('AttendanceCrossTeam');
  const fetchAs = authedFetch(cookie);
  const teamA = await createTeam(fetchAs, 'Attendance Cross Team A');
  const teamB = await createTeam(fetchAs, 'Attendance Cross Team B');
  const playerA = await createPlayer(fetchAs, teamA.id, 'Team', 'A');
  const playerB = await createPlayer(fetchAs, teamB.id, 'Team', 'B');
  const gameA = await createGame(fetchAs, teamA.id, 'Field A');

  const response = await setAbsences(fetchAs, gameA.id, [playerA.id, playerB.id]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).absentPlayerIds, [playerA.id], "team B's player id is silently dropped, not recorded");
});
