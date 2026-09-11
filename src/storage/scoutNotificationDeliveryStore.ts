import type {
  ScoutCoordination,
  ScoutEvent,
  ScoutGameHost,
  ScoutNotification,
  ScoutNotificationPayload,
  ScoutRosterSlotRecord,
  ScoutSetup,
} from '../db/types.js';

export interface ScoutNotificationDeliveryStore {
  getSetup(setupId: number): Promise<ScoutSetup | undefined>;
  hasCompletion(setupId: number): Promise<boolean>;
  listRosterSlots(setupId: number): Promise<ScoutRosterSlotRecord[]>;
  listGameHosts(setupId: number): Promise<ScoutGameHost[]>;
  getCoordination(setupId: number): Promise<ScoutCoordination | undefined>;
  listEvents(setupId: number): Promise<ScoutEvent[]>;
  listDueNotifications(dueAt: number, limit?: number): Promise<ScoutNotification[]>;
  listAttemptedNotifications(): Promise<ScoutNotification[]>;
  claimAttempt(notificationId: number, attemptedAt: number, payload: ScoutNotificationPayload): Promise<boolean>;
  markSent(notificationId: number, messageId: string, sentAt: number): Promise<boolean>;
  skip(notificationId: number, reason: string): Promise<boolean>;
}
