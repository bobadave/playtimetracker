const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'game_time_tracker.db');

fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(dbPath);

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

async function initialize() {
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

  for (const columnSql of [
    'ALTER TABLE games ADD COLUMN location TEXT',
    'ALTER TABLE games ADD COLUMN date TEXT',
    'ALTER TABLE games ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))'
  ]) {
    try {
      await run(columnSql);
    } catch (error) {
      const message = String(error.message || '');
      if (!message.includes('duplicate column name')) {
        throw error;
      }
    }
  }

  const teamsInfo = await all('PRAGMA table_info(teams)');
  if (!teamsInfo || teamsInfo.length === 0) {
    await run(`
      CREATE TABLE teams (
        id INTEGER PRIMARY KEY,
        team_name TEXT NOT NULL,
        user_admin_id INTEGER
      )
    `);
  } else {
    const hasTeamName = teamsInfo.some((column) => column.name === 'team_name');
    const hasUserAdminId = teamsInfo.some((column) => column.name === 'user_admin_id');

    if (!hasTeamName || !hasUserAdminId) {
      const tempTableName = 'teams_new';
      await run(`
        CREATE TABLE ${tempTableName} (
          id INTEGER PRIMARY KEY,
          team_name TEXT NOT NULL,
          user_admin_id INTEGER
        )
      `);

      const existingTeams = await all('SELECT * FROM teams');
      for (const team of existingTeams) {
        await run(
          `INSERT INTO ${tempTableName} (id, team_name, user_admin_id) VALUES (?, ?, ?)`,
          [team.id, team.team_name || `Team ${team.id}`, team.user_admin_id ?? null]
        );
      }

      await run('DROP TABLE teams');
      await run(`ALTER TABLE ${tempTableName} RENAME TO teams`);
    }
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

  for (const columnSql of [
    'ALTER TABLE players ADD COLUMN archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0, 1))',
    'ALTER TABLE players ADD COLUMN team_id INTEGER NOT NULL DEFAULT 1 REFERENCES teams(id)'
  ]) {
    try {
      await run(columnSql);
    } catch (error) {
      const message = String(error.message || '');
      if (!message.includes('duplicate column name')) {
        throw error;
      }
    }
  }

  await run('UPDATE players SET team_id = 1 WHERE team_id IS NULL OR team_id = 0');

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

  const today = new Date().toISOString().slice(0, 10);
  const existingGame = await get('SELECT id FROM games WHERE id = 1');
  if (!existingGame) {
    await run(
      'INSERT INTO games (id, name, created_at, location, date, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [1, 'Soccer Match', new Date().toISOString(), 'TBD', today, 1]
    );
  } else {
    await run(
      'UPDATE games SET is_active = 1, location = COALESCE(location, ?), date = COALESCE(date, ?) WHERE id = 1',
      ['TBD', today]
    );
  }

  const defaultPlayers = [
    { id: 1, first_name: 'Mads', last_name: 'Liem' },
    { id: 2, first_name: 'Josiah', last_name: 'Reyes' },
    { id: 3, first_name: 'Lydia', last_name: "D'Ooge" },
    { id: 4, first_name: 'Max', last_name: 'Erich' },
    { id: 5, first_name: 'Emery', last_name: 'Last_name' }
  ];

  for (const player of defaultPlayers) {
    const existingPlayer = await get('SELECT id FROM players WHERE id = ?', [player.id]);
    if (!existingPlayer) {
      await run(
        'INSERT INTO players (id, first_name, last_name, archive, created_at) VALUES (?, ?, ?, ?, ?)',
        [player.id, player.first_name, player.last_name, 0, new Date().toISOString()]
      );
    }
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initialize
};
