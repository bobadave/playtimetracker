const db = require('../db');
const { DEFAULT_TEAM_ID } = require('../config');

function parseUserTeamIds(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((teamId) => Number(teamId)).filter((teamId) => Number.isFinite(teamId) && teamId > 0) : [];
  } catch (error) {
    return [];
  }
}

async function syncUserTeamMembership(userId, teamId) {
  if (!userId || !teamId) {
    return;
  }

  await db.run(
    'INSERT OR IGNORE INTO user_team_memberships (user_id, team_id) VALUES (?, ?)',
    [userId, teamId]
  );

  const rows = await db.all(
    'SELECT team_id FROM user_team_memberships WHERE user_id = ? ORDER BY team_id ASC',
    [userId]
  );

  const teamIds = rows.map((row) => Number(row.team_id));
  await db.run('UPDATE users SET team_ids = ? WHERE id = ?', [JSON.stringify(teamIds), userId]);
}

async function removeUserTeamMembership(userId, teamId) {
  await db.run(
    'DELETE FROM user_team_memberships WHERE user_id = ? AND team_id = ?',
    [userId, teamId]
  );

  const rows = await db.all(
    'SELECT team_id FROM user_team_memberships WHERE user_id = ? ORDER BY team_id ASC',
    [userId]
  );

  const teamIds = rows.map((row) => Number(row.team_id));
  await db.run('UPDATE users SET team_ids = ? WHERE id = ?', [JSON.stringify(teamIds), userId]);
}

async function getCurrentUserTeamIds(userId) {
  if (!userId) {
    return [];
  }

  const user = await db.get('SELECT team_ids FROM users WHERE id = ?', [userId]);
  return parseUserTeamIds(user?.team_ids || '[]');
}

async function userHasTeamAccess(userId, teamId) {
  const currentTeamId = Number(teamId);
  if (!userId || !Number.isFinite(currentTeamId) || currentTeamId <= 0) {
    return false;
  }

  const teamIds = await getCurrentUserTeamIds(userId);
  return teamIds.includes(currentTeamId);
}

function resolveTeamId(teamId) {
  const parsed = Number(teamId ?? DEFAULT_TEAM_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TEAM_ID;
}

module.exports = {
  parseUserTeamIds,
  syncUserTeamMembership,
  removeUserTeamMembership,
  getCurrentUserTeamIds,
  userHasTeamAccess,
  resolveTeamId
};
