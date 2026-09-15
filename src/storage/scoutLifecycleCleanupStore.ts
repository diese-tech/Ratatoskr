import type { ScoutLifecycleCleanup, ScoutSetup } from '../db/types.js';
import type { CloseDueScoutSetupOutcome } from '../db/repositories/scoutLifecycleCleanups.js';

export interface ScoutLifecycleCleanupStore {
  getSetup(setupId: number): Promise<ScoutSetup | undefined>;
  getCleanup(setupId: number): Promise<ScoutLifecycleCleanup | undefined>;
  listDueSetups(now: number, limit?: number): Promise<ScoutSetup[]>;
  listPendingCleanups(limit?: number): Promise<ScoutLifecycleCleanup[]>;
  closeDueSetup(setupId: number, now: number, actorUserId: string): Promise<CloseDueScoutSetupOutcome>;
  markDiscordReconciled(setupId: number, reconciledAt: number): Promise<boolean>;
  recordDiscordFailure(setupId: number, failedAt: number): Promise<boolean>;
  recordAlertReference(setupId: number, reference: string): Promise<void>;
  claimRecoveryAlert(setupId: number, attemptedAt: number, actorUserId: string): Promise<boolean>;
}
