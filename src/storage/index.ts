import type Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../db/client.js';
import type { SeasonWorkspaceStore } from './seasonWorkspaceStore.js';
import { createSqliteSeasonWorkspaceStore } from './sqlite/seasonWorkspaceStore.js';

export type DatabaseBackend = 'sqlite' | 'postgres';

type StorageEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveDatabaseBackend(environment: StorageEnvironment = process.env): DatabaseBackend {
  const configured = environment.DATABASE_BACKEND?.trim().toLowerCase();
  if (!configured) return 'sqlite';
  if (configured === 'sqlite' || configured === 'postgres') return configured;
  throw new Error('DATABASE_BACKEND must be either "sqlite" or "postgres".');
}

export interface ApplicationStorage {
  readonly backend: 'sqlite';
  // Transitional and intentionally named: the remaining B5 slices must move
  // callers off this synchronous SQLite handle before Postgres can be enabled.
  readonly legacyDatabase: Database.Database;
  readonly seasons: SeasonWorkspaceStore;
  close(): Promise<void>;
}

export type OpenApplicationStorageOptions = {
  environment?: StorageEnvironment;
  sqlitePath?: string;
};

export function openApplicationStorage(options: OpenApplicationStorageOptions = {}): ApplicationStorage {
  const backend = resolveDatabaseBackend(options.environment);
  if (backend === 'postgres') {
    throw new Error(
      'Postgres storage is not implemented yet. Set DATABASE_BACKEND=sqlite; DATABASE_URL alone never selects a backend.',
    );
  }

  const db = openDatabase(options.sqlitePath);
  return {
    backend,
    legacyDatabase: db,
    seasons: createSqliteSeasonWorkspaceStore(db),
    async close() {
      closeDatabase(db);
    },
  };
}

export { SeasonAlreadyActiveError } from './seasonWorkspaceStore.js';
export type { CreateSeasonInput, SeasonWorkspaceStore } from './seasonWorkspaceStore.js';
export { createSqliteSeasonWorkspaceStore } from './sqlite/seasonWorkspaceStore.js';
