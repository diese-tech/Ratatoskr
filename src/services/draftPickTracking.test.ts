import assert from 'node:assert/strict';
import test from 'node:test';
import { readDraftPickTracking, validateDraftPickTable } from './draftPickTracking.js';
import { DRAFT_DIVISIONS, DRAFT_PICK_HEADERS } from './draftPicks.js';

function seededRows(): (string | number | boolean | null)[][] {
  return DRAFT_DIVISIONS.flatMap(division => Array.from({ length: 8 }, (_, team) =>
    Array.from({ length: 4 }, (_, round) => [division, `Team ${team}`, round + 1, team * 4 + round + 1,
      'Draft name', `${division}-${team}-${round}`, 'Current name', 'Manual', 'On drafted team', ''])).flat());
}

test('seeded, empty, unresolved and malformed tables report honest verification health', async () => {
  let rows = seededRows();
  let headers = [DRAFT_PICK_HEADERS];
  const gateway = { getValues: async (_id: string, range: string) => range.includes('A5:') ? headers : rows };
  assert.equal((await readDraftPickTracking(gateway, 'admin')).health.status, 'ready');
  rows[0]![5] = ''; rows[0]![8] = 'Unknown';
  assert.equal((await readDraftPickTracking(gateway, 'admin')).health.status, 'partial');
  rows[0]![2] = 8;
  assert.equal((await readDraftPickTracking(gateway, 'admin')).health.status, 'invalid-schema');
  rows = [];
  assert.equal((await readDraftPickTracking(gateway, 'admin')).health.status, 'empty-tab');
  headers = [['Wrong columns']];
  assert.equal((await readDraftPickTracking(gateway, 'admin')).health.status, 'invalid-schema');
});

test('permission, quota, service and other 400 errors never become missing-tab or expose raw source details', async () => {
  for (const [status, expected] of [[403, 'permission-denied'], [429, 'quota'], [503, 'service-unavailable'],
    [404, 'workbook-unavailable'], [400, 'invalid-request']] as const) {
    const result = await readDraftPickTracking({ getValues: async () => {
      throw Object.assign(Error('private-workbook-id secret-token player-name'), { response: { status } });
    }, getWorkbookProperties: async () => ({ title: 'Admin', sheets: ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History']
      .map((title, sheetId) => ({ title, sheetId })) }) }, 'admin');
    assert.equal(result.health.status, expected);
    assert.equal(result.health.httpStatus, status);
    assert.equal(result.rows, null);
    assert.doesNotMatch(JSON.stringify(result), /private-workbook-id|secret-token|player-name/);
  }
});

test('wrong-workbook metadata and failed metadata diagnosis cannot prove optional absence', async () => {
  const getValues = async () => { throw Object.assign(Error('Unable to parse range'), { status: 400 }); };
  assert.equal((await readDraftPickTracking({ getValues, getWorkbookProperties: async () => ({ title: 'Public', sheets: [] }) }, 'admin')).health.status, 'wrong-workbook');
  assert.equal((await readDraftPickTracking({ getValues, getWorkbookProperties: async () => {
    throw Object.assign(Error('access denied'), { status: 403 });
  } }, 'admin')).health.status, 'permission-denied');
  assert.equal((await readDraftPickTracking({ getValues }, 'admin')).health.status, 'invalid-request');
});

test('a manual ID correction is unverified at runtime but seed inspection retains it for owned-status recomputation', () => {
  const rows = seededRows();
  rows[0]![8] = 'Moved · trade · previous'; rows[0]![9] = 'old-id';
  const before = structuredClone(rows);
  assert.equal(validateDraftPickTable([DRAFT_PICK_HEADERS], rows).status, 'invalid-schema');
  assert.equal(validateDraftPickTable([DRAFT_PICK_HEADERS], rows, { allowCorrectedStatusOwner: true }).status, 'partial');
  assert.deepEqual(rows, before);
  rows[0]![5] = 123456789012345678; // Numeric ID precision is never accepted.
  assert.equal(validateDraftPickTable([DRAFT_PICK_HEADERS], rows, { allowCorrectedStatusOwner: true }).status, 'invalid-schema');
});

test('filling F on an unresolved pick permits seed status recomputation without becoming runtime proof', () => {
  const rows = seededRows();
  rows[0]![8] = 'Unknown'; // A staff member just filled F; I has not been recomputed.
  const before = structuredClone(rows);
  assert.equal(validateDraftPickTable([DRAFT_PICK_HEADERS], rows).status, 'invalid-schema');
  assert.equal(validateDraftPickTable([DRAFT_PICK_HEADERS], rows, { allowCorrectedStatusOwner: true }).status, 'partial');
  assert.deepEqual(rows, before);
});

test('only an invalid-range response plus confirmed absence from an Admin workbook means missing Draft Picks', async () => {
  const gateway = {
    getValues: async () => { throw Object.assign(Error('Unable to parse range: Draft Picks'), { status: 400 }); },
    getWorkbookProperties: async () => ({ title: 'Admin', sheets: ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History']
      .map((title, sheetId) => ({ title, sheetId })) }),
  };
  const missing = await readDraftPickTracking(gateway, 'admin');
  assert.equal(missing.health.status, 'missing-tab');
  assert.equal(missing.rows, null);
  gateway.getWorkbookProperties = async () => ({ title: 'Admin', sheets: ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History', 'Draft Picks']
    .map((title, sheetId) => ({ title, sheetId })) });
  assert.equal((await readDraftPickTracking(gateway, 'admin')).health.status, 'invalid-range');
});
