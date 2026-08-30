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
