import assert from 'node:assert/strict';
import test from 'node:test';
import { publicDraftHighlightCells, hasDraftHistoryRule, DRAFT_ROW_YELLOW } from './draftPickPresentation.js';
import { createScheduledLeagueSheetsGateway, createLeagueSheetsReadSchedule } from './leagueSheets.js';

function grid() {
  const rows = Array.from({ length: 22 }, () => Array<string | number>(15).fill(''));
  rows[13]![5] = 'The Sewer'; rows[15]![5] = 'Cap:';
  for (let round = 1; round <= 6; round++) { rows[15 + round]![5] = round; rows[15 + round]![6] = `Occupant ${round}`; }
  return rows;
}
test('a matching formula on another range or color is not proof of a yellow history-row rule', () => {
  const rule = { ranges: [{ sheetId: 7, startRowIndex: 5, startColumnIndex: 0, endColumnIndex: 13 }],
    booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$M6<>""' }] }, format: { backgroundColorStyle: { rgbColor: { ...DRAFT_ROW_YELLOW } } } } };
  assert.equal(hasDraftHistoryRule(7, [rule]), true);
  assert.equal(hasDraftHistoryRule(8, [rule]), false);
  rule.ranges[0]!.endColumnIndex = 1;
  assert.equal(hasDraftHistoryRule(7, [rule]), false);
  rule.ranges[0]!.endColumnIndex = 13;
  rule.booleanRule.format.backgroundColorStyle.rgbColor.green = 0;
  assert.equal(hasDraftHistoryRule(7, [rule]), false);
});
test('highlight the original protected slot independently of replacement or returning occupant', () => {
  const rows = grid(), slot = { division: 'Svartalfheim', team: 'The Sewer', round: '2' };
  const expected = [{ title: 'Svartalfheim Roster', row: 18, column: 6, range: "'Svartalfheim Roster'!G18" }];
  assert.deepEqual(publicDraftHighlightCells([slot, slot], { Svartalfheim: rows }), expected);
  rows[17]![6] = 'Replacement';
  assert.deepEqual(publicDraftHighlightCells([slot], { Svartalfheim: rows }), expected);
  rows[17]![6] = 'Original returns';
  assert.deepEqual(publicDraftHighlightCells([slot], { Svartalfheim: rows }), expected);
  for (const invalid of ['0', '5', 'Cap:']) assert.throws(() => publicDraftHighlightCells([{ ...slot, round: invalid }], { Svartalfheim: rows }));
  rows[17]![5] = 3;
  assert.throws(() => publicDraftHighlightCells([slot], { Svartalfheim: rows }), /layout/i);
});
test('real gateway colors only roster-name text and adds an idempotent yellow history-row rule', async () => {
  const posts: any[] = []; let rules: any[] = [];
  const gateway = createScheduledLeagueSheetsGateway(createLeagueSheetsReadSchedule({ now: () => 0, wait: async () => {} }),
    async <T>(request: { url: string; method?: string; data?: any }) => {
      if (request.method === 'POST') { posts.push(request); if (request.url.includes('/admin:')) rules.push(request.data.requests[0].addConditionalFormatRule.rule); return {} as T; }
      if (request.url.includes('/values:batchGet')) return { valueRanges: [{ values: grid() }] } as T;
      return { sheets: [{ properties: { title: request.url.includes('/admin?') ? 'Transaction History' : 'Svartalfheim Roster', sheetId: 7 }, conditionalFormats: rules }] } as T;
    });
  await gateway.ensureDraftPickHighlights!('admin', 'public', [{ division: 'Svartalfheim', team: 'The Sewer', round: '2' }]);
  const name = posts.find(post => post.url.includes('/public:')).data.requests[0].repeatCell;
  assert.deepEqual(name.range, { sheetId: 7, startRowIndex: 17, endRowIndex: 18, startColumnIndex: 6, endColumnIndex: 7 });
  assert.equal(name.fields, 'userEnteredFormat.textFormat.foregroundColorStyle');
  assert.deepEqual(name.cell, { userEnteredFormat: { textFormat: { foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 0 } } } } });
  assert.deepEqual(rules[0].ranges, [{ sheetId: 7, startRowIndex: 5, startColumnIndex: 0, endColumnIndex: 13 }]);
  assert.equal(rules[0].booleanRule.condition.values[0].userEnteredValue, '=$M6<>""');
  await gateway.ensureDraftPickHighlights!('admin', 'public', [{ division: 'Svartalfheim', team: 'The Sewer', round: '2' }]);
  assert.equal(posts.filter(post => post.url.includes('/admin:')).length, 1);
});

test('changed native slot labels block both highlight projections before any write', async () => {
  let posts = 0; const rows = grid(); rows[17]![5] = 3;
  const gateway = createScheduledLeagueSheetsGateway(createLeagueSheetsReadSchedule({ now: () => 0, wait: async () => {} }), async <T>(request: { url: string; method?: string }) => {
    if (request.method === 'POST') { posts++; return {} as T; }
    if (request.url.includes('/values:batchGet')) return { valueRanges: [{ values: rows }] } as T;
    return { sheets: [{ properties: { title: request.url.includes('/admin?') ? 'Transaction History' : 'Svartalfheim Roster', sheetId: 7 } }] } as T;
  });
  await assert.rejects(() => gateway.ensureDraftPickHighlights!('admin', 'public', [{ division: 'Svartalfheim', team: 'The Sewer', round: '2' }]), /layout/i);
  assert.equal(posts, 0);
});

test('a lost public-color response can retry without duplicating the history rule', async () => {
  let publicPosts = 0, adminPosts = 0; const rules: any[] = [];
  const gateway = createScheduledLeagueSheetsGateway(createLeagueSheetsReadSchedule({ now: () => 0, wait: async () => {} }), async <T>(request: { url: string; method?: string; data?: any }) => {
    if (request.method === 'POST') {
      if (request.url.includes('/public:')) { if (++publicPosts === 1) throw Object.assign(Error('response lost'), { status: 503 }); }
      else { adminPosts++; rules.push(request.data.requests[0].addConditionalFormatRule.rule); }
      return {} as T;
    }
    if (request.url.includes('/values:batchGet')) return { valueRanges: [{ values: grid() }] } as T;
    return { sheets: [{ properties: { title: request.url.includes('/admin?') ? 'Transaction History' : 'Svartalfheim Roster', sheetId: 7 }, conditionalFormats: rules }] } as T;
  });
  const slots = [{ division: 'Svartalfheim', team: 'The Sewer', round: '2' }];
  await assert.rejects(() => gateway.ensureDraftPickHighlights!('admin', 'public', slots), /response lost/);
  await gateway.ensureDraftPickHighlights!('admin', 'public', slots);
  rules[0].booleanRule.format.backgroundColorStyle.rgbColor.green = 0.949999988;
  await gateway.ensureDraftPickHighlights!('admin', 'public', slots);
  assert.equal(publicPosts, 3);
  assert.equal(adminPosts, 1);
});
