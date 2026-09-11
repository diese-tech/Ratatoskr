import type Database from 'better-sqlite3';
import {
  addScoutSignup,
  getScoutSetupById,
  getScoutSetupBySignupMessageId,
  listActiveScoutSetups,
  listScoutRosterSlots,
  listScoutSignups,
  reconcileScoutWorkingRoster,
  removeScoutSignup,
  replaceScoutSignups,
} from '../../db/index.js';
import type { ScoutSignupStore } from '../scoutSignupStore.js';

export function createSqliteScoutSignupStore(db: Database.Database): ScoutSignupStore {
  return {
    async getSetup(setupId) {
      return getScoutSetupById(db, setupId);
    },
    async getSetupBySignupMessageId(messageId) {
      return getScoutSetupBySignupMessageId(db, messageId);
    },
    async listActiveSetups() {
      return listActiveScoutSetups(db);
    },
    async listSignups(setupId) {
      return listScoutSignups(db, setupId);
    },
    async listRosterSlots(setupId) {
      return listScoutRosterSlots(db, setupId);
    },
    async addSignup(setupId, userId, role) {
      return addScoutSignup(db, setupId, userId, role);
    },
    async removeSignup(setupId, userId, role) {
      removeScoutSignup(db, setupId, userId, role);
    },
    async replaceSignups(setupId, signups) {
      return replaceScoutSignups(db, setupId, signups);
    },
    async reconcileWorkingRoster(input) {
      return reconcileScoutWorkingRoster(db, input);
    },
  };
}
