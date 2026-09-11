import type { ScoutRosterSlot } from '../domain/scoutRoster.js';
import type { ScoutSignupRole } from '../domain/index.js';
import type { ScoutRosterSlotRecord, ScoutSetup, ScoutSignup } from '../db/types.js';

export type AddScoutSignupOutcome =
  | { status: 'added' }
  | { status: 'duplicate' }
  | { status: 'over_limit'; limit: number }
  | { status: 'closed' };

export type ReconcileScoutWorkingRosterInput = {
  setupId: number;
  expectedVersion: number;
  slots: readonly ScoutRosterSlot[];
  source: 'signup' | 'startup' | 'membership' | 'refresh';
  actorUserId?: string | null;
};

export type ReconcileScoutWorkingRosterOutcome = 'updated' | 'unchanged' | 'stale';

export interface ScoutSignupStore {
  getSetup(setupId: number): Promise<ScoutSetup | undefined>;
  getSetupBySignupMessageId(messageId: string): Promise<ScoutSetup | undefined>;
  listActiveSetups(): Promise<ScoutSetup[]>;
  listSignups(setupId: number): Promise<ScoutSignup[]>;
  listRosterSlots(setupId: number): Promise<ScoutRosterSlotRecord[]>;
  addSignup(setupId: number, userId: string, role: ScoutSignupRole): Promise<AddScoutSignupOutcome>;
  removeSignup(setupId: number, userId: string, role: ScoutSignupRole): Promise<void>;
  replaceSignups(
    setupId: number,
    signups: readonly { userId: string; role: ScoutSignupRole }[],
  ): Promise<boolean>;
  reconcileWorkingRoster(input: ReconcileScoutWorkingRosterInput): Promise<ReconcileScoutWorkingRosterOutcome>;
}
