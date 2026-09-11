import type Database from 'better-sqlite3';
import {
  claimScoutNotificationAttempt,
  getScoutCompletion,
  getScoutCoordination,
  getScoutSetupById,
  listAttemptedScoutNotifications,
  listDueScoutNotifications,
  listScoutEvents,
  listScoutGameHosts,
  listScoutRosterSlots,
  markScoutNotificationSent,
  skipScheduledScoutNotification,
} from '../../db/index.js';
import type { ScoutNotificationDeliveryStore } from '../scoutNotificationDeliveryStore.js';

export function createSqliteScoutNotificationDeliveryStore(
  db: Database.Database,
): ScoutNotificationDeliveryStore {
  return {
    async getSetup(setupId) {
      return getScoutSetupById(db, setupId);
    },
    async hasCompletion(setupId) {
      return Boolean(getScoutCompletion(db, setupId));
    },
    async listRosterSlots(setupId) {
      return listScoutRosterSlots(db, setupId);
    },
    async listGameHosts(setupId) {
      return listScoutGameHosts(db, setupId);
    },
    async getCoordination(setupId) {
      return getScoutCoordination(db, setupId);
    },
    async listEvents(setupId) {
      return listScoutEvents(db, setupId);
    },
    async listDueNotifications(dueAt, limit) {
      return listDueScoutNotifications(db, dueAt, limit);
    },
    async listAttemptedNotifications() {
      return listAttemptedScoutNotifications(db);
    },
    async claimAttempt(notificationId, attemptedAt, payload) {
      return claimScoutNotificationAttempt(db, notificationId, attemptedAt, payload);
    },
    async markSent(notificationId, messageId, sentAt) {
      return markScoutNotificationSent(db, notificationId, messageId, sentAt);
    },
    async skip(notificationId, reason) {
      return skipScheduledScoutNotification(db, notificationId, reason);
    },
  };
}
