import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceScoutEmojiBinding, createScoutEmojiBindingState } from './scoutEmojiBinding.js';

test('emoji binding accepts five distinct guild emoji in scout role order', () => {
  let state = createScoutEmojiBindingState('guild-1', 'admin-1');
  const guildEmojiIds = new Set(['e1', 'e2', 'e3', 'e4', 'e5']);
  let final: ReturnType<typeof advanceScoutEmojiBinding> | undefined;

  for (const emojiId of guildEmojiIds) {
    const result = advanceScoutEmojiBinding(state, { userId: 'admin-1', emojiId, guildEmojiIds });
    assert.ok(result.outcome === 'progress' || result.outcome === 'complete');
    state = result.state;
    final = result;
  }

  assert.ok(final);
  assert.equal(final.outcome, 'complete');
  assert.deepEqual(final.emojiByRole, {
    solo: 'e1',
    jungle: 'e2',
    mid: 'e3',
    support: 'e4',
    carry: 'e5',
  });
});

test('emoji binding rejects other users, standard emoji, foreign emoji, and duplicates without advancing', () => {
  const state = createScoutEmojiBindingState('guild-1', 'admin-1');
  const guildEmojiIds = new Set(['e1']);

  assert.equal(
    advanceScoutEmojiBinding(state, { userId: 'other', emojiId: 'e1', guildEmojiIds }).outcome,
    'ignored-user',
  );
  assert.equal(
    advanceScoutEmojiBinding(state, { userId: 'admin-1', emojiId: null, guildEmojiIds }).outcome,
    'invalid-standard',
  );
  assert.equal(
    advanceScoutEmojiBinding(state, { userId: 'admin-1', emojiId: 'foreign', guildEmojiIds }).outcome,
    'invalid-guild',
  );

  const progressed = advanceScoutEmojiBinding(state, { userId: 'admin-1', emojiId: 'e1', guildEmojiIds });
  assert.equal(progressed.outcome, 'progress');
  assert.equal(
    advanceScoutEmojiBinding(progressed.state, { userId: 'admin-1', emojiId: 'e1', guildEmojiIds }).outcome,
    'duplicate',
  );
});
