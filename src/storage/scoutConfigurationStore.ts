import type { ScoutConfig } from '../db/types.js';
import type { ScoutRole } from '../domain/scoutRoles.js';

export interface ScoutConfigurationStore {
  ensureScoutConfig(guildId: string): Promise<ScoutConfig>;
  setScoutAuthorizedRoleIds(guildId: string, authorizedRoleIds: readonly string[]): Promise<ScoutConfig>;
  setScoutOperationsChannel(
    guildId: string,
    operationsCategoryId: string,
    operationsChannelId: string,
  ): Promise<ScoutConfig>;
  setScoutTimezone(guildId: string, timezone: string): Promise<ScoutConfig>;
  setScoutEmojiByRole(
    guildId: string,
    emojiByRole: Record<ScoutRole, string> & { fill?: string | null },
  ): Promise<ScoutConfig>;
}
