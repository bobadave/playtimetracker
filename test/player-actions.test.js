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
  takeOffField,
  logGoal,
  removeLastGoal,
  logStars,
  removeAllStars
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

  const unknownGame = await removeLastGoal(ownerFetch, player.id, 999999);
  assert.equal(unknownGame.status, 404);

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

test('effort, spirit, and improvement stars can be logged with a 1-5 value, whether the player is on the field or benched', async () => {
  const { cookie } = await registerAndLogIn('PlayerActionStars');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Stars Team');
  const player = await createPlayer(fetchAs, team.id, 'Stars', 'Player');
  const game = await createGame(fetchAs, team.id, 'Field');

  const whileBenched = await logStars(fetchAs, player.id, game.id, 'effort', 1);
  assert.equal(whileBenched.status, 201, 'unlike goals, stars can be logged for a benched player');

  await putOnField(fetchAs, player.id, game.id);

  const effortResponse = await logStars(fetchAs, player.id, game.id, 'effort', 4);
  assert.equal(effortResponse.status, 201);
  const effortJson = await effortResponse.json();
  assert.equal(effortJson.playerAction.action, 'effort');
  assert.equal(effortJson.playerAction.value, 4);
  assert.equal(effortJson.goalCount, null, 'goalCount is only meaningful for goal actions');

  const spiritResponse = await logStars(fetchAs, player.id, game.id, 'spirit', 2);
  assert.equal(spiritResponse.status, 201);
  assert.equal((await spiritResponse.json()).playerAction.action, 'spirit');

  const improvementResponse = await logStars(fetchAs, player.id, game.id, 'improvement', 5);
  assert.equal(improvementResponse.status, 201);
  assert.equal((await improvementResponse.json()).playerAction.value, 5);
});

test('a missing value defaults to 1, and an out-of-range or non-integer value is rejected with 400', async () => {
  const { cookie } = await registerAndLogIn('PlayerActionStarsValidation');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Stars Validation Team');
  const player = await createPlayer(fetchAs, team.id, 'Stars', 'Validator');
  const game = await createGame(fetchAs, team.id, 'Field');
  await putOnField(fetchAs, player.id, game.id);

  const missingValue = await fetchAs('/api/player-actions', {
    method: 'POST',
    body: JSON.stringify({ playerId: player.id, gameId: game.id, action: 'effort' })
  });
  assert.equal(missingValue.status, 201);
  assert.equal((await missingValue.json()).playerAction.value, 1, 'value defaults to 1 when omitted');

  const zeroValue = await logStars(fetchAs, player.id, game.id, 'effort', 0);
  assert.equal(zeroValue.status, 400);

  const tooHighValue = await logStars(fetchAs, player.id, game.id, 'effort', 6);
  assert.equal(tooHighValue.status, 400);

  const nonIntegerValue = await logStars(fetchAs, player.id, game.id, 'effort', 2.5);
  assert.equal(nonIntegerValue.status, 400);
});

test('the roster endpoint sums effort, spirit, and improvement values across games, excluding archived games', async () => {
  const { cookie } = await registerAndLogIn('RosterStarsTotal');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Roster Stars Team');
  const player = await createPlayer(fetchAs, team.id, 'Roster', 'Stars');
  const activeGame = await createGame(fetchAs, team.id, 'Active Field');
  const archivedGame = await createGame(fetchAs, team.id, 'Archived Field');

  await putOnField(fetchAs, player.id, activeGame.id);
  await logStars(fetchAs, player.id, activeGame.id, 'effort', 3);
  await logStars(fetchAs, player.id, activeGame.id, 'effort', 2);
  await logStars(fetchAs, player.id, activeGame.id, 'spirit', 5);
  await logStars(fetchAs, player.id, activeGame.id, 'improvement', 1);

  await putOnField(fetchAs, player.id, archivedGame.id);
  await logStars(fetchAs, player.id, archivedGame.id, 'effort', 4);
  await fetchAs(`/api/games/${archivedGame.id}/archive`, { method: 'PUT', body: JSON.stringify({ archived: true }) });

  const roster = await (await fetchAs(`/api/players?teamId=${team.id}`)).json();
  const rosterPlayer = roster.find((p) => p.id === player.id);
  assert.equal(rosterPlayer.cumulativeEffort, 5, 'effort from the archived game must not count');
  assert.equal(rosterPlayer.cumulativeSpirit, 5);
  assert.equal(rosterPlayer.cumulativeImprovement, 1);
});

