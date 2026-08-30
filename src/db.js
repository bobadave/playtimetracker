const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'game_time_tracker.db');

function createDbApi(databasePath = dbPath) {
  const targetDir = path.dirname(databasePath);
  fs.mkdirSync(targetDir, { recursive: true });

  const db = new sqlite3.Database(databasePath);

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) {
          reject(err);
          return;
        }

        resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }

  function get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(row);
      });
    });
  }

  function all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(rows);
      });
    });
  }

  async function ensureColumn(tableName, columnName, columnDefinition) {
    const tableInfo = await all(`PRAGMA table_info(${tableName})`);
    const exists = tableInfo.some((column) => column.name === columnName);

    if (!exists) {
      await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
    }
  }

  async function initialize() {
    await run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        location TEXT,
        date TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY,
        team_name TEXT NOT NULL,
        user_admin_id INTEGER
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0, 1)),
        team_id INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS player_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        in_play INTEGER NOT NULL CHECK (in_play IN (0, 1)),
        timestamp TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id),
        FOREIGN KEY (player_id) REFERENCES players(id)
      )
    `);

    await ensureColumn('games', 'location', 'location TEXT');
    await ensureColumn('games', 'date', 'date TEXT');
    await ensureColumn('games', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))');
    await ensureColumn('games', 'team_id', 'team_id INTEGER NOT NULL DEFAULT 1 REFERENCES teams(id)');

    await ensureColumn('teams', 'team_name', 'team_name TEXT NOT NULL');
    await ensureColumn('teams', 'user_admin_id', 'user_admin_id INTEGER');

    await ensureColumn('players', 'archive', 'archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0, 1))');
    await ensureColumn('players', 'team_id', 'team_id INTEGER NOT NULL DEFAULT 1 REFERENCES teams(id)');

    const migrationVersion = '2026-08-30-bootstrap';
    const existingMigration = await get('SELECT version FROM schema_migrations WHERE version = ?', [migrationVersion]);
    if (!existingMigration) {
      await run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [migrationVersion, new Date().toISOString()]);
    }

    const defaultTeam = await get('SELECT id FROM teams WHERE id = 1');
    if (!defaultTeam) {
      await run('INSERT INTO teams (id, team_name, user_admin_id) VALUES (?, ?, ?)', [1, 'Default Team', null]);
    } else {
      await run(
        'UPDATE teams SET team_name = COALESCE(team_name, ?), user_admin_id = COALESCE(user_admin_id, ?) WHERE id = 1',
        ['Default Team', null]
      );
    }

    await run('UPDATE games SET team_id = 1 WHERE team_id IS NULL OR team_id = 0');
    await run('UPDATE players SET team_id = 1 WHERE team_id IS NULL OR team_id = 0');

    const today = new Date().toISOString().slice(0, 10);
    const existingGame = await get('SELECT id FROM games WHERE id = 1');
    if (!existingGame) {
      await run(
        'INSERT INTO games (id, name, created_at, location, date, is_active, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1, 'Soccer Match', new Date().toISOString(), 'TBD', today, 1, 1]
      );
    } else {
      await run(
        'UPDATE games SET is_active = 1, location = COALESCE(location, ?), date = COALESCE(date, ?), team_id = COALESCE(team_id, ?) WHERE id = 1',
        ['TBD', today, 1]
      );
    }

    const playerCount = await get('SELECT COUNT(*) AS total FROM players');
    if (Number(playerCount.total) === 0) {
      const defaultPlayers = [
        { id: 1, first_name: 'Mads', last_name: 'Liem' },
        { id: 2, first_name: 'Josiah', last_name: 'Reyes' },
        { id: 3, first_name: 'Lydia', last_name: "D'Ooge" },
        { id: 4, first_name: 'Max', last_name: 'Erich' },
        { id: 5, first_name: 'Emery', last_name: 'Last_name' }
      ];

      for (const player of defaultPlayers) {
        await run(
          'INSERT INTO players (id, first_name, last_name, archive, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [player.id, player.first_name, player.last_name, 0, 1, new Date().toISOString()]
        );
      }
    }
  }

  return { db, run, get, all, initialize };
}

const db = createDbApi(dbPath);

module.exports = {
  ...db,
  createDbApi
};
