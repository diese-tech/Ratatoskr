import type Database from 'better-sqlite3';
import {
  activateSeasonIfNoneActive,
  archiveSeason,
  createSeason,
  getActiveManagedResourceByLogicalKey,
  getActiveSeason,
  getSeasonByNumber,
  insertManagedResource,
  listManagedResourcesByDomain,
  listSeasons,
  markManagedResourceObsolete,
  setSeasonDiscordCategoryId,
} from '../../db/index.js';
import type { SeasonWorkspaceStore } from '../seasonWorkspaceStore.js';

export function createSqliteSeasonWorkspaceStore(db: Database.Database): SeasonWorkspaceStore {
  return {
    async createSeason(input) {
      return createSeason(db, input);
    },
    async getSeasonByNumber(guildId, seasonNumber) {
      return getSeasonByNumber(db, guildId, seasonNumber);
    },
    async getActiveSeason(guildId) {
      return getActiveSeason(db, guildId);
    },
    async archiveSeason(guildId, seasonId) {
      return archiveSeason(db, guildId, seasonId);
    },
    async listSeasons(guildId) {
      return listSeasons(db, guildId);
    },
    async activateSeasonIfNoneActive(guildId, seasonId) {
      return activateSeasonIfNoneActive(db, guildId, seasonId);
    },
    async setSeasonDiscordCategoryId(seasonId, discordCategoryId) {
      setSeasonDiscordCategoryId(db, seasonId, discordCategoryId);
    },
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
  };
}
