import type Database from 'better-sqlite3';
import {
  closeDueScoutSetup,
  claimScoutLifecycleRecoveryAlert,
  getScoutLifecycleCleanup,
  getScoutSetupById,
  listDueScoutLifecycleSetups,
  listPendingScoutLifecycleCleanups,
  markScoutLifecycleCleanupReconciled,
  recordScoutLifecycleCleanupAlertReference,
  recordScoutLifecycleCleanupFailure,
  recordScoutLifecycleRecoveryAttempt,
} from '../../db/index.js';
import type { ScoutLifecycleCleanupStore } from '../scoutLifecycleCleanupStore.js';

export function createSqliteScoutLifecycleCleanupStore(
  db: Database.Database,
): ScoutLifecycleCleanupStore {
  return {
    async getSetup(setupId) {
      return getScoutSetupById(db, setupId);
    },
    async getCleanup(setupId) {
      return getScoutLifecycleCleanup(db, setupId);
    },
    async listDueSetups(now, limit) {
      return listDueScoutLifecycleSetups(db, now, limit);
    },
    async listPendingCleanups(limit) {
      return listPendingScoutLifecycleCleanups(db, limit);
    },
    async closeDueSetup(setupId, now, actorUserId) {
      return closeDueScoutSetup(db, setupId, now, actorUserId);
    },
    async markDiscordReconciled(setupId, reconciledAt) {
      return markScoutLifecycleCleanupReconciled(db, setupId, reconciledAt);
    },
    async recordDiscordFailure(setupId, failedAt) {
      return recordScoutLifecycleCleanupFailure(db, setupId, failedAt);
    },
    async recordAlertReference(setupId, reference) {
      recordScoutLifecycleCleanupAlertReference(db, setupId, reference);
    },
    async claimRecoveryAlert(setupId, attemptedAt, actorUserId) {
      return claimScoutLifecycleRecoveryAlert(db, setupId, attemptedAt, actorUserId);
    },
    async recordRecoveryAttempt(setupId, attemptedAt) {
      recordScoutLifecycleRecoveryAttempt(db, setupId, attemptedAt);
    },
  };
}
