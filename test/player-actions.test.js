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
  takeOffField,
  logGoal,
  removeLastGoal
} = require('./helpers');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

test('POST /api/player-actions requires authentication, a valid playerId, and a recognized action', async () => {
  const unauthed = await authedFetch(null)('/api/player-actions', {
    method: 'POST',
    body: JSON.stringify({ playerId: 1, gameId: 1, action: 'goal' })
  });
  assert.equal(unauthed.status, 401);

  const { cookie } = await registerAndLogIn('PlayerActionValidation');
  const fetchAs = authedFetch(cookie);

  const missingPlayerId = await fetchAs('/api/player-actions', {
    method: 'POST',
    body: JSON.stringify({ gameId: 1, action: 'goal' })
  });
  assert.equal(missingPlayerId.status, 400);

  const unrecognizedAction = await fetchAs('/api/player-actions', {
    method: 'POST',
    body: JSON.stringify({ playerId: 1, gameId: 1, action: 'assist' })
  });
  assert.equal(unrecognizedAction.status, 400);
});

test('logging a goal for an unknown or archived player is rejected with 404', async () => {
  const { cookie } = await registerAndLogIn('PlayerActionPlayerCheck');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Player Action Player Team');
  const game = await createGame(fetchAs, team.id, 'Field');
  const player = await createPlayer(fetchAs, team.id, 'Archived', 'Player');
  await fetchAs(`/api/players/${player.id}`, { method: 'PUT', body: JSON.stringify({ archive: true }) });

  const unknownPlayer = await logGoal(fetchAs, 999999, game.id);
  assert.equal(unknownPlayer.status, 404);

  const archivedPlayer = await logGoal(fetchAs, player.id, game.id);
  assert.equal(archivedPlayer.status, 404);
});

test('logging a goal on an unknown game is 404, and on a game the caller lacks access to is 403', async () => {
  const owner = await registerAndLogIn('PlayerActionGameOwner');
  const outsider = await registerAndLogIn('PlayerActionGameOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Player Action Game Team');
  const player = await createPlayer(ownerFetch, team.id, 'Player', 'One');
  const game = await createGame(ownerFetch, team.id, 'Field');
  await putOnField(ownerFetch, player.id, game.id);

  const unknownGame = await logGoal(ownerFetch, player.id, 999999);
  assert.equal(unknownGame.status, 404);

  const noAccessGame = await logGoal(outsiderFetch, player.id, game.id);
  assert.equal(noAccessGame.status, 403);
});

test('a goal can only be logged while the player is on the field', async () => {
  const { cookie } = await registerAndLogIn('PlayerActionOnFieldCheck');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'On Field Check Team');
  const player = await createPlayer(fetchAs, team.id, 'Bench', 'Player');
  const game = await createGame(fetchAs, team.id, 'Field');

  const whileBenched = await logGoal(fetchAs, player.id, game.id);
  assert.equal(whileBenched.status, 409);

  await putOnField(fetchAs, player.id, game.id);
  const whileOnField = await logGoal(fetchAs, player.id, game.id);
  assert.equal(whileOnField.status, 201);

  await takeOffField(fetchAs, player.id, game.id);
  const afterBenched = await logGoal(fetchAs, player.id, game.id);
  assert.equal(afterBenched.status, 409);
});

test('goals accumulate per player per game and show up in the players list', async () => {
  const { cookie } = await registerAndLogIn('PlayerActionCount');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Goal Count Team');
  const scorer = await createPlayer(fetchAs, team.id, 'Scorer', 'One');
  const otherPlayer = await createPlayer(fetchAs, team.id, 'NoGoals', 'Player');
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');

  await putOnField(fetchAs, scorer.id, gameA.id);
  await putOnField(fetchAs, scorer.id, gameB.id);
  await putOnField(fetchAs, otherPlayer.id, gameA.id);

  const firstGoal = await logGoal(fetchAs, scorer.id, gameA.id);
  const firstGoalJson = await firstGoal.json();
  assert.equal(firstGoalJson.goalCount, 1);

  const secondGoal = await logGoal(fetchAs, scorer.id, gameA.id);
  const secondGoalJson = await secondGoal.json();
  assert.equal(secondGoalJson.goalCount, 2);

  const goalInOtherGame = await logGoal(fetchAs, scorer.id, gameB.id);
  const goalInOtherGameJson = await goalInOtherGame.json();
  assert.equal(goalInOtherGameJson.goalCount, 1, 'goal counts are scoped per game');

  const playersInGameA = await (await fetchAs(`/api/players/${gameA.id}?teamId=${team.id}`)).json();
  assert.equal(playersInGameA.find((p) => p.id === scorer.id).goals, 2);
  assert.equal(playersInGameA.find((p) => p.id === otherPlayer.id).goals, 0);
});

