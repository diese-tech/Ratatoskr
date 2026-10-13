import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
function run(args: string[], existing = false, unresolved = false) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import',
    new URL('./draftSeedTransport.test-support.ts', import.meta.url).href, 'scripts/seed-draft-picks.ts', ...args],
  { encoding: 'utf8', env: { ...process.env, GOOGLE_SERVICE_ACCOUNT_JSON: '{}', YSL_ADMIN_SPREADSHEET_ID: 'admin',
    YSL_PUBLIC_SPREADSHEET_ID: 'public', TEST_SEED_EXISTING: existing ? 'yes' : 'no', TEST_SEED_UNRESOLVED: unresolved ? 'yes' : 'no' } });
  const trace = JSON.parse(/TEST_SEED_TRACE (.+)/.exec(result.stdout)![1]!);
  return { ...result, trace, fingerprint: /Seed plan fingerprint: (\w+)/.exec(result.stdout)?.[1] };
}
const targets = ['--expect-admin-id=admin', '--expect-public-id=public', '--summary-only'];
test('real seed CLI dry-run makes no POST; approved matching plan writes only Admin and clears after writing', () => {
  const preview = run([...targets, '--since=2026-09-01']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Parsed 96 top-4 picks/);
  assert.equal(preview.trace.posts, 0);
  assert.ok(preview.fingerprint);
  const wrong = run([...targets, '--since=2026-09-01', '--write', '--expect-plan=wrong']);
  assert.equal(wrong.status, 1);
  assert.equal(wrong.trace.posts, 0);
  const applied = run([...targets, '--since=2026-09-01', '--write', `--expect-plan=${preview.fingerprint}`]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(applied.trace.posts > 0);
  assert.equal(applied.trace.adminOnly, true);
  assert.equal(applied.trace.picksWritten, 96);
  assert.equal(applied.trace.clearedAfterWrite, true);
});

test('partial seed retains unverified history instead of clearing it for an unresolved pick', () => {
  const preview = run([...targets, '--since=2026-09-01'], true, true);
  assert.equal(preview.status, 0, preview.stderr);
  const applied = run([...targets, '--since=2026-09-01', '--write', `--expect-plan=${preview.fingerprint}`], true, true);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.trace.historyLabel, 'Not verified: Draft Picks incomplete');
});
test('real seed CLI refuses wrong workbook, missing date and unapproved season reset without a POST', () => {
  const wrong = run(['--write', '--expect-admin-id=wrong', '--expect-public-id=public']);
  assert.notEqual(wrong.status, 0);
  assert.equal(wrong.trace.posts, 0);
  const missingDate = run([...targets]);
  const rejected = run([...targets, '--write', `--expect-plan=${missingDate.fingerprint}`]);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.trace.posts, 0);
  const reset = run([...targets, '--since=2026-09-02'], true);
  const resetRejected = run([...targets, '--since=2026-09-02', '--write', `--expect-plan=${reset.fingerprint}`], true);
  assert.equal(resetRejected.status, 1);
  assert.equal(resetRejected.trace.posts, 0);
});
