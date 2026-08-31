import assert from 'node:assert/strict';
import test from 'node:test';
import { renderScoutSignupPost } from './scoutSignupPost.js';

const setup = {
  divisionDisplayName: 'Vanaheim',
  startAt: 2_000_000_000,
  roleLimit: 2,
  note: 'Bring a positive attitude.',
};

test('scout signup preview and public post share content but only the public post pings', () => {
  const preview = renderScoutSignupPost(setup);
  const posted = renderScoutSignupPost({ ...setup, divisionRoleId: 'division-role' });

  assert.equal(preview.includes('<@&division-role>'), false);
  assert.equal(posted.startsWith('<@&division-role>\n'), true);
  assert.equal(posted.slice(posted.indexOf('\n') + 1), preview);
  assert.match(preview, /Vanaheim Scout Games/);
  assert.match(preview, /2 roles/);
});
