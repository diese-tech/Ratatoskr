import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScoutConfig } from '../db/types.js';
import type { ScoutConfigurationStore } from '../storage/index.js';
import {
  advanceScoutEmojiBinding,
  createScoutEmojiBindingState,
  handleScoutFillSkipButton,
  SCOUT_SKIP_FILL_CUSTOM_ID,
  skipScoutFillEmojiBinding,
  startScoutEmojiBinding,
  tryHandleScoutEmojiBinding,
} from './scoutEmojiBinding.js';

test('emoji binding accepts five distinct guild emoji in scout role order', () => {
  let state = createScoutEmojiBindingState('guild-1', 'admin-1');
  const guildEmojiIds = new Set(['e1', 'e2', 'e3', 'e4', 'e5']);
  let final: ReturnType<typeof advanceScoutEmojiBinding> | undefined;

  for (const emojiId of guildEmojiIds) {
    const result = advanceScoutEmojiBinding(state, { userId: 'admin-1', emojiId, guildEmojiIds });
    assert.ok(['progress', 'awaiting-fill', 'complete'].includes(result.outcome));
    state = result.state;
    final = result;
  }

  assert.ok(final);
  assert.equal(final.outcome, 'awaiting-fill');
  const skipped = skipScoutFillEmojiBinding(final.state, 'admin-1');
  assert.equal(skipped.outcome, 'complete');
  assert.deepEqual(skipped.emojiByRole, {
    solo: 'e1',
    jungle: 'e2',
    mid: 'e3',
    support: 'e4',
    carry: 'e5',
    fill: null,
  });
});

test('emoji binding optionally accepts Fill as the sixth distinct guild emoji', () => {
  let state = createScoutEmojiBindingState('guild-1', 'admin-1');
  const guildEmojiIds = new Set(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
  let final: ReturnType<typeof advanceScoutEmojiBinding> | undefined;
  for (const emojiId of guildEmojiIds) {
    final = advanceScoutEmojiBinding(state, { userId: 'admin-1', emojiId, guildEmojiIds });
    state = final.state;
  }
  assert.equal(final?.outcome, 'complete');
  assert.equal(final?.emojiByRole?.fill, 'e6');
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

test('emoji binding publishes only its successful prompt after private channel validation', async () => {
  const edits: any[] = [];
  const followUps: any[] = [];
  const message = {
    id: 'binding-message',
    edit: async () => message,
  };

  await startScoutEmojiBinding({
    guild: { id: 'guild-1' },
    user: { id: 'admin-1' },
    deferred: true,
    replied: false,
    editReply: async (payload: unknown) => { edits.push(payload); },
    followUp: async (payload: unknown) => { followUps.push(payload); return message; },
    fetchReply: async () => { throw new Error('the private reply is not the binding message'); },
  } as never, { publicFollowUp: true });

  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /saved/i);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].fetchReply, true);
  assert.match(followUps[0].content, /React to this message/i);
});

test('Skip Fill acknowledges before awaiting asynchronous emoji persistence', async () => {
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
  const config: ScoutConfig = {
    guildId: 'guild-1',
    authorizedRoleIds: [],
    operationsCategoryId: null,
    operationsChannelId: null,
    emojiByRole: { solo: 'e1', jungle: 'e2', mid: 'e3', support: 'e4', carry: 'e5', fill: null },
    timezone: 'America/New_York',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
  const storage = {
    async ensureScoutConfig() { throw new Error('not used'); },
    async setScoutAuthorizedRoleIds() { throw new Error('not used'); },
    async setScoutOperationsChannel() { throw new Error('not used'); },
    async setScoutTimezone() { throw new Error('not used'); },
    async setScoutEmojiByRole() {
      announceWrite();
      await writeGate;
      return config;
    },
  } satisfies ScoutConfigurationStore;
  const edits: unknown[] = [];
  const guild = {
    id: 'guild-1',
    emojis: {
      cache: new Map(['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => [id, { id }])),
      fetch: async () => undefined,
    },
  };
  const message = {
    id: 'binding-message',
    partial: false,
    guild,
    edit: async (payload: unknown) => { edits.push(payload); return message; },
  };
  await startScoutEmojiBinding({
    guild,
    user: { id: 'admin-1' },
    deferred: false,
    replied: false,
    reply: async () => undefined,
    fetchReply: async () => message,
  } as never);
  const user = { id: 'admin-1', bot: false, partial: false };
  for (const emojiId of ['e1', 'e2', 'e3', 'e4', 'e5']) {
    await tryHandleScoutEmojiBinding({
      partial: false,
      message,
      emoji: { id: emojiId },
      users: { remove: async () => undefined },
    } as never, user as never, storage);
  }

  let deferredUpdates = 0;
  const updates: unknown[] = [];
  const replyEdits: unknown[] = [];
  const handling = handleScoutFillSkipButton({
    customId: SCOUT_SKIP_FILL_CUSTOM_ID,
    message,
    user,
    deferUpdate: async () => { deferredUpdates += 1; },
    update: async (payload: unknown) => { updates.push(payload); },
    editReply: async (payload: unknown) => { replyEdits.push(payload); },
  } as never, storage);
  await writeStarted;
  const acknowledgementsBeforeWrite = deferredUpdates;
  releaseWrite();
  assert.equal(await handling, true);
  assert.equal(acknowledgementsBeforeWrite, 1);
  assert.equal(updates.length, 0);
  assert.equal(replyEdits.length, 1);
});
