import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Collection, MessageFlags } from 'discord.js';
import { openDatabase } from '../db/client.js';
import { createLeagueTransaction } from '../db/repositories/leagueOperations.js';
import { buildGroupTradePlan, type LeagueSnapshot, type LeagueMutationPlan } from '../domain/leagueOperations.js';
import { LEGACY_YSL_VALKYRIE_ROLE_ID } from '../config/staff-role-ids.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';
import { LeagueJobWorker, registerLeagueJobWorker, type LeagueJobHandler } from './leagueJobWorker.js';
import type { LeagueJobType } from '../db/repositories/leagueJobs.js';
import { cleanLeagueSnapshot } from './leagueOpsFixtures.test-support.js';
import { LeagueSheetsService, type LoadedLeagueSnapshot } from './leagueSheets.js';

process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';
const { openGroupTrade, handleGroupTradeInteraction } = await import('./leagueGroupTradeUi.js');

function snapshotWithThreePlayers() {
  const snapshot = cleanLeagueSnapshot();
  snapshot.rosters.push({ ...snapshot.rosters[0]!, sheetRow: 8, discordId: 'three', player: 'Three' });
  snapshot.names.push({ ...snapshot.names[0]!, sheetRow: 8, discordId: 'three', knownName: 'Three', currentLeagueName: 'Three' });
  snapshot.discordMembers.push({ ...snapshot.discordMembers[0]!, discordId: 'three', displayName: 'Three' });
  snapshot.publicRosters.Vanaheim!.teams.A!.push('Three');
  return snapshot;
}

test('grouped trades reject unsupported shapes, repeated identities, wrong teams and absent players', () => {
  const snapshot = snapshotWithThreePlayers();
  const choice = { teamA: 'a', teamB: 'b', outboundA: ['one', 'three'], outboundB: ['two'] };
  for (const [a, b] of [[3, 3], [3, 4], [4, 5], [2, 0], [1, 3], [3, 1]]) {
    assert.throws(() => buildGroupTradePlan(snapshot, {
      ...choice, outboundA: Array(a).fill('one'), outboundB: Array(b).fill('two'),
    }), /supported exchange/);
  }
  assert.throws(() => buildGroupTradePlan(snapshot, { ...choice, outboundB: ['one'] }), /only once/);
  assert.throws(() => buildGroupTradePlan(snapshot, { ...choice, teamB: 'a' }), /different teams/);
  assert.throws(() => buildGroupTradePlan(snapshot, { ...choice, outboundA: ['two'], outboundB: ['one'] }), /no longer on the team/);
  snapshot.teams[1]!.division = 'Alfheim';
  assert.throws(() => buildGroupTradePlan(snapshot, choice), /Cross-division/);
  snapshot.teams[1]!.division = 'Vanaheim';
  snapshot.discordMembers.pop();
  assert.throws(() => buildGroupTradePlan(snapshot, choice), /not currently in the Discord server/);
});

