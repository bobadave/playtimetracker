const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDbApi } = require('../src/db');
const { resolveGameId, summarizeActivityRows } = require('../src/server');

test('resolveGameId falls back to the default game when inputs are invalid', () => {
  assert.equal(resolveGameId('abc'), 1);
  assert.equal(resolveGameId(-5), 1);
  assert.equal(resolveGameId(0), 1);
  assert.equal(resolveGameId(42), 42);
});

test('summarizeActivityRows adds the correct duration across active and inactive segments', () => {
  const now = new Date('2024-01-01T01:00:00.000Z').getTime();
  const rows = [
    { in_play: 1, timestamp: '2024-01-01T00:00:00.000Z' },
    { in_play: 0, timestamp: '2024-01-01T00:10:00.000Z' },
    { in_play: 1, timestamp: '2024-01-01T00:25:00.000Z' },
    { in_play: 0, timestamp: '2024-01-01T00:35:00.000Z' },
    { in_play: 1, timestamp: '2024-01-01T00:40:00.000Z' }
  ];

  const resultSeconds = summarizeActivityRows(rows, now);
  assert.equal(resultSeconds, 2400);
});

test('createDbApi initializes the default game and player schema for a fresh database', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-'));
  const tempDbPath = path.join(tempDir, 'game_time_tracker.db');
  const dbApi = createDbApi(tempDbPath);

  try {
    await dbApi.initialize();

    const tables = await dbApi.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const tableNames = tables.map((table) => table.name);

    assert.ok(tableNames.includes('games'));
    assert.ok(tableNames.includes('players'));
    assert.ok(tableNames.includes('player_activity'));
    assert.ok(tableNames.includes('teams'));

    const defaultGame = await dbApi.get('SELECT * FROM games WHERE id = 1');
    assert.equal(defaultGame.name, 'Soccer Match');
    assert.equal(Number(defaultGame.is_active), 1);

    const defaultTeam = await dbApi.get('SELECT * FROM teams WHERE id = 1');
    assert.equal(defaultTeam.team_name, 'Default Team');

    const playerCount = await dbApi.get('SELECT COUNT(*) AS total FROM players');
    assert.ok(Number(playerCount.total) >= 5);
  } finally {
    await new Promise((resolve, reject) => {
      dbApi.db.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
});

test('createDbApi upgrades an existing database that is missing team_id columns', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-'));
  const tempDbPath = path.join(tempDir, 'legacy_game_time_tracker.db');
  const dbApi = createDbApi(tempDbPath);

  await dbApi.run(`
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
    )
  `);
  await dbApi.run(`
    CREATE TABLE players (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await dbApi.run(`
    CREATE TABLE teams (
      id INTEGER PRIMARY KEY,
      team_name TEXT NOT NULL,
      user_admin_id INTEGER
    )
  `);
  await dbApi.run(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  await dbApi.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', ['2026-08-30-bootstrap', new Date().toISOString()]);
  await dbApi.run('INSERT INTO games (id, name, created_at, is_active) VALUES (?, ?, ?, ?)', [1, 'Legacy Game', new Date().toISOString(), 1]);

  await dbApi.initialize();

  const gameInfo = await dbApi.all('PRAGMA table_info(games)');
  const playerInfo = await dbApi.all('PRAGMA table_info(players)');

  assert.ok(gameInfo.some((column) => column.name === 'team_id'));
  assert.ok(playerInfo.some((column) => column.name === 'team_id'));

  const defaultTeam = await dbApi.get('SELECT team_name FROM teams WHERE id = 1');
  assert.equal(defaultTeam.team_name, 'Default Team');

  const updatedGame = await dbApi.get('SELECT team_id FROM games WHERE id = 1');
  assert.equal(Number(updatedGame.team_id), 1);

  await new Promise((resolve, reject) => {
    dbApi.db.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

test('createDbApi migrates an existing player_action table to add the value column and widened action types', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-'));
  const tempDbPath = path.join(tempDir, 'legacy_player_action.db');
  const dbApi = createDbApi(tempDbPath);

  await dbApi.run(`
    CREATE TABLE player_action (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('goal')),
      timestamp TEXT NOT NULL
    )
  `);
  await dbApi.run(
    'INSERT INTO player_action (id, game_id, player_id, action, timestamp) VALUES (?, ?, ?, ?, ?)',
    [5, 1, 1, 'goal', '2026-01-01T00:00:00.000Z']
  );

  await dbApi.initialize();

  const columns = await dbApi.all('PRAGMA table_info(player_action)');
  assert.ok(columns.some((column) => column.name === 'value'));

  const migratedRow = await dbApi.get('SELECT * FROM player_action WHERE id = 5');
  assert.equal(migratedRow.action, 'goal');
  assert.equal(Number(migratedRow.value), 1, 'a pre-existing row without a value column gets defaulted to 1');

  const nextInsert = await dbApi.run(
    'INSERT INTO player_action (game_id, player_id, action, value, timestamp) VALUES (?, ?, ?, ?, ?)',
    [1, 1, 'effort', 4, new Date().toISOString()]
  );
  assert.ok(nextInsert.id > 5, 'autoincrement continues past the migrated rows rather than colliding');

  const effortRow = await dbApi.get('SELECT * FROM player_action WHERE id = ?', [nextInsert.id]);
  assert.equal(effortRow.action, 'effort');
  assert.equal(Number(effortRow.value), 4);

  await assert.rejects(
    dbApi.run(
      'INSERT INTO player_action (game_id, player_id, action, value, timestamp) VALUES (?, ?, ?, ?, ?)',
      [1, 1, 'effort', 6, new Date().toISOString()]
    ),
    /CHECK constraint failed/,
    'value is still constrained to 1-5 after the migration'
  );

  await new Promise((resolve, reject) => {
    dbApi.db.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

test('run, get, and all reject their promise when the underlying SQL errors', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-'));
  const dbApi = createDbApi(path.join(tempDir, 'game_time_tracker.db'));

  try {
    await assert.rejects(() => dbApi.run('NOT VALID SQL'));
    await assert.rejects(() => dbApi.get('NOT VALID SQL'));
    await assert.rejects(() => dbApi.all('NOT VALID SQL'));
  } finally {
    await new Promise((resolve, reject) => {
      dbApi.db.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('initialize is idempotent: calling it a second time preserves existing default-team data via COALESCE rather than clobbering it', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtimetracker-'));
  const dbApi = createDbApi(path.join(tempDir, 'game_time_tracker.db'));

  try {
    await dbApi.initialize();

    // Give the bootstrapped default team (id 1) a custom name/admin, simulating a
    // real deployment that has been running for a while, then re-run initialize()
    // exactly as happens on every server restart.
    await dbApi.run('UPDATE teams SET team_name = ?, user_admin_id = ? WHERE id = 1', ['Renamed Team', 42]);
    await dbApi.initialize();

    const team = await dbApi.get('SELECT team_name, user_admin_id FROM teams WHERE id = 1');
    assert.equal(team.team_name, 'Renamed Team', 'COALESCE must not overwrite an already-set team_name');
    assert.equal(team.user_admin_id, 42, 'COALESCE must not overwrite an already-set user_admin_id');

    const migrationCount = await dbApi.get('SELECT COUNT(*) AS total FROM schema_migrations');
    assert.equal(Number(migrationCount.total), 1, 'the bootstrap migration row must not be inserted twice');

    const gameCount = await dbApi.get('SELECT COUNT(*) AS total FROM games WHERE id = 1');
    assert.equal(Number(gameCount.total), 1, 'the default game must not be inserted twice');
  } finally {
    await new Promise((resolve, reject) => {
      dbApi.db.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