test('a goal scored in one game does not show up when viewing another game', async () => {
  const { cookie } = await registerAndLogIn('PlayerActionCrossGame');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Cross Game Team');
  const scorer = await createPlayer(fetchAs, team.id, 'Scorer', 'Two');
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');

  await putOnField(fetchAs, scorer.id, gameA.id);
  await logGoal(fetchAs, scorer.id, gameA.id);
  await logGoal(fetchAs, scorer.id, gameA.id);

  await putOnField(fetchAs, scorer.id, gameB.id);

  const playersInGameA = await (await fetchAs(`/api/players/${gameA.id}?teamId=${team.id}`)).json();
  assert.equal(playersInGameA.find((p) => p.id === scorer.id).goals, 2);

  const playersInGameB = await (await fetchAs(`/api/players/${gameB.id}?teamId=${team.id}`)).json();
  assert.equal(playersInGameB.find((p) => p.id === scorer.id).goals, 0, "gameB's view should not see gameA's goals");
});

test('DELETE /api/player-actions requires authentication, a valid playerId, and a recognized action', async () => {
  const unauthed = await authedFetch(null)('/api/player-actions?playerId=1&gameId=1&action=goal', {
    method: 'DELETE'
  });
  assert.equal(unauthed.status, 401);

  const { cookie } = await registerAndLogIn('RemoveGoalValidation');
  const fetchAs = authedFetch(cookie);

  const missingPlayerId = await fetchAs('/api/player-actions?gameId=1&action=goal', { method: 'DELETE' });
  assert.equal(missingPlayerId.status, 400);

  const unrecognizedAction = await fetchAs('/api/player-actions?playerId=1&gameId=1&action=assist', { method: 'DELETE' });
  assert.equal(unrecognizedAction.status, 400);
});

test('removing a goal for an unknown or archived player, or a game the caller lacks access to, is rejected', async () => {
  const owner = await registerAndLogIn('RemoveGoalOwner');
  const outsider = await registerAndLogIn('RemoveGoalOutsider');
  const ownerFetch = authedFetch(owner.cookie);
  const outsiderFetch = authedFetch(outsider.cookie);
  const team = await createTeam(ownerFetch, 'Remove Goal Team');
  const player = await createPlayer(ownerFetch, team.id, 'Player', 'One');
  const game = await createGame(ownerFetch, team.id, 'Field');
  await putOnField(ownerFetch, player.id, game.id);
  await logGoal(ownerFetch, player.id, game.id);

  const unknownPlayer = await removeLastGoal(ownerFetch, 999999, game.id);
  assert.equal(unknownPlayer.status, 404);

  const noAccessGame = await removeLastGoal(outsiderFetch, player.id, game.id);
  assert.equal(noAccessGame.status, 403);

  await ownerFetch(`/api/players/${player.id}`, { method: 'PUT', body: JSON.stringify({ archive: true }) });
  const archivedPlayer = await removeLastGoal(ownerFetch, player.id, game.id);
  assert.equal(archivedPlayer.status, 404);
});

