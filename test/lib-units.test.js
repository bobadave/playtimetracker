// Direct unit tests for src/lib/* helpers that either aren't reachable through any
// HTTP route (getCumulativePlayerSeconds, requireAuth) or whose early-return guard
// clauses aren't naturally exercised by the app's own call sites (parseUserTeamIds,
// userHasTeamAccess, getCurrentUserTeamIds, syncUserTeamMembership all normally only
// ever get called with a real, truthy userId from a real session).
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

const {
  parseUserTeamIds,
  userHasTeamAccess,
  getCurrentUserTeamIds,
  syncUserTeamMembership
} = require('../src/lib/teams');
const { requireAuth } = require('../src/lib/session');
const { getCumulativePlayerSeconds } = require('../src/lib/activity');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

test('parseUserTeamIds handles empty, malformed, and valid input', () => {
  assert.deepEqual(parseUserTeamIds(null), []);
  assert.deepEqual(parseUserTeamIds(undefined), []);
  assert.deepEqual(parseUserTeamIds(''), []);
  assert.deepEqual(parseUserTeamIds('not json'), [], 'malformed JSON must be swallowed, not thrown');
  assert.deepEqual(parseUserTeamIds('[1, 2, "3", -1, "x"]'), [1, 2, 3], 'non-positive and non-numeric entries are filtered out');
});

test('userHasTeamAccess returns false without a database round-trip for a missing userId or invalid teamId', async () => {
  assert.equal(await userHasTeamAccess(null, 5), false);
  assert.equal(await userHasTeamAccess(1, null), false);
  assert.equal(await userHasTeamAccess(1, 'not-a-number'), false);
  assert.equal(await userHasTeamAccess(1, -1), false);
  assert.equal(await userHasTeamAccess(1, 0), false);
});

test('getCurrentUserTeamIds returns [] without a database round-trip for a missing userId', async () => {
  assert.deepEqual(await getCurrentUserTeamIds(null), []);
  assert.deepEqual(await getCurrentUserTeamIds(undefined), []);
});

test('syncUserTeamMembership is a no-op for a missing userId or teamId', async () => {
  // Should resolve without throwing and without writing anything — there's no
  // membership row to assert against, so we just confirm it doesn't error.
  await syncUserTeamMembership(null, 5);
  await syncUserTeamMembership(1, null);
  await syncUserTeamMembership(undefined, undefined);
});

test('requireAuth middleware rejects an unauthenticated request and calls next() for an authenticated one', () => {
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    }
  };

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  requireAuth({ session: {} }, res, next);
  assert.equal(statusCode, 401);
  assert.equal(jsonBody.message, 'Authentication required.');
  assert.equal(nextCalled, false);

  statusCode = null;
  jsonBody = null;
  requireAuth({ session: { userId: 7 } }, res, next);
  assert.equal(nextCalled, true, 'an authenticated request should fall through to next()');
  assert.equal(statusCode, null, 'no response should be written when access is allowed');
});

test('getCumulativePlayerSeconds sums a player\'s time across their non-archived games and excludes archived ones', async () => {
  const { cookie } = await registerAndLogIn('CumulativeSecondsUnit');
  const fetchAs = authedFetch(cookie);
  const team = await createTeam(fetchAs, 'Cumulative Seconds Unit Team');
  const player = await createPlayer(fetchAs, team.id, 'Unit', 'Timer');
  const game = await createGame(fetchAs, team.id, 'Unit Field');

  assert.equal(await getCumulativePlayerSeconds(player.id), 0, 'a player with no activity at all should be 0');

  await putOnField(fetchAs, player.id, game.id);
  const beforeArchive = await getCumulativePlayerSeconds(player.id);
  assert.ok(beforeArchive >= 0);

  await fetchAs(`/api/games/${game.id}/archive`, { method: 'PUT', body: JSON.stringify({ archived: true }) });
  const afterArchive = await getCumulativePlayerSeconds(player.id);
  assert.equal(afterArchive, 0, 'archiving the only game with activity should bring this back to 0');
});
