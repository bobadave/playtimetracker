// src/routes/pages.js serves the app's HTML shell pages. None of these are hit by any
// other test file (they all talk to the JSON API), so this file exists purely to
// exercise the page-routing logic: the logged-out/logged-in redirect branches, the
// per-team access-check branches, static asset serving, and the catch-all.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  registerAndLogIn,
  createTeam,
  createGame
} = require('./helpers');

let baseUrl;

test.before(async () => {
  baseUrl = await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

function fetchManual(urlPath, cookie) {
  return fetch(`${baseUrl}${urlPath}`, {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {}
  });
}

test('/ redirects to /login when logged out and /teams when logged in', async () => {
  const loggedOut = await fetchManual('/');
  assert.equal(loggedOut.status, 302);
  assert.equal(loggedOut.headers.get('location'), '/login');

  const { cookie } = await registerAndLogIn('PagesRoot');
  const loggedIn = await fetchManual('/', cookie);
  assert.equal(loggedIn.status, 302);
  assert.equal(loggedIn.headers.get('location'), '/teams');
});

test('logged-out-only pages (login, register, forgot/reset password) serve HTML when logged out and redirect to /teams when already logged in', async () => {
  const { cookie } = await registerAndLogIn('PagesLoggedOutOnly');

  for (const urlPath of ['/login', '/register', '/forgot-password', '/reset-password']) {
    const loggedOut = await fetchManual(urlPath);
    assert.equal(loggedOut.status, 200, `${urlPath} should serve its page when logged out`);
    assert.match(loggedOut.headers.get('content-type') || '', /html/);

    const loggedIn = await fetchManual(urlPath, cookie);
    assert.equal(loggedIn.status, 302, `${urlPath} should redirect an already-logged-in user`);
    assert.equal(loggedIn.headers.get('location'), '/teams');
  }
});

test('logged-in-only top-level pages (teams, profile) redirect to /login when logged out and serve HTML when logged in', async () => {
  const { cookie } = await registerAndLogIn('PagesLoggedInOnly');

  for (const urlPath of ['/teams', '/profile']) {
    const loggedOut = await fetchManual(urlPath);
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/login');

    const loggedIn = await fetchManual(urlPath, cookie);
    assert.equal(loggedIn.status, 200);
  }
});

test('team-scoped shortcut pages (/roster, /games, /new-game) redirect to /login when logged out and to the default team\'s page when logged in', async () => {
  const { cookie } = await registerAndLogIn('PagesShortcuts');

  for (const [shortcut, expandedSuffix] of [['/roster', '/roster'], ['/games', '/games'], ['/new-game', '/new-game']]) {
    const loggedOut = await fetchManual(shortcut);
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/login');

    const loggedIn = await fetchManual(shortcut, cookie);
    assert.equal(loggedIn.status, 302);
    assert.equal(loggedIn.headers.get('location'), `/t1${expandedSuffix}`);
  }
});

test('team-scoped pages (/t:teamId/roster, /games, /new-game): member sees HTML, non-member is bounced to /teams, logged-out is bounced to /login', async () => {
  const owner = await registerAndLogIn('PagesScopedOwner');
  const outsider = await registerAndLogIn('PagesScopedOutsider');

  const ownerFetch = (urlPath, options = {}) => fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Cookie: owner.cookie, ...(options.headers || {}) }
  });

  const team = await createTeam(ownerFetch, 'Pages Scoped Team');

  for (const suffix of ['/roster', '/games', '/new-game']) {
    const urlPath = `/t${team.id}${suffix}`;

    const loggedOut = await fetchManual(urlPath);
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/login');

    const nonMember = await fetchManual(urlPath, outsider.cookie);
    assert.equal(nonMember.status, 302);
    assert.equal(nonMember.headers.get('location'), '/teams');

    const member = await fetchManual(urlPath, owner.cookie);
    assert.equal(member.status, 200);
  }
});

test('/games/:gameId redirects to the game\'s own team path when it exists, and to the default team when it does not', async () => {
  const { cookie } = await registerAndLogIn('PagesGameRedirect');
  const fetchAsCookie = (urlPath, options = {}) => fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) }
  });

  const team = await createTeam(fetchAsCookie, 'Pages Game Redirect Team');
  const game = await createGame(fetchAsCookie, team.id, 'Redirect Field');

  const loggedOut = await fetchManual(`/games/${game.id}`);
  assert.equal(loggedOut.status, 302);
  assert.equal(loggedOut.headers.get('location'), '/login');

  const knownGame = await fetchManual(`/games/${game.id}`, cookie);
  assert.equal(knownGame.status, 302);
  assert.equal(knownGame.headers.get('location'), `/t${team.id}/games/${game.id}`);

  const unknownGame = await fetchManual('/games/999999', cookie);
  assert.equal(unknownGame.status, 302);
  assert.equal(unknownGame.headers.get('location'), '/t1/games/999999', 'an unknown game falls back to the default team');
});

test('/t:teamId/games/:gameId: member sees HTML, non-member is bounced to /teams, logged-out is bounced to /login', async () => {
  const owner = await registerAndLogIn('PagesGameDetailOwner');
  const outsider = await registerAndLogIn('PagesGameDetailOutsider');
  const ownerFetch = (urlPath, options = {}) => fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Cookie: owner.cookie, ...(options.headers || {}) }
  });

  const team = await createTeam(ownerFetch, 'Pages Game Detail Team');
  const game = await createGame(ownerFetch, team.id, 'Detail Field');
  const urlPath = `/t${team.id}/games/${game.id}`;

  const loggedOut = await fetchManual(urlPath);
  assert.equal(loggedOut.status, 302);
  assert.equal(loggedOut.headers.get('location'), '/login');

  const nonMember = await fetchManual(urlPath, outsider.cookie);
  assert.equal(nonMember.status, 302);
  assert.equal(nonMember.headers.get('location'), '/teams');

  const member = await fetchManual(urlPath, owner.cookie);
  assert.equal(member.status, 200);
});

test('static assets are served, and an unknown path falls through to the catch-all index.html', async () => {
  const cssResponse = await fetch(`${baseUrl}/styles.css`);
  assert.equal(cssResponse.status, 200);

  const catchAllResponse = await fetch(`${baseUrl}/this-path-does-not-exist`);
  assert.equal(catchAllResponse.status, 200);
  assert.match(catchAllResponse.headers.get('content-type') || '', /html/);
});
