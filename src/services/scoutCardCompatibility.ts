import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { createSqliteScoutReadinessCardStore } from '../storage/index.js';
import {
  reconcileScoutStatusCards as reconcileWithStorage,
  refreshScoutStatusCard as refreshWithStorage,
  refreshScoutStatusCardSafely as refreshSafelyWithStorage,
  type ScoutCardDependencies,
} from './scoutCardLifecycle.js';
import { reportOperationalError } from './operationalErrors.js';

/** Transitional SQLite wiring for Scout workflows that have not reached their B5 storage slice. */
export function sqliteScoutCardDependencies(db: Database.Database): ScoutCardDependencies {
  return {
    storage: createSqliteScoutReadinessCardStore(db),
    operationScope: db,
    reportError: (client, context, error) => reportOperationalError(client, db, context, error),
  };
}

export function refreshScoutStatusCard(client: Client, db: Database.Database, setupId: number) {
  return refreshWithStorage(client, sqliteScoutCardDependencies(db), setupId);
}

export function refreshScoutStatusCardSafely(client: Client, db: Database.Database, setupId: number) {
  return refreshSafelyWithStorage(client, sqliteScoutCardDependencies(db), setupId);
}

export function reconcileScoutStatusCards(client: Client, db: Database.Database) {
  return reconcileWithStorage(client, sqliteScoutCardDependencies(db));
}
