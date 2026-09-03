// Shared test infrastructure for the HTTP-integration test suite.
//
// Each test file that requires this module runs as its own `node --test`
// child process, so setting process.env.DB_PATH here (before requiring
// ../src/db or ../src/server) gives that file's whole process an isolated,
// disposable SQLite database — the real dev/prod database is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-test-'));
process.env.DB_PATH = path.join(tempDir, 'game_time_tracker.db');
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const serverExports = require('../src/server');

let httpServer = null;
let baseUrl = null;

async function startTestServer() {
  httpServer = await serverExports.startServer();
  const { port } = httpServer.address();
  baseUrl = `http://localhost:${port}`;
  return baseUrl;
}

async function stopTestServer() {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function getBaseUrl() {
  return baseUrl;
}

function extractSessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : null;
}

// Registers a brand-new verified, logged-in user and returns their email,
// password, and session cookie. `label` becomes part of the email/name so
// failures are easy to trace back to the test that created the user.
async function registerAndLogIn(label) {
  const email = `${label}${Date.now()}${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'password123';

  const regResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: label, lastName: 'Tester', email, password })
  });
  const regJson = await regResponse.json();
  if (regResponse.status !== 201) {
    throw new Error(`registerAndLogIn: registration failed (${regResponse.status}): ${JSON.stringify(regJson)}`);
  }

  // verificationUrl is built from APP_BASE_URL, which was resolved before the
  // OS assigned this process's ephemeral port — rewrite it onto the real baseUrl.
  const parsedUrl = new URL(regJson.verificationUrl);
  await fetch(`${baseUrl}${parsedUrl.pathname}${parsedUrl.search}`);

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (loginResponse.status !== 200) {
    throw new Error(`registerAndLogIn: login failed (${loginResponse.status})`);
  }
  const cookie = extractSessionCookie(loginResponse);

  return { email, password, cookie };
}

// Returns a fetch wrapper that sends JSON + the given session cookie.
// Pass `null` for an intentionally unauthenticated request.
function authedFetch(cookie) {
  return (urlPath, options = {}) => fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    }
  });
}

async function createTeam(fetchAs, label) {
  const response = await fetchAs('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ teamName: `${label} ${Date.now()}${Math.random().toString(36).slice(2)}` })
  });
  if (response.status !== 201) {
    throw new Error(`createTeam failed (${response.status})`);
  }
  const { team } = await response.json();
  return team;
}

async function createPlayer(fetchAs, teamId, firstName, lastName = 'P') {
  const response = await fetchAs('/api/players', {
    method: 'POST',
    body: JSON.stringify({ firstName, lastName, teamId })
  });
  if (response.status !== 201) {
    throw new Error(`createPlayer failed (${response.status})`);
  }
  const { player } = await response.json();
  return player;
}

async function createGame(fetchAs, teamId, location, date = '2026-09-06') {
  const response = await fetchAs('/api/games', {
    method: 'POST',
    body: JSON.stringify({ location, date, team_id: teamId })
  });
  if (response.status !== 201) {
    throw new Error(`createGame failed (${response.status})`);
  }
  const { game } = await response.json();
  return game;
}

function putOnField(fetchAs, playerId, gameId) {
  return fetchAs('/api/segments', {
    method: 'POST',
    body: JSON.stringify({ playerId, inPlay: true, gameId })
  });
}

function takeOffField(fetchAs, playerId, gameId) {
  return fetchAs('/api/segments', {
    method: 'POST',
    body: JSON.stringify({ playerId, inPlay: false, gameId })
  });
}

// Shifts a game's start_time AND every existing player_activity row for that game
// back by the same delta, so the whole session (clock-ins included) is consistently
// simulated as having happened `msAgo` in the past — not just the start_time column.
// Used to simulate a game timing out without waiting a real hour.
async function rewindGameStartTime(gameId, msAgo) {
  const game = await db.get('SELECT start_time FROM games WHERE id = ?', [gameId]);
  const currentStartMs = new Date(game.start_time).getTime();
  const newStartMs = Date.now() - msAgo;
  const deltaMs = newStartMs - currentStartMs;

  const rows = await db.all('SELECT id, timestamp FROM player_activity WHERE game_id = ?', [gameId]);
  for (const row of rows) {
    const shifted = new Date(new Date(row.timestamp).getTime() + deltaMs).toISOString();
    await db.run('UPDATE player_activity SET timestamp = ? WHERE id = ?', [shifted, row.id]);
  }

  await db.run('UPDATE games SET start_time = ? WHERE id = ?', [new Date(newStartMs).toISOString(), gameId]);
}

module.exports = {
  db,
  startTestServer,
  stopTestServer,
  getBaseUrl,
  extractSessionCookie,
  registerAndLogIn,
  authedFetch,
  createTeam,
  createPlayer,
  createGame,
  putOnField,
  takeOffField,
  rewindGameStartTime
};
