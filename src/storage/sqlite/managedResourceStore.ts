import type Database from 'better-sqlite3';
import {
  getActiveManagedResourceByLogicalKey,
  insertManagedResource,
  listManagedResourcesByDomain,
  markManagedResourceObsolete,
  markManagedResourcePurged,
  setManagedResourceParent,
} from '../../db/index.js';
import type { ManagedResourceStore } from '../managedResourceStore.js';

export function createSqliteManagedResourceStore(db: Database.Database): ManagedResourceStore {
  return {
    async getActiveManagedResourceByLogicalKey(guildId, logicalKey) {
      return getActiveManagedResourceByLogicalKey(db, guildId, logicalKey);
    },
    async listManagedResourcesByDomain(guildId, scaffoldDomain, status) {
      return listManagedResourcesByDomain(db, guildId, scaffoldDomain, status);
    },
    async insertManagedResource(input) {
      return insertManagedResource(db, input);
    },
    async markManagedResourceObsolete(id) {
      markManagedResourceObsolete(db, id);
    },
    async setManagedResourceParent(id, parentResourceId) {
      setManagedResourceParent(db, id, parentResourceId);
    },
    async markManagedResourcePurged(id) {
      markManagedResourcePurged(db, id);
    },
  };
}
