const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  registerAndLogIn,
  authedFetch,
  createTeam,
  createPlayer
} = require('./helpers');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

test('every player endpoint requires authentication', async () => {
  const fetchAs = authedFetch(null);

  assert.equal((await fetchAs('/api/players')).status, 401);
  assert.equal((await fetchAs('/api/players', { method: 'POST', body: JSON.stringify({ firstName: 'A', lastName: 'B', teamId: 1 }) })).status, 401);
  assert.equal((await fetchAs('/api/players/unarchive', { method: 'PUT', body: JSON.stringify({ teamId: 1 }) })).status, 401);
  assert.equal((await fetchAs('/api/players/1', { method: 'PUT', body: JSON.stringify({ firstName: 'A' }) })).status, 401);
});

test('creating a player requires both names, and requires access to the target team', async () => {
  const owner = await registerAndLogIn('PlayerTeamOwner');
  const outsider = await registerAndLogIn('PlayerOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Player Team');

  const missingLastName = await ownerFetch('/api/players', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'OnlyFirst', lastName: '', teamId: team.id })
  });
  assert.equal(missingLastName.status, 400);

  const outsiderCreate = await outsiderFetch('/api/players', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Sneaky', lastName: 'Player', teamId: team.id })
  });
  assert.equal(outsiderCreate.status, 403, 'a non-member must not be able to create players on someone else\'s team');

  const created = await ownerFetch('/api/players', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Real', lastName: 'Player', teamId: team.id })
  });
  assert.equal(created.status, 201);
});

test('the player list is scoped to the caller\'s team and excludes archived players by default', async () => {
  const owner = await registerAndLogIn('RosterOwner');
  const outsider = await registerAndLogIn('RosterOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Roster Team');

  const active = await createPlayer(ownerFetch, team.id, 'Active', 'Player');
  const archived = await createPlayer(ownerFetch, team.id, 'Archived', 'Player');
  await ownerFetch(`/api/players/${archived.id}`, { method: 'PUT', body: JSON.stringify({ archive: true }) });

  const list = await (await ownerFetch(`/api/players?teamId=${team.id}`)).json();
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes(active.id));
  assert.ok(!ids.includes(archived.id), 'archived players should be excluded by default');

  const withArchived = await (await ownerFetch(`/api/players?teamId=${team.id}&includeArchived=true`)).json();
  assert.ok(withArchived.map((p) => p.id).includes(archived.id));

  const outsiderList = await outsiderFetch(`/api/players?teamId=${team.id}`);
  assert.equal(outsiderList.status, 403);
});

test('updating a player: rename works, archive/unarchive via the single-player endpoint works, empty names are rejected, and cross-team access is blocked', async () => {
  const owner = await registerAndLogIn('EditOwner');
  const outsider = await registerAndLogIn('EditOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Edit Team');
  const player = await createPlayer(ownerFetch, team.id, 'Original', 'Name');

  const renameResponse = await ownerFetch(`/api/players/${player.id}`, {
    method: 'PUT',
    body: JSON.stringify({ firstName: 'Updated', lastName: 'Name' })
  });
  assert.equal(renameResponse.status, 200);
  const { player: renamed } = await renameResponse.json();
  assert.equal(renamed.first_name, 'Updated');

  const emptyNameResponse = await ownerFetch(`/api/players/${player.id}`, {
    method: 'PUT',
    body: JSON.stringify({ firstName: '' })
  });
  assert.equal(emptyNameResponse.status, 400);

  const noChangesResponse = await ownerFetch(`/api/players/${player.id}`, {
    method: 'PUT',
    body: JSON.stringify({})
  });
  assert.equal(noChangesResponse.status, 400);

  const archiveResponse = await ownerFetch(`/api/players/${player.id}`, {
    method: 'PUT',
    body: JSON.stringify({ archive: true })
  });
  assert.equal(archiveResponse.status, 200);
  const { player: archived } = await archiveResponse.json();
  assert.equal(Number(archived.archive), 1);

  const outsiderEdit = await outsiderFetch(`/api/players/${player.id}`, {
    method: 'PUT',
    body: JSON.stringify({ firstName: 'Hijacked' })
  });
  assert.equal(outsiderEdit.status, 403);

  const notFound = await ownerFetch('/api/players/999999', {
    method: 'PUT',
    body: JSON.stringify({ firstName: 'Ghost' })
  });
  assert.equal(notFound.status, 404);
});

test('bulk unarchive only restores archived players on the caller\'s own team, never another team\'s', async () => {
  const owner = await registerAndLogIn('BulkUnarchiveOwner');
  const otherOwner = await registerAndLogIn('BulkUnarchiveOtherOwner');
  const ownerFetch = authedFetch(owner.cookie);
  const otherFetch = authedFetch(otherOwner.cookie);

  const teamA = await createTeam(ownerFetch, 'Bulk Team A');
  const teamB = await createTeam(otherFetch, 'Bulk Team B');

  const playerA = await createPlayer(ownerFetch, teamA.id, 'PlayerA', 'Archived');
  const playerB = await createPlayer(otherFetch, teamB.id, 'PlayerB', 'Archived');
  await ownerFetch(`/api/players/${playerA.id}`, { method: 'PUT', body: JSON.stringify({ archive: true }) });
  await otherFetch(`/api/players/${playerB.id}`, { method: 'PUT', body: JSON.stringify({ archive: true }) });

  const unarchiveResponse = await ownerFetch('/api/players/unarchive', {
    method: 'PUT',
    body: JSON.stringify({ teamId: teamA.id })
  });
  assert.equal(unarchiveResponse.status, 200);

  const teamAList = await (await ownerFetch(`/api/players?teamId=${teamA.id}&includeArchived=true`)).json();
  assert.equal(teamAList.find((p) => p.id === playerA.id).archive, false);

  const teamBList = await (await otherFetch(`/api/players?teamId=${teamB.id}&includeArchived=true`)).json();
  assert.equal(teamBList.find((p) => p.id === playerB.id).archive, true, 'team B\'s archived player must remain archived');

  const outsiderBulkAttempt = await ownerFetch('/api/players/unarchive', {
    method: 'PUT',
    body: JSON.stringify({ teamId: teamB.id })
  });
  assert.equal(outsiderBulkAttempt.status, 403);
});
