import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasScoutManagementAccess } from './scoutAuthorization.js';

test('hasScoutManagementAccess permits admins, configured staff, and only the target division captain role', () => {
  const base = {
    isAdmin: false,
    additionalAuthorizedRoleIds: ['configured-staff'],
    divisionCaptainAccessRoleId: 'vanaheim-captain',
  };

  assert.equal(hasScoutManagementAccess({ ...base, isAdmin: true, memberRoleIds: new Set() }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['configured-staff']) }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['vanaheim-captain']) }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['alfheim-captain']) }), false);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set() }), false);
});
