import type Database from 'better-sqlite3';
import {
  ensureScoutConfig,
  setScoutAuthorizedRoleIds,
  setScoutEmojiByRole,
  setScoutOperationsChannel,
  setScoutTimezone,
} from '../../db/index.js';
import type { ScoutConfigurationStore } from '../scoutConfigurationStore.js';

export function createSqliteScoutConfigurationStore(db: Database.Database): ScoutConfigurationStore {
  return {
    async ensureScoutConfig(guildId) {
      return ensureScoutConfig(db, guildId);
    },
    async setScoutAuthorizedRoleIds(guildId, authorizedRoleIds) {
      return setScoutAuthorizedRoleIds(db, guildId, authorizedRoleIds);
    },
    async setScoutOperationsChannel(guildId, operationsCategoryId, operationsChannelId) {
      return setScoutOperationsChannel(db, guildId, operationsCategoryId, operationsChannelId);
    },
    async setScoutTimezone(guildId, timezone) {
      return setScoutTimezone(db, guildId, timezone);
    },
    async setScoutEmojiByRole(guildId, emojiByRole) {
      return setScoutEmojiByRole(db, guildId, emojiByRole);
    },
  };
}
