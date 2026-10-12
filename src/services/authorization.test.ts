import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import type { GuildMember } from 'discord.js';

process.env.ROLE_ALLFATHER_ID = 'allfather';
process.env.ROLE_AESIR_ID = 'aesir';
delete process.env.ROLE_VALKYRIE_ID;
const { hasAccess, requireAccess } = await import('./authorization.js');
const valkyrieId = '1541186877145485424'; // Existing explicitly recognized YSL staff identity.
const member = (ids: string[]) => ({ roles: { cache: new Map(ids.map((id) => [id, { name: 'Valkyrie' }])) },
  permissions: { has: () => true } }) as unknown as GuildMember;

test('Valkyrie can perform routine operations but cannot administer league structure or configuration', async () => {
  assert.equal(hasAccess(member([valkyrieId]), 'ADMIN'), false);
  assert.equal(hasAccess(member([valkyrieId]), 'OPERATIONS'), true);
  assert.equal(await requireAccess({ reply: async () => assert.fail('Valkyrie must not receive an authorization denial') } as never,
    member([valkyrieId]), 'OPERATIONS'), true);
  for (const id of ['allfather', 'aesir']) {
    assert.equal(hasAccess(member([id]), 'ADMIN'), true);
    assert.equal(hasAccess(member([id]), 'OPERATIONS'), true);
  }
  for (const ids of [[], ['lookalike-valkyrie'], ['captain'], ['production'], ['ordinary']]) {
    assert.equal(hasAccess(member(ids), 'ADMIN'), false);
    assert.equal(hasAccess(member(ids), 'OPERATIONS'), false);
  }
});

test('an explicit Valkyrie ID overrides the legacy default and blank configuration retains the default', () => {
  const script = `import { hasAccess } from './src/services/authorization.js';
    const member = id => ({roles:{cache:new Map([[id,{}]])}});
    console.log(JSON.stringify([hasAccess(member('custom-valkyrie'),'OPERATIONS'),hasAccess(member('${valkyrieId}'),'OPERATIONS')]));`;
  for (const [configured, expected] of [[' custom-valkyrie ', [true, false]], ['', [false, true]]] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, ROLE_VALKYRIE_ID: configured }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});
