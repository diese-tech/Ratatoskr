import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasScoutManagementAccess, isScoutOperationsChannel, isScoutResultsChannel } from './scoutAuthorization.js';

test('hasScoutManagementAccess permits admins, configured staff, and the target division manager or captain role', () => {
  const base = {
    isAdmin: false,
    additionalAuthorizedRoleIds: ['configured-staff'],
    divisionCaptainRoleId: 'vanaheim-captain',
    divisionManagerRoleId: 'vanaheim-manager',
    franchiseRepresentativeRoleId: 'franchise-representative',
  };

  assert.equal(hasScoutManagementAccess({ ...base, isAdmin: true, memberRoleIds: new Set() }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['configured-staff']) }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['vanaheim-captain']) }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['vanaheim-manager']) }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['franchise-representative']) }), true);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set(['alfheim-captain']) }), false);
  assert.equal(hasScoutManagementAccess({ ...base, memberRoleIds: new Set() }), false);
});

test('scout component channel checks keep controls in Scout Ops and published management in results', () => {
  assert.equal(isScoutOperationsChannel({ operationsChannelId: 'scout-ops' }, 'scout-ops'), true);
  assert.equal(isScoutOperationsChannel({ operationsChannelId: 'scout-ops' }, 'division-signups'), false);
  assert.equal(isScoutOperationsChannel({ operationsChannelId: null }, 'scout-ops'), false);
  assert.equal(isScoutResultsChannel({ resultsChannelId: 'division-results' }, 'division-results'), true);
  assert.equal(isScoutResultsChannel({ resultsChannelId: 'division-results' }, 'scout-ops'), false);
});
