// Pure decision logic shared between the browser (app.js) and the Node test suite.
// No DOM access here on purpose — this file is loaded as a plain <script> in the
// browser and required directly by node --test, so it must run in both environments.

// While a game is paused, pausing has already closed everyone's field time out
// server-side, so player.inStage is false for everyone regardless of who is actually
// staged to go back on the field — that's tracked client-side in pausedFieldPlayerIds
// until Resume.
function isPendingOnField(player, pausedFieldPlayerIds) {
  return !player.inStage && pausedFieldPlayerIds.has(player.id);
}

// "Currently on the field" for display purposes, accounting for both a real clock-in
// and a pending one staged while paused.
function getDisplayOnField(player, pausedFieldPlayerIds) {
  return !!(player.inStage || isPendingOnField(player, pausedFieldPlayerIds));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isPendingOnField, getDisplayOnField };
}
