const test = require('node:test');
const assert = require('node:assert/strict');

const {
  db,
  startTestServer,
  stopTestServer,
  registerAndLogIn,
  authedFetch,
  createTeam
} = require('./helpers');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

test('every team endpoint requires authentication', async () => {
  const fetchAs = authedFetch(null);

  assert.equal((await fetchAs('/api/teams')).status, 401);
  assert.equal((await fetchAs('/api/teams', { method: 'POST', body: JSON.stringify({ teamName: 'X' }) })).status, 401);
  assert.equal((await fetchAs('/api/teams/directory')).status, 401);
  assert.equal((await fetchAs('/api/teams/join', { method: 'POST', body: JSON.stringify({ teamId: 1 }) })).status, 401);
  assert.equal((await fetchAs('/api/teams/1')).status, 401);
  assert.equal((await fetchAs('/api/teams/1', { method: 'PUT', body: JSON.stringify({ teamName: 'X' }) })).status, 401);
  assert.equal((await fetchAs('/api/teams/1/membership', { method: 'DELETE' })).status, 401);
});

test('creating a team requires a name and makes the creator a member; duplicate names are rejected', async () => {
  const { cookie } = await registerAndLogIn('TeamCreator');
  const fetchAs = authedFetch(cookie);

  const missingName = await fetchAs('/api/teams', { method: 'POST', body: JSON.stringify({ teamName: '' }) });
  assert.equal(missingName.status, 400);

  const teamName = `Unique Team ${Date.now()}`;
  const createResponse = await fetchAs('/api/teams', { method: 'POST', body: JSON.stringify({ teamName }) });
  assert.equal(createResponse.status, 201);
  const { team } = await createResponse.json();

  const listResponse = await fetchAs('/api/teams');
  const { teams } = await listResponse.json();
  assert.ok(teams.some((t) => t.id === team.id), 'creator should immediately be a member of the new team');

  const dupeResponse = await fetchAs('/api/teams', { method: 'POST', body: JSON.stringify({ teamName }) });
  assert.equal(dupeResponse.status, 409);
});

