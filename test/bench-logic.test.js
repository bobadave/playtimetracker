const test = require('node:test');
const assert = require('node:assert/strict');

const { isPendingOnField, getDisplayOnField } = require('../public/benchLogic');

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
