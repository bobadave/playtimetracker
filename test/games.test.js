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

test('every game-management endpoint requires authentication', async () => {
  const fetchAs = authedFetch(null);

  assert.equal((await fetchAs('/api/games')).status, 401);
  assert.equal((await fetchAs('/api/games', { method: 'POST', body: JSON.stringify({ location: 'X', date: '2026-01-01', team_id: 1 }) })).status, 401);
  assert.equal((await fetchAs('/api/games/1', { method: 'PUT', body: JSON.stringify({}) })).status, 401);
  assert.equal((await fetchAs('/api/games/1/archive', { method: 'PUT', body: JSON.stringify({ archived: true }) })).status, 401);
  assert.equal((await fetchAs('/api/games/unarchive', { method: 'PUT', body: JSON.stringify({ teamId: 1 }) })).status, 401);
  assert.equal((await fetchAs('/api/game/1')).status, 401);
});

test('creating a game requires location and a valid date, and requires access to the target team', async () => {
  const owner = await registerAndLogIn('GameCreatorOwner');
  const outsider = await registerAndLogIn('GameCreatorOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Game Creator Team');

  const missingLocation = await ownerFetch('/api/games', {
    method: 'POST',
    body: JSON.stringify({ location: '', date: '2026-09-06', team_id: team.id })
  });
  assert.equal(missingLocation.status, 400);

  const badDate = await ownerFetch('/api/games', {
    method: 'POST',
    body: JSON.stringify({ location: 'Field', date: 'not-a-date', team_id: team.id })
  });
  assert.equal(badDate.status, 400);

  const outsiderCreate = await outsiderFetch('/api/games', {
    method: 'POST',
    body: JSON.stringify({ location: 'Field', date: '2026-09-06', team_id: team.id })
  });
  assert.equal(outsiderCreate.status, 403);

  const created = await ownerFetch('/api/games', {
    method: 'POST',
    body: JSON.stringify({ location: 'Field', date: '2026-09-06', team_id: team.id })
  });
  assert.equal(created.status, 201);
  const { game } = await created.json();
  assert.equal(game.name, 'Soccer Match', 'an unspecified name should default to "Soccer Match"');
  assert.equal(Number(game.is_active), 1);
  assert.equal(game.start_time, null);
});

test('the games list is scoped to the caller\'s teams and the archived filter works', async () => {
  const owner = await registerAndLogIn('GamesListOwner');
  const outsider = await registerAndLogIn('GamesListOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Games List Team');

  const activeGame = await createGame(ownerFetch, team.id, 'Active Field');
  const archivedGame = await createGame(ownerFetch, team.id, 'Archived Field');
  await ownerFetch(`/api/games/${archivedGame.id}/archive`, { method: 'PUT', body: JSON.stringify({ archived: true }) });

  const defaultList = await (await ownerFetch(`/api/games?teamId=${team.id}`)).json();
  const defaultIds = defaultList.games.map((g) => g.id);
  assert.ok(defaultIds.includes(activeGame.id));
  assert.ok(!defaultIds.includes(archivedGame.id));

  const archivedList = await (await ownerFetch(`/api/games?teamId=${team.id}&archived=true`)).json();
  assert.ok(archivedList.games.map((g) => g.id).includes(archivedGame.id));

  // No teamId param falls back to "every team the caller belongs to."
  const allMyGames = await (await ownerFetch('/api/games')).json();
  assert.ok(allMyGames.games.map((g) => g.id).includes(activeGame.id));

  const outsiderScoped = await outsiderFetch(`/api/games?teamId=${team.id}`);
  assert.equal(outsiderScoped.status, 403);

  const outsiderUnscoped = await (await outsiderFetch('/api/games')).json();
  assert.ok(!outsiderUnscoped.games.map((g) => g.id).includes(activeGame.id), 'a user with no teams in common must not see another team\'s games');
});

test('editing a game validates its fields, requires team access, and closing it out via edit ends active players\' segments', async () => {
  const owner = await registerAndLogIn('GameEditOwner');
  const outsider = await registerAndLogIn('GameEditOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Game Edit Team');
  const player = await createPlayer(ownerFetch, team.id, 'Edit', 'Player');
  const game = await createGame(ownerFetch, team.id, 'Edit Field');

  await putOnField(ownerFetch, player.id, game.id);

  const missingFields = await ownerFetch(`/api/games/${game.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: '', location: 'Field', date: '2026-09-06', isActive: true })
  });
  assert.equal(missingFields.status, 400);

  const missingIsActive = await ownerFetch(`/api/games/${game.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Game', location: 'Field', date: '2026-09-06' })
  });
  assert.equal(missingIsActive.status, 400);

  const outsiderEdit = await outsiderFetch(`/api/games/${game.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Hijacked', location: 'Field', date: '2026-09-06', isActive: true })
  });
  assert.equal(outsiderEdit.status, 403);

  const endViaEdit = await ownerFetch(`/api/games/${game.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Edited Name', location: 'New Location', date: '2026-09-07', isActive: false })
  });
  assert.equal(endViaEdit.status, 200);
  const { game: updatedGame } = await endViaEdit.json();
  assert.equal(updatedGame.name, 'Edited Name');
  assert.equal(Number(updatedGame.is_active), 0);

  const playersAfter = await (await ownerFetch(`/api/players/${game.id}?teamId=${team.id}`)).json();
  const playerStatus = playersAfter.find((p) => p.id === player.id);
  assert.equal(playerStatus.inStage, false, 'ending a game via the edit endpoint must close out active players, not just flip is_active');
});

test('archiving and unarchiving a single game, and bulk-unarchiving a team\'s archived games', async () => {
  const owner = await registerAndLogIn('ArchiveOwner');
  const otherOwner = await registerAndLogIn('ArchiveOtherOwner');
  const ownerFetch = authedFetch(owner.cookie);
  const otherFetch = authedFetch(otherOwner.cookie);
  const teamA = await createTeam(ownerFetch, 'Archive Team A');
  const teamB = await createTeam(otherFetch, 'Archive Team B');

  const gameA1 = await createGame(ownerFetch, teamA.id, 'A Field 1');
  const gameA2 = await createGame(ownerFetch, teamA.id, 'A Field 2');
  const gameB1 = await createGame(otherFetch, teamB.id, 'B Field 1');

  for (const game of [gameA1, gameA2, gameB1]) {
    const fetchAs = game === gameB1 ? otherFetch : ownerFetch;
    const archiveResponse = await fetchAs(`/api/games/${game.id}/archive`, {
      method: 'PUT',
      body: JSON.stringify({ archived: true })
    });
    assert.equal(archiveResponse.status, 200);
  }

  const bulkUnarchive = await ownerFetch('/api/games/unarchive', {
    method: 'PUT',
    body: JSON.stringify({ teamId: teamA.id })
  });
  assert.equal(bulkUnarchive.status, 200);
  const { updated } = await bulkUnarchive.json();
  assert.equal(updated, 2);

  const teamAArchived = await (await ownerFetch(`/api/games?teamId=${teamA.id}&archived=true`)).json();
  assert.equal(teamAArchived.games.length, 0);

  const teamBArchived = await (await otherFetch(`/api/games?teamId=${teamB.id}&archived=true`)).json();
  assert.equal(teamBArchived.games.length, 1, 'bulk-unarchiving team A must not touch team B\'s archived games');

  const outsiderArchiveAttempt = await ownerFetch(`/api/games/${gameB1.id}/archive`, {
    method: 'PUT',
    body: JSON.stringify({ archived: false })
  });
  assert.equal(outsiderArchiveAttempt.status, 403);
});
