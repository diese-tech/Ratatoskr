import assert from 'node:assert/strict';
import test from 'node:test';
import { scoutCancelButtonRow } from './scoutCancel.js';
import { scoutReviewButtonRow } from './scoutReview.js';

test('signup controls keep a setup-specific cancellation path before and after roster creation', () => {
  const openControls = scoutCancelButtonRow(42, 0).toJSON().components;
  assert.deepEqual(openControls.map((component) => 'custom_id' in component ? component.custom_id : undefined), ['scout:cancel:42:0']);

  const rosterControls = scoutReviewButtonRow(42).toJSON().components;
  assert.deepEqual(rosterControls.map((component) => 'custom_id' in component ? component.custom_id : undefined), ['scout:review:42', 'scout:cancel:42:0']);
});
