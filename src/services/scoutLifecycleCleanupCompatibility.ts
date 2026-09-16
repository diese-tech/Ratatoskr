import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import {
  getScoutSetupById,
} from '../db/index.js';
import type { ScoutLifecycleCleanupStore } from '../storage/index.js';
import { reconcileCancelledScoutSignupPost } from './scoutCancel.js';
import { refreshScoutStatusCard } from './scoutCardCompatibility.js';
import { ensurePostedScoutSetup } from './scoutCreate.js';
import { reconcileFinishedScoutPost } from './scoutFinish.js';
import type { ScoutLifecycleCleanupDependencies } from './scoutLifecycleCleanup.js';
import { reportOperationalError } from './operationalErrors.js';
import {
  reconcileScoutPublishedDelivery,
  reconcileScoutPublishedPresentation,
} from './scoutPublish.js';

export function sqliteScoutLifecycleCleanupDependencies(
  client: Client,
  db: Database.Database,
  storage: ScoutLifecycleCleanupStore,
  operationScope: object,
): ScoutLifecycleCleanupDependencies {
  if (!client.user) throw new Error('Ratatoskr must be ready before starting Scout lifecycle cleanup.');
  return {
    storage,
    operationScope,
    actorUserId: client.user.id,
    async recoverPostingSetup(setupId) {
      const setup = getScoutSetupById(db, setupId);
      if (setup?.status === 'posting') await ensurePostedScoutSetup(client, db, setup);
    },
    async reconcileCancelled(setupId) {
      const setup = getScoutSetupById(db, setupId);
      if (setup) await reconcileCancelledScoutSignupPost(client, db, setup, {
        reportFailure: false,
        refreshStatusCard: false,
      });
    },
    async reconcileFinished(setupId) {
      await reconcileScoutPublishedDelivery(client, db, setupId);
      await reconcileScoutPublishedPresentation(client, db, setupId, { deliverNotice: false });
      await reconcileFinishedScoutPost(client, db, setupId, {
        reportFailure: false,
        refreshStatusCard: false,
      });
    },
    async refreshStatusCard(setupId) {
      await refreshScoutStatusCard(client, db, setupId);
    },
    reportError: (context, error) => reportOperationalError(client, db, context, error),
  };
}
