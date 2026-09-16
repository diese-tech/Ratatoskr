import type { ScoutLifecycleCleanup, ScoutSetup } from '../db/types.js';
import type { CloseDueScoutSetupOutcome } from '../db/repositories/scoutLifecycleCleanups.js';

export interface ScoutLifecycleCleanupStore {
  getSetup(setupId: number): Promise<ScoutSetup | undefined>;
  getCleanup(setupId: number): Promise<ScoutLifecycleCleanup | undefined>;
  listDueSetups(now: number, limit?: number): Promise<ScoutSetup[]>;
  listPendingCleanups(limit?: number): Promise<ScoutLifecycleCleanup[]>;
  closeDueSetup(setupId: number, now: number, actorUserId: string): Promise<CloseDueScoutSetupOutcome>;
  markDiscordReconciled(setupId: number, reconciledAt: number): Promise<boolean>;
  recordDiscordFailure(setupId: number, failedAt: number): Promise<string | null>;
  markDiscordAlertDelivered(setupId: number, reference: string, deliveredAt: number): Promise<boolean>;
  claimRecoveryAlert(setupId: number, attemptedAt: number): Promise<string | null>;
  markRecoveryAlertDelivered(setupId: number, reference: string, deliveredAt: number, actorUserId: string): Promise<boolean>;
  recordRecoveryAttempt(setupId: number, attemptedAt: number): Promise<void>;
}