test('the per-game players endpoint reports effort, spirit, and improvement scoped to that game only', async () => {
  const { cookie } = await registerAndLogIn('PerGameStarsTally');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Per Game Stars Team');
  const scorer = await createPlayer(fetchAs, team.id, 'Tally', 'Player');
  const untouched = await createPlayer(fetchAs, team.id, 'No', 'Stars');
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');

  await putOnField(fetchAs, scorer.id, gameA.id);
  await logStars(fetchAs, scorer.id, gameA.id, 'effort', 3);
  await logStars(fetchAs, scorer.id, gameA.id, 'effort', 2);
  await logStars(fetchAs, scorer.id, gameA.id, 'spirit', 4);

  await putOnField(fetchAs, scorer.id, gameB.id);
  await logStars(fetchAs, scorer.id, gameB.id, 'improvement', 5);

  const playersInGameA = await (await fetchAs(`/api/players/${gameA.id}?teamId=${team.id}`)).json();
  const scorerInGameA = playersInGameA.find((p) => p.id === scorer.id);
  assert.equal(scorerInGameA.effort, 5, 'effort sums to 5 (3 + 2) within gameA only');
  assert.equal(scorerInGameA.spirit, 4);
  assert.equal(scorerInGameA.improvement, 0, "gameB's improvement stars must not leak into gameA");
  assert.equal(playersInGameA.find((p) => p.id === untouched.id).effort, 0);

  const playersInGameB = await (await fetchAs(`/api/players/${gameB.id}?teamId=${team.id}`)).json();
  const scorerInGameB = playersInGameB.find((p) => p.id === scorer.id);
  assert.equal(scorerInGameB.improvement, 5);
  assert.equal(scorerInGameB.effort, 0, "gameA's effort stars must not leak into gameB");
});

test('deleting all stars for a game+player+classification only removes that exact combination', async () => {
  const { cookie } = await registerAndLogIn('DeleteAllStarsScope');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Delete All Stars Team');
  const playerA = await createPlayer(fetchAs, team.id, 'Player', 'A');
  const playerB = await createPlayer(fetchAs, team.id, 'Player', 'B');
  const gameA = await createGame(fetchAs, team.id, 'Field A');
  const gameB = await createGame(fetchAs, team.id, 'Field B');

  // The exact combination being deleted: two effort entries for playerA in gameA.
  await logStars(fetchAs, playerA.id, gameA.id, 'effort', 3);
  await logStars(fetchAs, playerA.id, gameA.id, 'effort', 2);

  // Same player + same game, but a DIFFERENT classification — must survive.
  await logStars(fetchAs, playerA.id, gameA.id, 'spirit', 4);

  // Same player + same classification, but a DIFFERENT game — must survive.
  await logStars(fetchAs, playerA.id, gameB.id, 'effort', 5);

  // Same game + same classification, but a DIFFERENT player — must survive.
  await logStars(fetchAs, playerB.id, gameA.id, 'effort', 1);

  const deleteResponse = await removeAllStars(fetchAs, playerA.id, gameA.id, 'effort');
  assert.equal(deleteResponse.status, 200);
  const deleteJson = await deleteResponse.json();
  assert.equal(deleteJson.deletedCount, 2, 'only the two matching rows for playerA/gameA/effort were deleted');

  // Direct row-level check: exactly the targeted rows are gone, nothing else touched.
  // Scoped to this test's own players/games — the table is shared across the whole
  // suite, so an unscoped query would also see unrelated rows from other tests.
  const remainingRows = await db.all(
    `SELECT game_id, player_id, action, value FROM player_action
     WHERE action IN (?, ?) AND player_id IN (?, ?) AND game_id IN (?, ?)
     ORDER BY game_id, player_id, action, value`,
    ['effort', 'spirit', playerA.id, playerB.id, gameA.id, gameB.id]
  );
  assert.deepEqual(remainingRows, [
    { game_id: gameA.id, player_id: playerA.id, action: 'spirit', value: 4 },
    { game_id: gameA.id, player_id: playerB.id, action: 'effort', value: 1 },
    { game_id: gameB.id, player_id: playerA.id, action: 'effort', value: 5 }
  ]);

  // API-level check mirrors the same expectations via the endpoint the UI actually reads.
  const playersInGameA = await (await fetchAs(`/api/players/${gameA.id}?teamId=${team.id}`)).json();
  assert.equal(playersInGameA.find((p) => p.id === playerA.id).effort, 0, "playerA's effort in gameA is gone");
  assert.equal(playersInGameA.find((p) => p.id === playerA.id).spirit, 4, "playerA's spirit in gameA is untouched");
  assert.equal(playersInGameA.find((p) => p.id === playerB.id).effort, 1, "playerB's effort in gameA is untouched");

  const playersInGameB = await (await fetchAs(`/api/players/${gameB.id}?teamId=${team.id}`)).json();
  assert.equal(playersInGameB.find((p) => p.id === playerA.id).effort, 5, "playerA's effort in gameB is untouched");

  // Nothing left to delete now for that exact combination.
  const secondDelete = await removeAllStars(fetchAs, playerA.id, gameA.id, 'effort');
  assert.equal(secondDelete.status, 404);
});
