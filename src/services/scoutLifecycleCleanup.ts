import type { ScoutLifecycleCleanup } from '../db/types.js';
import type { ScoutLifecycleCleanupStore } from '../storage/index.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';
import type { OperationContext } from './operationalErrors.js';

export type ScoutLifecycleCleanupDependencies = {
  storage: ScoutLifecycleCleanupStore;
  operationScope: object;
  actorUserId: string;
  closeDueSetup?: ScoutLifecycleCleanupStore['closeDueSetup'];
  recoverPostingSetup: (setupId: number) => Promise<void>;
  reconcileCancelled: (setupId: number) => Promise<void>;
  reconcileFinished: (setupId: number) => Promise<void>;
  refreshStatusCard: (setupId: number) => Promise<void>;
  reportError: (context: OperationContext, error: unknown, reference: string) => Promise<{ reference: string; staffDelivered: boolean }>;
};

async function reconcileCleanup(
  dependencies: ScoutLifecycleCleanupDependencies,
  cleanup: ScoutLifecycleCleanup,
  now: number,
): Promise<void> {
  const setup = await dependencies.storage.getSetup(cleanup.setupId);
  if (!setup) return;
  const release = tryAcquireDivisionOperation(
    dependencies.operationScope,
    setup.guildId,
    setup.divisionKey,
  );
  if (!release) return;
  try {
    try {
      if (cleanup.action === 'cancelled') await dependencies.reconcileCancelled(setup.id);
      else await dependencies.reconcileFinished(setup.id);
      await dependencies.refreshStatusCard(setup.id);
      await dependencies.storage.markDiscordReconciled(setup.id, now);
    } catch (error) {
      const reference = await dependencies.storage.recordDiscordFailure(setup.id, now);
      if (reference) {
        const report = await dependencies.reportError({
          guildId: setup.guildId,
          setupId: setup.id,
          division: setup.divisionDisplayName,
          action: cleanup.action === 'cancelled'
            ? 'Automatic Scout cancellation cleanup'
            : 'Automatic Scout finish cleanup',
          next: 'Ratatoskr will retry the existing Discord post and card edits automatically.',
        }, error, reference);
        if (report.staffDelivered) {
          await dependencies.storage.markDiscordAlertDelivered(setup.id, reference, now);
        }
      }
    }
  } finally {
    release();
  }
}

export async function processDueScoutLifecycleCleanups(
  dependencies: ScoutLifecycleCleanupDependencies,
  now = Math.floor(Date.now() / 1_000),
  limit = 25,
): Promise<boolean> {
  const due = await dependencies.storage.listDueSetups(now, limit);
  let readyForNotifications = true;
  for (const setup of due) {
    const release = tryAcquireDivisionOperation(
      dependencies.operationScope,
      setup.guildId,
      setup.divisionKey,
    );
    if (!release) {
      readyForNotifications = false;
      continue;
    }
    try {
      if (setup.status === 'posting' || setup.status === 'posting_failed') {
        await dependencies.storage.recordRecoveryAttempt(setup.id, now);
        try { await dependencies.recoverPostingSetup(setup.id); } catch { /* The unresolved state is reported below. */ }
        const current = await dependencies.storage.getSetup(setup.id);
        if (current?.status === 'posting' || current?.status === 'posting_failed') {
          const reference = await dependencies.storage.claimRecoveryAlert(setup.id, now);
          if (reference) {
            const report = await dependencies.reportError({
              guildId: setup.guildId,
              setupId: setup.id,
              division: setup.divisionDisplayName,
              action: 'Automatic Scout lifecycle recovery',
              next: 'The setup remains in publication recovery and was not automatically closed.',
            }, new Error(`Overdue Scout setup remains ${current.status}.`), reference);
            if (report.staffDelivered) {
              await dependencies.storage.markRecoveryAlertDelivered(setup.id, reference, now, dependencies.actorUserId);
            }
          }
          continue;
        }
      }
      await (dependencies.closeDueSetup ?? dependencies.storage.closeDueSetup)(
        setup.id,
        now,
        dependencies.actorUserId,
      );
    } finally {
      release();
    }
  }
  const remaining = await dependencies.storage.listDueSetups(now, 1);
  if (remaining.some((setup) => ['open', 'roster_ready', 'published'].includes(setup.status))) {
    readyForNotifications = false;
  }
  for (const cleanup of await dependencies.storage.listPendingCleanups(limit)) {
    await reconcileCleanup(dependencies, cleanup, now);
  }
  return readyForNotifications;
}
