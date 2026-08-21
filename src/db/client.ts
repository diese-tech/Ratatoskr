import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

// Not part of src/config/env.ts: that shared schema is also imported by
// scripts/bootstrap-guild.ts, which has no need for a database connection.
// Keeping this validation local to the db module means only code paths that
// actually open a database are affected by it.
const DEFAULT_LOCAL_DATABASE_PATH = './data/ratatoskr.db';

export function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH;
  if (configured && configured.trim().length > 0) return configured;
  return DEFAULT_LOCAL_DATABASE_PATH;
}

// Opens (creating if necessary) the SQLite database at `databasePath` and
// brings it up to the latest schema. Throws -- rather than falling back to
// an in-memory database -- if the path can't be created or opened, so a
// misconfigured DATABASE_PATH (e.g. an unmounted Railway volume) fails
// startup loudly instead of silently running without durable storage.
export function openDatabase(databasePath: string = resolveDatabasePath()): Database.Database {
  if (databasePath !== ':memory:') {
    try {
      mkdirSync(dirname(databasePath), { recursive: true });
    } catch (error) {
      throw new Error(`Cannot create directory for DATABASE_PATH "${databasePath}": ${(error as Error).message}`);
    }
  }

  let db: Database.Database;
  try {
    db = new Database(databasePath);
  } catch (error) {
    throw new Error(`Cannot open database at DATABASE_PATH "${databasePath}": ${(error as Error).message}`);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
