import type Database from 'better-sqlite3';
import {
  getDivisionByKey,
  getScoutConfig,
  listDivisionScoutLifecycleBlockers,
  setDivisionStatus,
  upsertDivision,
} from '../../db/index.js';
import type { DivisionWorkspaceStore } from '../divisionWorkspaceStore.js';
import type { ManagedResourceStore } from '../managedResourceStore.js';
import { createSqliteManagedResourceStore } from './managedResourceStore.js';

export function createSqliteDivisionWorkspaceStore(
  db: Database.Database,
  managedResources: ManagedResourceStore = createSqliteManagedResourceStore(db),
): DivisionWorkspaceStore {
  return {
    ...managedResources,
    async getDivisionByKey(guildId, divisionKey) {
      return getDivisionByKey(db, guildId, divisionKey);
    },
    async upsertDivision(input) {
      return upsertDivision(db, input);
    },
    async setDivisionStatus(guildId, divisionKey, status) {
      setDivisionStatus(db, guildId, divisionKey, status);
    },
    async listDivisionScoutLifecycleBlockers(guildId, divisionId) {
      return listDivisionScoutLifecycleBlockers(db, guildId, divisionId);
    },
    async getScoutConfig(guildId) {
      return getScoutConfig(db, guildId);
    },
  };
}