for (const scenario of ['approve', 'new roster action', 'cooldown'] as const) {
  test(`private group trade uses one shared full member read and handles ${scenario}`, async t => {
    const db = openDatabase(':memory:');
    const worker = new LeagueJobWorker(db, 'g', {} as Record<LeagueJobType, LeagueJobHandler>, async () => {});
    worker.stop();
    registerLeagueJobWorker(db, worker);
    t.after(() => { worker.stop(); db.close(); });
    for (const [key, value] of Object.entries({ ROLE_FREE_AGENT_ID: 'fa', YSL_TRANSACTIONS_CHANNEL_ID: 'notices',
      YSL_ADMIN_SPREADSHEET_ID: 'test-admin', YSL_PUBLIC_SPREADSHEET_ID: 'test-public',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'bot@example.com', private_key: 'synthetic-test-key' }) })) {
      const old = process.env[key];
      process.env[key] = value;
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    const snapshot = snapshotWithThreePlayers();
    const client = new EventEmitter();
    let reads = 0;
    let authorized = true;
    const guild = { id: 'g', client, memberCount: 3, members: { fetch: async (options?: unknown) => {
      if (options) return { displayName: 'Staff', roles: { cache: new Map(authorized ? [[LEGACY_YSL_VALKYRIE_ROLE_ID, {}]] : []) } };
      reads++;
      if (scenario === 'cooldown' && reads > 1)
        throw Object.assign(Error('Request with opcode 8 was rate limited.'), { data: { opcode: 8, retry_after: 30 } });
      return new Collection(snapshot.discordMembers.map(member => [member.discordId, {
        id: member.discordId, displayName: member.displayName, user: { bot: false },
        roles: { cache: new Map(member.roleIds.map(id => [id, {}])) },
      }]));
    } } };
    t.mock.method(console, 'error', () => {});
    const roleProof = t.mock.method(DiscordLeagueGateway.prototype, 'validateGroupTradeRoles', async () => {});
    t.mock.method(LeagueSheetsService.prototype, 'load', async (discordMembers: LeagueSnapshot['discordMembers']) => ({
      snapshot: { ...snapshot, discordMembers }, sources: {} as never,
    }));
    t.mock.method(LeagueSheetsService.prototype, 'verifyGroupTradeSheets', async (_loaded: LoadedLeagueSnapshot, plan: LeagueMutationPlan) => { plan.groupTrade!.sheetFingerprint = 'checked'; });
    t.mock.method(LeagueSheetsService.prototype, 'assertUnchanged', async () => {});
    t.mock.method(LeagueSheetsService.prototype, 'apply', async () => assert.fail('The private review cannot write Sheets'));
    const actor = { id: 'staff' };
    type Card = { content: string; embeds: { data: { description: string } }[]; components: { components: { data: { custom_id: string; disabled: boolean } }[] }[] };
    let card: Card;
    const editReply = async (message: Card) => { card = message; };
    const replies: string[] = [];
    const followUp = async (message: { content: string; flags: number }) => {
      assert.equal(message.flags, MessageFlags.Ephemeral);
      replies.push(message.content);
    };
    const click = async (customId: string, values?: string[], user = actor) => handleGroupTradeInteraction({
      guild, user, customId, values, isStringSelectMenu: () => Boolean(values), isButton: () => !values,
      deferUpdate: async () => {}, deferred: true, editReply, followUp, reply: followUp,
    } as never, db, db);
    const control = (action: string) => card.components.flatMap(row => row.components)
      .find(component => component.data.custom_id.startsWith(`group-trade:${action}:`))!.data;
    await openGroupTrade({ guild, user: actor, editReply } as never, db, db, 'a', 'b', 'Approved by staff');
    assert.equal(control('confirm').disabled, true);
    if (scenario === 'cooldown') {
      client.emit('guildMemberUpdate', {}, { guild });
      await click(control('a').custom_id, ['one', 'three']);
      await click(control('a').custom_id, ['one', 'three']);
      assert.equal(reads, 2);
      assert.match(replies.at(-1)!, /Discord asked Rat to wait.*No changes were made/);
    } else {
      await click(control('a').custom_id, ['one', 'three']);
      await click(control('b').custom_id, ['two']);
      const stale = control('confirm').custom_id;
      assert.equal(control('confirm').disabled, false);
      assert.match(card!.embeds[0]!.data.description, /2-for-1.*\n[\s\S]*A → B: One, Three[\s\S]*A · 2 → 1 players/);
      await click(control('a').custom_id, ['one']);
      await click(stale);
      assert.match(replies.at(-1)!, /no longer current/);
      assert.match(card!.embeds[0]!.data.description, /1-for-1/);
      const confirmation = control('confirm').custom_id;
      await click(confirmation, undefined, { id: 'another-staff' });
      assert.match(replies.at(-1)!, /belongs to another/);
      authorized = false;
      await click(confirmation);
      assert.match(replies.at(-1)!, /permissions.*[\s\S]*No changes were made/);
      authorized = true;
      if (scenario === 'new roster action')
        createLeagueTransaction(db, { reference: 'other-action', guildId: 'g', kind: 'trade', actorUserId: 'other', payload: {} });
      await click(confirmation);
      assert.equal(reads, 1, 'both picker redraws and confirmation avoid additional opcode-8 requests');
      if (scenario === 'approve') {
        assert.match(card!.content, /YSL-JOB-/);
        await click(confirmation);
        assert.match(replies.at(-1)!, /already saved/);
        const jobs = db.prepare('SELECT payload_json FROM league_jobs').all() as { payload_json: string }[];
        assert.equal(jobs.length, 1);
        const intent = JSON.parse(jobs[0]!.payload_json);
        assert.deepEqual(JSON.parse(intent.selections), ['trade-group', 'a', 'b', ['one'], ['two'], 'Approved by staff']);
        assert.equal(intent.actorUserId, 'staff');
        assert.ok(intent.approvedAt);
        assert.equal(roleProof.mock.callCount(), 3);
        return;
      }
      assert.match(replies.at(-1)!, /changed after the preview/);
    }
    assert.deepEqual(db.prepare('SELECT count(*) n FROM league_jobs').get(), { n: 0 });
  });
}
