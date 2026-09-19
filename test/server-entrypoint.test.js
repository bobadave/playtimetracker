// Every other test file requires src/server.js as a module, which never runs the
// `if (require.main === module) { startServer().catch(...) }` block at the bottom of
// that file (require.main is the test runner, not server.js). This file actually spawns
// `node src/server.js` as the real CLI entry point, to cover both branches: a normal
// successful start, and startServer() rejecting (a corrupt database file), which should
// log an error and exit with code 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const serverPath = path.join(__dirname, '..', 'src', 'server.js');

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      return response;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Server at ${url} never became ready: ${lastError}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('process did not exit in time'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('running src/server.js directly starts a working HTTP server on the configured port', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-entrypoint-'));
  const dbPath = path.join(tempDir, 'game_time_tracker.db');
  const port = 20000 + (process.pid % 10000);

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const response = await waitForServer(`http://localhost:${port}/login`, 10000);
    assert.equal(response.status, 200);
    assert.equal(stderr, '', 'a successful start should not log anything to stderr');
  } finally {
    child.kill();
    await waitForExit(child, 5000).catch(() => undefined);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('running src/server.js against a database that fails to initialize logs an error and exits with code 1', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-entrypoint-fail-'));
  const dbPath = path.join(tempDir, 'game_time_tracker.db');
  // A file that exists but is not a valid SQLite database makes db.initialize()'s
  // very first statement reject cleanly (SQLITE_NOTADB), which is what actually
  // exercises startServer().catch(...) rather than crashing via an unrelated
  // uncaught 'error' event (which is what happens if the path can't be opened at all).
  fs.writeFileSync(dbPath, 'this is not a valid sqlite database file');
  const port = 20000 + ((process.pid + 1) % 10000);

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const { code } = await waitForExit(child, 10000);
    assert.equal(code, 1);
    assert.match(stderr, /Failed to start server:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
