const test = require('node:test');
const assert = require('node:assert/strict');

const { isPendingOnField, getDisplayOnField, hasGameStarted } = require('../public/benchLogic');

function makePlayer(id, inStage) {
  return { id, inStage, fullName: `Player ${id}` };
}

test('isPendingOnField and getDisplayOnField treat a staged-while-paused player as on the field', () => {
  const pending = makePlayer(1, false);
  const confirmed = makePlayer(2, true);
  const benched = makePlayer(3, false);
  const pausedFieldPlayerIds = new Set([pending.id]);

  assert.equal(isPendingOnField(pending, pausedFieldPlayerIds), true);
  assert.equal(getDisplayOnField(pending, pausedFieldPlayerIds), true);

  // Already confirmed on the field (not merely pending) is never reported as "pending".
  assert.equal(isPendingOnField(confirmed, pausedFieldPlayerIds), false);
  assert.equal(getDisplayOnField(confirmed, pausedFieldPlayerIds), true);

  assert.equal(isPendingOnField(benched, pausedFieldPlayerIds), false);
  assert.equal(getDisplayOnField(benched, pausedFieldPlayerIds), false);
});

test('hasGameStarted is false for a brand-new game with no quarters, true once any quarter has opened or the game has finished', () => {
  assert.equal(hasGameStarted({ quarters: [] }), false, 'no quarter has ever opened');
  assert.equal(hasGameStarted({ quarters: [], finished_at: null }), false);
  assert.equal(hasGameStarted(null), false, 'missing game data is treated as not started');
  assert.equal(hasGameStarted(undefined), false);

  assert.equal(hasGameStarted({ quarters: [{ quarter_number: 1, end_time: null }] }), true, 'quarter 1 has opened');
  assert.equal(
    hasGameStarted({ quarters: [{ quarter_number: 2, end_time: '2026-01-01T00:10:00.000Z' }] }),
    true,
    'even a closed-out quarter means the game has started'
  );
  assert.equal(
    hasGameStarted({ quarters: [], finished_at: '2026-01-01T00:40:00.000Z' }),
    true,
    'a finished game has started, regardless of what quarters are reported'
  );
});