test('removing a goal with none recorded returns 404, and repeated removals decrement then run out', async () => {
  const { cookie } = await registerAndLogIn('RemoveGoalCount');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Remove Goal Count Team');
  const player = await createPlayer(fetchAs, team.id, 'Scorer', 'Three');
  const game = await createGame(fetchAs, team.id, 'Field');
  await putOnField(fetchAs, player.id, game.id);

  const removeWithNone = await removeLastGoal(fetchAs, player.id, game.id);
  assert.equal(removeWithNone.status, 404);

  await logGoal(fetchAs, player.id, game.id);
  await logGoal(fetchAs, player.id, game.id);

  const firstRemoval = await removeLastGoal(fetchAs, player.id, game.id);
  const firstRemovalJson = await firstRemoval.json();
  assert.equal(firstRemoval.status, 200);
  assert.equal(firstRemovalJson.goalCount, 1);

  const secondRemoval = await removeLastGoal(fetchAs, player.id, game.id);
  const secondRemovalJson = await secondRemoval.json();
  assert.equal(secondRemovalJson.goalCount, 0);

  const thirdRemoval = await removeLastGoal(fetchAs, player.id, game.id);
  assert.equal(thirdRemoval.status, 404, 'nothing left to remove once the count reaches zero');

  const players = await (await fetchAs(`/api/players/${game.id}?teamId=${team.id}`)).json();
  assert.equal(players.find((p) => p.id === player.id).goals, 0);
});

test('removing a goal only affects the targeted game, leaving other games untouched', async () => {
  const { cookie } = await registerAndLogIn('RemoveGoalCrossGame');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Remove Goal Cross Game Team');
  const player = await createPlayer(fetchAs, team.id, 'Scorer', 'Four');
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');

  await putOnField(fetchAs, player.id, gameA.id);
  await logGoal(fetchAs, player.id, gameA.id);

  await putOnField(fetchAs, player.id, gameB.id);
  await logGoal(fetchAs, player.id, gameB.id);
  await logGoal(fetchAs, player.id, gameB.id);

  await removeLastGoal(fetchAs, player.id, gameB.id);

  const playersInGameA = await (await fetchAs(`/api/players/${gameA.id}?teamId=${team.id}`)).json();
  assert.equal(playersInGameA.find((p) => p.id === player.id).goals, 1, "removing from gameB shouldn't touch gameA");

  const playersInGameB = await (await fetchAs(`/api/players/${gameB.id}?teamId=${team.id}`)).json();
  assert.equal(playersInGameB.find((p) => p.id === player.id).goals, 1);
});

test('the roster endpoint reports cumulativeGoals summed across every one of a player\'s games', async () => {
  const { cookie } = await registerAndLogIn('RosterGoalsTotal');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Roster Goals Team');
  const scorer = await createPlayer(fetchAs, team.id, 'Roster', 'Scorer');
  const nonScorer = await createPlayer(fetchAs, team.id, 'No', 'Goals');
  const gameA = await createGame(fetchAs, team.id, 'Roster Field A');
  const gameB = await createGame(fetchAs, team.id, 'Roster Field B');

  await putOnField(fetchAs, scorer.id, gameA.id);
  await logGoal(fetchAs, scorer.id, gameA.id);
  await logGoal(fetchAs, scorer.id, gameA.id);

  await putOnField(fetchAs, scorer.id, gameB.id);
  await logGoal(fetchAs, scorer.id, gameB.id);

  const roster = await (await fetchAs(`/api/players?teamId=${team.id}`)).json();
  assert.equal(roster.find((p) => p.id === scorer.id).cumulativeGoals, 3, 'cumulativeGoals should sum goals from every game, not just the default game');
  assert.equal(roster.find((p) => p.id === nonScorer.id).cumulativeGoals, 0);
});

test('the roster endpoint excludes goals scored in archived games from cumulativeGoals, matching cumulativeSeconds behavior', async () => {
  const { cookie } = await registerAndLogIn('RosterGoalsArchived');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Roster Goals Archived Team');
  const player = await createPlayer(fetchAs, team.id, 'Archived', 'Scorer');
  const activeGame = await createGame(fetchAs, team.id, 'Active Field');
  const archivedGame = await createGame(fetchAs, team.id, 'Archived Field');

  await putOnField(fetchAs, player.id, activeGame.id);
  await logGoal(fetchAs, player.id, activeGame.id);

  await putOnField(fetchAs, player.id, archivedGame.id);
  await logGoal(fetchAs, player.id, archivedGame.id);
  await logGoal(fetchAs, player.id, archivedGame.id);

  await fetchAs(`/api/games/${archivedGame.id}/archive`, { method: 'PUT', body: JSON.stringify({ archived: true }) });

  const roster = await (await fetchAs(`/api/players?teamId=${team.id}`)).json();
  assert.equal(
    roster.find((p) => p.id === player.id).cumulativeGoals,
    1,
    'goals from an archived game must not count toward the all-time total'
  );
});
