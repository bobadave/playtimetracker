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
  takeOffField
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

test('updating a player with a non-numeric or non-positive id is rejected with 400 before touching the database', async () => {
  const { cookie } = await registerAndLogIn('InvalidPlayerId');
  const fetchAs = authedFetch(cookie);

  for (const id of ['not-a-number', '-1', '0']) {
    const response = await fetchAs(`/api/players/${id}`, { method: 'PUT', body: JSON.stringify({ firstName: 'X' }) });
    assert.equal(response.status, 400, `player id "${id}" should be rejected`);
  }
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

test('the roster endpoint excludes recorded play time from an archived game (cumulativeSeconds/cumulativeMinutes)', async () => {
  const { cookie } = await registerAndLogIn('RosterTimeArchived');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Roster Time Archived Team');
  const player = await createPlayer(fetchAs, team.id, 'Archived', 'Timer');
  const activeGame = await createGame(fetchAs, team.id, 'Active Field');
  const archivedGame = await createGame(fetchAs, team.id, 'Archived Field');

  await putOnField(fetchAs, player.id, activeGame.id);
  await takeOffField(fetchAs, player.id, activeGame.id);
  await putOnField(fetchAs, player.id, archivedGame.id);
  await takeOffField(fetchAs, player.id, archivedGame.id);

  // Rewrite each game's clock-in/clock-out pair to a clean, non-overlapping 100-second
  // window so the cumulative totals below are exact, rather than depending on how fast
  // these HTTP round-trips actually ran (and on how getCumulativeSummaryMap merges rows
  // across games for the same player by timestamp order).
  async function setDeterministicWindow(gameId, offsetMs) {
    const rows = await db.all(
      'SELECT id FROM player_activity WHERE game_id = ? AND player_id = ? ORDER BY id ASC',
      [gameId, player.id]
    );
    const startMs = Date.now() - 4 * 60 * 60 * 1000 + offsetMs;
    await db.run('UPDATE player_activity SET timestamp = ? WHERE id = ?', [new Date(startMs).toISOString(), rows[0].id]);
    await db.run('UPDATE player_activity SET timestamp = ? WHERE id = ?', [new Date(startMs + 100000).toISOString(), rows[1].id]);
  }

  await setDeterministicWindow(activeGame.id, 0);
  await setDeterministicWindow(archivedGame.id, 200000);

  const beforeArchive = await (await fetchAs(`/api/players?teamId=${team.id}`)).json();
  const beforePlayer = beforeArchive.find((p) => p.id === player.id);
  assert.equal(beforePlayer.cumulativeSeconds, 200, 'both games\' 100s segments should count before archiving');

  await fetchAs(`/api/games/${archivedGame.id}/archive`, { method: 'PUT', body: JSON.stringify({ archived: true }) });

  const afterArchive = await (await fetchAs(`/api/players?teamId=${team.id}`)).json();
  const afterPlayer = afterArchive.find((p) => p.id === player.id);
  assert.equal(afterPlayer.cumulativeSeconds, 100, 'only the still-active game\'s 100s should remain once the other game is archived');
  assert.equal(afterPlayer.cumulativeMinutes, afterPlayer.cumulativeSeconds / 60);
});

test('the roster endpoint computes averageSecondsPerGame over games actually played, not every game the team has played', async () => {
  const { cookie } = await registerAndLogIn('RosterAverageTime');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Roster Average Time Team');
  const player = await createPlayer(fetchAs, team.id, 'Average', 'Timer');
  const neverPlayed = await createPlayer(fetchAs, team.id, 'Never', 'Played');

  const gameA = await createGame(fetchAs, team.id, 'Average Field A');
  const gameB = await createGame(fetchAs, team.id, 'Average Field B');
  // The team has this game too, but the player never clocks into it — it must not
  // inflate the denominator (and so must not drag the average down).
  await createGame(fetchAs, team.id, 'Average Field C');
  const archivedGame = await createGame(fetchAs, team.id, 'Average Archived Field');

  await putOnField(fetchAs, player.id, gameA.id);
  await takeOffField(fetchAs, player.id, gameA.id);
  await putOnField(fetchAs, player.id, gameB.id);
  await takeOffField(fetchAs, player.id, gameB.id);
  await putOnField(fetchAs, player.id, archivedGame.id);
  await takeOffField(fetchAs, player.id, archivedGame.id);

  // Rewrite each game's clock-in/out pair to a clean, non-overlapping, deterministic
  // window so the totals below are exact rather than dependent on request timing.
  async function setWindow(gameId, offsetMs, durationMs) {
    const rows = await db.all(
      'SELECT id FROM player_activity WHERE game_id = ? AND player_id = ? ORDER BY id ASC',
      [gameId, player.id]
    );
    const startMs = Date.now() - 6 * 60 * 60 * 1000 + offsetMs;
    await db.run('UPDATE player_activity SET timestamp = ? WHERE id = ?', [new Date(startMs).toISOString(), rows[0].id]);
    await db.run('UPDATE player_activity SET timestamp = ? WHERE id = ?', [new Date(startMs + durationMs).toISOString(), rows[1].id]);
  }

  await setWindow(gameA.id, 0, 100000);
  await setWindow(gameB.id, 200000, 300000);
  await setWindow(archivedGame.id, 600000, 1000000);

  const roster = await (await fetchAs(`/api/players?teamId=${team.id}`)).json();
  const rosterPlayer = roster.find((p) => p.id === player.id);

  assert.equal(rosterPlayer.gamesPlayed, 3, 'gameA, gameB, and the not-yet-archived game all count; the never-played game does not');
  assert.equal(rosterPlayer.cumulativeSeconds, 1400);
  assert.equal(rosterPlayer.averageSecondsPerGame, 1400 / 3);
  assert.equal(rosterPlayer.averageMinutesPerGame, rosterPlayer.averageSecondsPerGame / 60);

  await fetchAs(`/api/games/${archivedGame.id}/archive`, { method: 'PUT', body: JSON.stringify({ archived: true }) });

  const afterGameArchived = await (await fetchAs(`/api/players?teamId=${team.id}`)).json();
  const playerAfterArchive = afterGameArchived.find((p) => p.id === player.id);
  assert.equal(playerAfterArchive.gamesPlayed, 2, 'archiving a game removes it from the denominator too, not just the numerator');
  assert.equal(playerAfterArchive.cumulativeSeconds, 400);
  assert.equal(playerAfterArchive.averageSecondsPerGame, 200);

  const neverPlayedRoster = afterGameArchived.find((p) => p.id === neverPlayed.id);
  assert.equal(neverPlayedRoster.gamesPlayed, 0);
  assert.equal(neverPlayedRoster.averageSecondsPerGame, 0, 'a player with zero games played must be 0, not NaN or Infinity');
});
