// Cross-cutting authorization checks. This file exists specifically to catch
// regressions like the one found in this codebase's history: an endpoint
// (POST /api/players) that was missing its session/team-access check entirely.
// Rather than trust each feature file to remember this, every protected
// endpoint is asserted against here in one place, as a matrix.
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

test('every data-bearing API endpoint rejects a request with no session cookie at all', async () => {
  const fetchAs = authedFetch(null);

  const endpoints = [
    ['GET', '/api/game/1'],
    ['GET', '/api/games'],
    ['POST', '/api/games', { location: 'X', date: '2026-01-01', team_id: 1 }],
    ['PUT', '/api/game/status', { isActive: false, gameId: 1 }],
    ['PUT', '/api/game/1/status', { isActive: false }],
    ['PUT', '/api/games/unarchive', { teamId: 1 }],
    ['PUT', '/api/games/1', { name: 'X', location: 'X', date: '2026-01-01', isActive: true }],
    ['PUT', '/api/games/1/archive', { archived: true }],
    ['GET', '/api/players'],
    ['POST', '/api/players', { firstName: 'A', lastName: 'B', teamId: 1 }],
    ['PUT', '/api/players/unarchive', { teamId: 1 }],
    ['PUT', '/api/players/1', { firstName: 'A' }],
    ['GET', '/api/players/1'],
    ['GET', '/api/teams'],
    ['POST', '/api/teams', { teamName: 'X' }],
    ['GET', '/api/teams/directory'],
    ['POST', '/api/teams/join', { teamId: 1 }],
    ['GET', '/api/teams/1'],
    ['PUT', '/api/teams/1', { teamName: 'X' }],
    ['DELETE', '/api/teams/1/membership'],
    ['POST', '/api/segments', { playerId: 1, inPlay: true, gameId: 1 }],
    ['PUT', '/api/profile', { firstName: 'A', lastName: 'B' }],
    ['PUT', '/api/profile/password', { password: 'password123' }]
  ];

  for (const [method, urlPath, body] of endpoints) {
    const response = await fetchAs(urlPath, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.equal(
      response.status,
      401,
      `${method} ${urlPath} should require authentication but returned ${response.status}`
    );
  }
});

test('a user with zero team memberships is refused access to any specific team\'s resources', async () => {
  const owner = await registerAndLogIn('MatrixOwner');
  const teamless = await registerAndLogIn('MatrixTeamless');
  const ownerFetch = authedFetch(owner.cookie);
  const teamlessFetch = authedFetch(teamless.cookie);

  const team = await createTeam(ownerFetch, 'Matrix Team');
  const player = await createPlayer(ownerFetch, team.id, 'Matrix', 'Player');
  const game = await createGame(ownerFetch, team.id, 'Matrix Field');

  assert.equal((await teamlessFetch(`/api/teams/${team.id}`)).status, 403);
  assert.equal((await teamlessFetch(`/api/games?teamId=${team.id}`)).status, 403);
  assert.equal((await teamlessFetch(`/api/players?teamId=${team.id}`)).status, 403);
  assert.equal((await teamlessFetch(`/api/players/${game.id}?teamId=${team.id}`)).status, 403);
  assert.equal((await teamlessFetch(`/api/game/${game.id}`)).status, 403);
  assert.equal(
    (await teamlessFetch('/api/players', { method: 'POST', body: JSON.stringify({ firstName: 'X', lastName: 'Y', teamId: team.id }) })).status,
    403
  );
  assert.equal(
    (await teamlessFetch('/api/games', { method: 'POST', body: JSON.stringify({ location: 'X', date: '2026-01-01', team_id: team.id }) })).status,
    403
  );
  assert.equal(
    (await putOnField(teamlessFetch, player.id, game.id)).status,
    403
  );
});

test('team membership is the only thing that grants access — being a member of a different team is not enough', async () => {
  const teamAOwner = await registerAndLogIn('MatrixTeamAOwner');
  const teamBOwner = await registerAndLogIn('MatrixTeamBOwner');
  const teamAFetch = authedFetch(teamAOwner.cookie);
  const teamBFetch = authedFetch(teamBOwner.cookie);

  const teamA = await createTeam(teamAFetch, 'Matrix Team A');
  await createTeam(teamBFetch, 'Matrix Team B');
  const gameA = await createGame(teamAFetch, teamA.id, 'Team A Field');

  // teamBOwner belongs to a real team, just not this one.
  assert.equal((await teamBFetch(`/api/teams/${teamA.id}`)).status, 403);
  assert.equal((await teamBFetch(`/api/game/${gameA.id}`)).status, 403);
  assert.equal((await teamBFetch(`/api/games?teamId=${teamA.id}`)).status, 403);
});
