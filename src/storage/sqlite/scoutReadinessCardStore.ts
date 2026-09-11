import type Database from 'better-sqlite3';
import {
  ensureScoutReadinessCard,
  getScoutCompletion,
  getScoutSetupById,
  listScoutReadinessSetupIds,
  listScoutRosterSlots,
  listScoutSignups,
  patchScoutReadinessCard,
  withdrawnScoutRosterUserIds,
} from '../../db/index.js';
import type { ScoutReadinessCardStore } from '../scoutReadinessCardStore.js';

export function createSqliteScoutReadinessCardStore(db: Database.Database): ScoutReadinessCardStore {
  return {
    async getSetup(setupId) {
      return getScoutSetupById(db, setupId);
    },
    async getCompletion(setupId) {
      return getScoutCompletion(db, setupId);
    },
    async listSignups(setupId) {
      return listScoutSignups(db, setupId);
    },
    async listRosterSlots(setupId) {
      return listScoutRosterSlots(db, setupId);
    },
    async listWithdrawnUserIds(setupId) {
      return withdrawnScoutRosterUserIds(db, setupId);
    },
    async listSetupIds() {
      return listScoutReadinessSetupIds(db);
    },
    async ensureCard(setupId) {
      return ensureScoutReadinessCard(db, setupId);
    },
    async patchCard(setupId, changes) {
      patchScoutReadinessCard(db, setupId, changes);
    },
    async promoteTelemetryToControl(setupId, telemetryMessageId) {
      return db.transaction(() => {
        const result = db.prepare(`UPDATE scout_setups
          SET control_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND control_message_id IS NULL
            AND status IN ('roster_ready', 'published', 'cancelled')
            AND EXISTS (
              SELECT 1 FROM scout_readiness_cards
              WHERE setup_id = scout_setups.id AND telemetry_message_id = ?
            )`).run(telemetryMessageId, setupId, telemetryMessageId);
        if (result.changes !== 1) return false;
        patchScoutReadinessCard(db, setupId, { telemetry_message_id: null, telemetry_attempted: 0 });
        return true;
      })();
    },
    async clearControlMessage(setupId, expectedMessageId) {
      const result = db.prepare(`UPDATE scout_setups
        SET control_message_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND control_message_id = ?`).run(setupId, expectedMessageId);
      return result.changes === 1;
    },
    async confirmControlMessage(setupId, messageId) {
      return db.transaction(() => {
        const current = getScoutSetupById(db, setupId);
        if (!current || (current.controlMessageId !== null && current.controlMessageId !== messageId)) return false;
        if (current.controlMessageId === null) {
          db.prepare(`UPDATE scout_setups
            SET control_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND control_message_id IS NULL`).run(messageId, setupId);
        }
        patchScoutReadinessCard(db, setupId, { control_attempted: 1 });
        return true;
      })();
    },
  };
}
