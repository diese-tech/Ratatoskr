import type { DivisionRecord, DivisionStatus, ScoutConfig, ScoutSetup } from '../db/types.js';
import type { ManagedResourceStore } from './managedResourceStore.js';

export type UpsertDivisionInput = {
  guildId: string;
  divisionKey: string;
  displayName: string;
  seasonId?: number | null;
  roleId?: string | null;
  managerRoleId?: string | null;
  captainRoleId?: string | null;
  categoryId?: string | null;
};

export interface DivisionWorkspaceStore extends ManagedResourceStore {
  getDivisionByKey(guildId: string, divisionKey: string): Promise<DivisionRecord | undefined>;
  upsertDivision(input: UpsertDivisionInput): Promise<DivisionRecord>;
  setDivisionStatus(guildId: string, divisionKey: string, status: DivisionStatus): Promise<void>;
  listDivisionScoutLifecycleBlockers(guildId: string, divisionId: number): Promise<ScoutSetup[]>;
  getScoutConfig(guildId: string): Promise<ScoutConfig | undefined>;
}