test('a user cannot read, rename, or read the membership of a team they do not belong to', async () => {
  const owner = await registerAndLogIn('TeamOwner');
  const outsider = await registerAndLogIn('TeamOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);

  const team = await createTeam(ownerFetch, 'Private Team');

  const readAttempt = await outsiderFetch(`/api/teams/${team.id}`);
  assert.equal(readAttempt.status, 403);

  const renameAttempt = await outsiderFetch(`/api/teams/${team.id}`, {
    method: 'PUT',
    body: JSON.stringify({ teamName: 'Hijacked Name' })
  });
  assert.equal(renameAttempt.status, 403);

  // Confirm the rename attempt did not go through.
  const ownerReadBack = await (await ownerFetch(`/api/teams/${team.id}`)).json();
  assert.equal(ownerReadBack.team.team_name, team.team_name);
});

test('renaming a team to a name already used by another team is rejected with 409', async () => {
  const { cookie } = await registerAndLogIn('TeamRenamer');
  const fetchAs = authedFetch(cookie);

  const teamA = await createTeam(fetchAs, 'Rename Team A');
  const teamB = await createTeam(fetchAs, 'Rename Team B');

  const clash = await fetchAs(`/api/teams/${teamB.id}`, {
    method: 'PUT',
    body: JSON.stringify({ teamName: teamA.team_name })
  });
  assert.equal(clash.status, 409);

  const successfulRename = await fetchAs(`/api/teams/${teamB.id}`, {
    method: 'PUT',
    body: JSON.stringify({ teamName: `Renamed B ${Date.now()}` })
  });
  assert.equal(successfulRename.status, 200);
});

test('team directory only lists teams the current user has not already joined, and join/leave moves teams in and out of it', async () => {
  const creator = await registerAndLogIn('DirectoryCreator');
  const joiner = await registerAndLogIn('DirectoryJoiner');
  const creatorFetch = authedFetch(creator.cookie);
  const joinerFetch = authedFetch(joiner.cookie);

  const team = await createTeam(creatorFetch, 'Joinable Team');

  const directoryBefore = await (await joinerFetch('/api/teams/directory')).json();
  assert.ok(directoryBefore.teams.some((t) => t.id === team.id));

  const joinResponse = await joinerFetch('/api/teams/join', {
    method: 'POST',
    body: JSON.stringify({ teamId: team.id })
  });
  assert.equal(joinResponse.status, 201);

  const directoryAfterJoin = await (await joinerFetch('/api/teams/directory')).json();
  assert.ok(!directoryAfterJoin.teams.some((t) => t.id === team.id), 'a joined team should drop out of the directory');

  const alreadyMemberJoin = await joinerFetch('/api/teams/join', {
    method: 'POST',
    body: JSON.stringify({ teamId: team.id })
  });
  assert.equal(alreadyMemberJoin.status, 409);

  const unknownTeamJoin = await joinerFetch('/api/teams/join', {
    method: 'POST',
    body: JSON.stringify({ teamId: 999999 })
  });
  assert.equal(unknownTeamJoin.status, 404);

  const canReadAfterJoin = await joinerFetch(`/api/teams/${team.id}`);
  assert.equal(canReadAfterJoin.status, 200);

  const leaveResponse = await joinerFetch(`/api/teams/${team.id}/membership`, { method: 'DELETE' });
  assert.equal(leaveResponse.status, 200);

  const readAfterLeave = await joinerFetch(`/api/teams/${team.id}`);
  assert.equal(readAfterLeave.status, 403, 'access should be revoked immediately after leaving');

  const directoryAfterLeave = await (await joinerFetch('/api/teams/directory')).json();
  assert.ok(directoryAfterLeave.teams.some((t) => t.id === team.id), 'leaving should put the team back in the directory');

  // The team itself must still exist — leaving only removes the user's own membership.
  const stillExists = await creatorFetch(`/api/teams/${team.id}`);
  assert.equal(stillExists.status, 200);
});

test('GET /api/teams for a user with zero memberships returns an empty list rather than erroring', async () => {
  const { cookie } = await registerAndLogIn('NoTeamsYet');
  const fetchAs = authedFetch(cookie);

  const response = await fetchAs('/api/teams');
  assert.equal(response.status, 200);
  const { teams } = await response.json();
  assert.deepEqual(teams, []);
});

test('joining a team with a missing or invalid teamId is rejected with 400', async () => {
  const { cookie } = await registerAndLogIn('JoinValidation');
  const fetchAs = authedFetch(cookie);

  for (const body of [{}, { teamId: null }, { teamId: 'not-a-number' }, { teamId: -1 }, { teamId: 0 }]) {
    const response = await fetchAs('/api/teams/join', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400, `teamId ${JSON.stringify(body.teamId)} should be rejected`);
  }
});

test('renaming a team to an empty name is rejected with 400', async () => {
  const { cookie } = await registerAndLogIn('RenameEmptyName');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Rename Empty Team');

  const response = await fetchAs(`/api/teams/${team.id}`, {
    method: 'PUT',
    body: JSON.stringify({ teamName: '   ' })
  });
  assert.equal(response.status, 400);
});

test('leaving a team the caller is not a member of is rejected with 404', async () => {
  const owner = await registerAndLogIn('MembershipOwner');
  const notMember = await registerAndLogIn('MembershipNotMember');
  const ownerFetch = authedFetch(owner.cookie);
  const notMemberFetch = authedFetch(notMember.cookie);
  const team = await createTeam(ownerFetch, 'Membership Team');

  const response = await notMemberFetch(`/api/teams/${team.id}/membership`, { method: 'DELETE' });
  assert.equal(response.status, 404);
});

test('reading a team whose row no longer exists (but is still listed in the caller\'s membership) is 404', async () => {
  // Not reachable through this app's own API in normal operation — every route that
  // removes a team also cleans up membership. Constructed directly to exercise the
  // "member of a team that isn't actually there" branch on its own.
  const { cookie } = await registerAndLogIn('GhostTeamMember');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Ghost Team');

  await db.run('DELETE FROM teams WHERE id = ?', [team.id]);

  const response = await fetchAs(`/api/teams/${team.id}`);
  assert.equal(response.status, 404);
});
