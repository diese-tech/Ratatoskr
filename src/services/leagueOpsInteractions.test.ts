import assert from 'node:assert/strict';
import test from 'node:test';
import type { ButtonInteraction } from 'discord.js';
import { openDatabase } from '../db/client.js';
import { beginDirtyLeagueAudit } from '../db/repositories/leagueAudits.js';
import { LeagueJobWorker, registerLeagueJobWorker, type LeagueJobHandler } from './leagueJobWorker.js';
import type { LeagueJobType } from '../db/repositories/leagueJobs.js';
process.env.ROLE_ALLFATHER_ID = 'admin-role';
process.env.ROLE_AESIR_ID = 'staff-role';
const { handleLeagueAuditReviewButton } = await import('./leagueAuditReview.js');
test('double confirmation acknowledges quickly, reports one durable reference, and cannot mutate twice despite delayed card edits', async () => {
  const db = openDatabase(':memory:');
  const events: string[] = [];
  let mutations = 0;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: LeagueJobHandler = async () => {
    mutations++;
  };
  const handlers: Record<LeagueJobType, LeagueJobHandler> = {
    transaction: handler,
    repair: handler,
    targeted: async () => {},
    panel: async () => {},
    dirty: async () => {},
    audit: async () => {},
    heartbeat: async () => {},
  };
  const worker = new LeagueJobWorker(db, 'g', handlers, async () => {});
  registerLeagueJobWorker(db, worker);
  const replies: string[][] = [[], []];
  function interaction(index: number): ButtonInteraction {
    return {
      customId: 'league-audit:confirm:review:0:use-discord-name',
      guild: {
        id: 'g',
        members: {
          fetch: async () => {
            events.push(`authorize:${index}`);
            return { displayName: 'Admin', roles: { cache: new Map([['admin-role', {}]]) } };
          },
        },
      },
      user: { id: 'admin', username: 'Admin' },
      deferUpdate: async () => {
        events.push(`ack:${index}`);
      },
      editReply: async (payload: { content?: string }) => {
        replies[index]!.push(payload.content ?? '');
        if (replies[index]!.length === 1) await delayed;
      },
    } as unknown as ButtonInteraction;
  }
  try {
    beginDirtyLeagueAudit(db, {
      guildId: 'g',
      result: 'dirty',
      findings: ['One name needs review'],
      runReference: 'review',
      runAt: new Date().toISOString(),
      trigger: 'startup',
    });
    const first = handleLeagueAuditReviewButton(interaction(0), db, db);
    const second = handleLeagueAuditReviewButton(interaction(1), db, db);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events[0], 'ack:0');
    assert.ok(events.indexOf('ack:1') < events.indexOf('authorize:1'));
    assert.equal(mutations, 0);
    release();
    await Promise.all([first, second]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mutations, 1);
    assert.equal(
      (db.prepare("SELECT count(*) count FROM league_jobs WHERE type='repair'").get() as { count: number }).count,
      1,
    );
    const reference = (
      db.prepare("SELECT reference FROM league_jobs WHERE type='repair'").get() as { reference: string }
    ).reference;
    assert.ok(replies.every((reply) => reply[1]!.includes(reference)));
    beginDirtyLeagueAudit(db, {
      guildId: 'g',
      result: 'dirty',
      findings: ['Changed finding'],
      runReference: 'new-review',
      runAt: new Date().toISOString(),
      trigger: 'scheduled',
    });
    await handleLeagueAuditReviewButton(interaction(0), db, db);
    assert.equal(mutations, 1);
    assert.match(replies[0]!.at(-1)!, /completed/);
    // No channel/client presentation path is supplied: duplicate/queue states
    // must only respond privately, never attempt a standalone staff alert.
  } finally {
    worker.stop();
    db.close();
  }
});
test('stale component with no matching durable job fails closed before mutation', async () => {
  const db = openDatabase(':memory:');
  const replies: string[] = [];
  try {
    const interaction = {
      customId: 'league-audit:confirm:old:0:use-discord-name',
      guild: { id: 'g', members: { fetch: async () => ({ roles: { cache: new Map([['admin-role', {}]]) } }) } },
      user: { id: 'admin' },
      deferUpdate: async () => {},
      editReply: async (value: { content: string }) => {
        replies.push(value.content);
      },
    } as unknown as ButtonInteraction;
    await handleLeagueAuditReviewButton(interaction, db, db);
    assert.match(replies[0]!, /out of date/);
    assert.equal((db.prepare('SELECT count(*) count FROM league_jobs').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('read failure keeps the current verified finding reviewable without executing a mutation', async () => {
  const db = openDatabase(':memory:');
  let reply: unknown;
  try {
    beginDirtyLeagueAudit(db, {
      guildId: 'g',
      result: 'error',
      findings: ['Team\nDiscord name now: “New”\nCurrent Rosters sheet: “Old”\nPlayer Name History sheet: “Old”'],
      runReference: 'current',
      runAt: new Date().toISOString(),
      trigger: 'scheduled',
    });
    const interaction = {
      customId: 'league-audit:review:current',
      guild: { id: 'g', members: { fetch: async () => ({ roles: { cache: new Map([['admin-role', {}]]) } }) } },
      user: { id: 'admin' },
      deferReply: async () => {},
      editReply: async (value: unknown) => {
        reply = value;
      },
    } as unknown as ButtonInteraction;
    await handleLeagueAuditReviewButton(interaction, db, db);
    assert.match(JSON.stringify(reply), /Resolve this issue/);
    assert.doesNotMatch(JSON.stringify(reply), /out of date/);
    assert.equal((db.prepare('SELECT count(*) count FROM league_jobs').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('recovery confirmation rejects a stale approval and deduplicates repeated current approvals', async () => {
  const { handleLeagueRepairRecoveryButton } = await import('./leagueRepairRecoveryReview.js');
  const { saveLeagueTransactionPreview } = await import('../db/repositories/leagueOperations.js');
  const db = openDatabase(':memory:');
  const events: string[] = [];
  const replies: string[] = [];
  let executions = 0;
  const handler: LeagueJobHandler = async () => { executions++; };
  const worker = new LeagueJobWorker(db, 'g', { transaction: handler, repair: handler, targeted: handler, panel: handler,
    dirty: handler, audit: handler, heartbeat: handler }, async () => {});
  registerLeagueJobWorker(db, worker);
  const fingerprint = 'a'.repeat(64);
  const approval = Buffer.from(fingerprint, 'hex').toString('base64url');
  function interaction(token: string, admin = true): ButtonInteraction {
    return { customId: `league-recovery:confirm:YSL-AUD-FIX-12345678:${token}`,
      guild: { id: 'g', members: { fetch: async () => { events.push('authorize'); return { displayName: 'Admin', roles: { cache: new Map(admin ? [['admin-role', {}]] : []) } }; } } },
      user: { id: 'admin' }, deferReply: async () => { events.push('ack'); }, editReply: async (value: string) => { replies.push(value); } } as unknown as ButtonInteraction;
  }
  try {
    saveLeagueTransactionPreview(db, { guildId: 'g', actorUserId: 'admin', intentKey: 'repair-recovery:YSL-AUD-FIX-12345678', planFingerprint: fingerprint });
    await handleLeagueRepairRecoveryButton(interaction('stale'), db, db);
    assert.equal(events[0], 'ack');
    assert.match(replies.at(-1)!, /out of date/);
    assert.equal(executions, 0);
    await handleLeagueRepairRecoveryButton(interaction(approval, false), db, db);
    assert.match(replies.at(-1)!, /Only league administrators/);
    await handleLeagueRepairRecoveryButton(interaction(approval), db, db);
    await handleLeagueRepairRecoveryButton(interaction(approval), db, db);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executions, 1);
    assert.equal((db.prepare("SELECT count(*) n FROM league_jobs WHERE type='repair'").get() as { n: number }).n, 1);
  } finally { worker.stop(); db.close(); }
});
