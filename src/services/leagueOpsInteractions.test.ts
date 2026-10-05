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
