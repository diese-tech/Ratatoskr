import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

// Not part of src/config/env.ts: that shared schema is also imported by
// scripts/bootstrap-guild.ts, which has no need for a database connection.
// Keeping this validation local to the db module means only code paths that
// actually open a database are affected by it.
const DEFAULT_LOCAL_DATABASE_PATH = './data/ratatoskr.db';

export function resolveDatabasePath(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const configured = environment.DATABASE_PATH;
  if (configured && configured.trim().length > 0) return configured;
  return DEFAULT_LOCAL_DATABASE_PATH;
}

// Production must open an initialized database before any startup writes.
export function openExistingDatabase(databasePath: string | undefined): Database.Database {
  if (!databasePath || !isAbsolute(databasePath)) {
    throw new Error('Production SQLite requires DATABASE_PATH to point to an existing database using an absolute path.');
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath, { fileMustExist: true });
    if (db.pragma('quick_check', { simple: true }) !== 'ok' ||
        !db.prepare('SELECT 1 FROM schema_migrations WHERE id = 1').get()) {
      throw new Error('Database validation failed.');
    }
    initializeDatabase(db);
    return db;
  } catch {
    db?.close();
    throw new Error(
      'Production SQLite could not be opened, validated, or migrated. Verify the persistent volume and restore the existing Ratatoskr database if needed.',
    );
  }
}

// Local development and bootstrap can initialize a new database.
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

  initializeDatabase(db);
  return db;
}

function initializeDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
