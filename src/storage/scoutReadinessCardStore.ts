import type { ScoutCompletion } from '../db/repositories/scoutCompletions.js';
import type { ScoutReadinessCard } from '../db/repositories/scoutReadinessCards.js';
import type { ScoutRosterSlotRecord, ScoutSetup, ScoutSignup } from '../db/types.js';

export type ScoutReadinessCardPatch = Partial<Omit<ScoutReadinessCard, 'setup_id'>>;

export interface ScoutReadinessCardStore {
  getSetup(setupId: number): Promise<ScoutSetup | undefined>;
  getCompletion(setupId: number): Promise<ScoutCompletion | undefined>;
  listSignups(setupId: number): Promise<ScoutSignup[]>;
  listRosterSlots(setupId: number): Promise<ScoutRosterSlotRecord[]>;
  listWithdrawnUserIds(setupId: number): Promise<string[]>;
  listSetupIds(): Promise<number[]>;
  ensureCard(setupId: number): Promise<ScoutReadinessCard>;
  patchCard(setupId: number, changes: ScoutReadinessCardPatch): Promise<void>;
  promoteTelemetryToControl(setupId: number, telemetryMessageId: string): Promise<boolean>;
  clearControlMessage(setupId: number, expectedMessageId: string): Promise<boolean>;
  confirmControlMessage(setupId: number, messageId: string): Promise<boolean>;
}
