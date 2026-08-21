import type Database from 'better-sqlite3';
import { migrations } from './migrations.js';

type MigrationRow = { id: number };

// Idempotent: safe to call on every startup. Already-applied migrations
// (tracked by id in schema_migrations) are skipped; only new ones run, each
// in its own transaction so a mid-migration failure can't leave the schema
// half-applied.
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const appliedIds = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => (row as MigrationRow).id),
  );

  const recordMigration = db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)');

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) continue;

    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      recordMigration.run(migration.id, migration.name);
    });
    applyMigration();
  }
}
