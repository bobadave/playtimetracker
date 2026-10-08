const db = require('../db');
const { resolveGameId, closeOutActivePlayers } = require('./gameTime');

async function getAbsentPlayerIds(gameId) {
  const resolvedGameId = resolveGameId(gameId);
  const rows = await db.all('SELECT player_id FROM game_absence WHERE game_id = ?', [resolvedGameId]);
  return new Set(rows.map((row) => Number(row.player_id)));
}

// Replaces the full absence list for a game with exactly the given player ids. The
// Manage Bench popup always submits every team player's desired state at once, so this
// is a full sync (clear then re-insert) rather than an incremental add/remove — and it
// is scoped to players who actually belong to this team, ignoring anything else a
// caller might have sent. Any newly-absent player who is still clocked in has their
// active segment closed out immediately, so their time stops accruing the moment
// they're pulled from the game.
async function setAbsentPlayerIds(gameId, teamId, requestedAbsentPlayerIds) {
  const resolvedGameId = resolveGameId(gameId);
  const teamPlayers = await db.all('SELECT id FROM players WHERE team_id = ? AND archive = 0', [teamId]);
  const teamPlayerIds = new Set(teamPlayers.map((player) => Number(player.id)));
  const absentPlayerIds = [...new Set(requestedAbsentPlayerIds.map(Number))].filter((id) => teamPlayerIds.has(id));

  await db.run('DELETE FROM game_absence WHERE game_id = ?', [resolvedGameId]);

  for (const playerId of absentPlayerIds) {
    await db.run('INSERT INTO game_absence (game_id, player_id) VALUES (?, ?)', [resolvedGameId, playerId]);
  }

  await closeOutActivePlayers(resolvedGameId, new Date().toISOString(), new Set(absentPlayerIds));

  return absentPlayerIds;
}

module.exports = {
  getAbsentPlayerIds,
  setAbsentPlayerIds
};
