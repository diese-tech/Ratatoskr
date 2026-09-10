import type Database from 'better-sqlite3';
import {
  activateSeasonIfNoneActive,
  archiveSeason,
  createSeason,
  getActiveSeason,
  getSeasonByNumber,
  listSeasons,
  setSeasonDiscordCategoryId,
} from '../../db/index.js';
import type { ManagedResourceStore } from '../managedResourceStore.js';
import type { SeasonWorkspaceStore } from '../seasonWorkspaceStore.js';
import { createSqliteManagedResourceStore } from './managedResourceStore.js';

export function createSqliteSeasonWorkspaceStore(
  db: Database.Database,
  managedResources: ManagedResourceStore = createSqliteManagedResourceStore(db),
): SeasonWorkspaceStore {
  return {
    ...managedResources,
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
  };
}
