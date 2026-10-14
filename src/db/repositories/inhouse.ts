import type Database from 'better-sqlite3';

export type InhouseConfig = {
  guildId: string; categoryId: string; roleName: string; channelName: string;
  roleId: string | null; channelId: string | null; messageId: string | null; emoji: string;
  provisioningRef: string;
};
export function getInhouseConfig(db: Database.Database, guildId: string): InhouseConfig | undefined {
  return db.prepare(`SELECT guild_id guildId, category_id categoryId, role_name roleName,
    channel_name channelName, role_id roleId, channel_id channelId,
    optin_message_id messageId, optin_emoji emoji, provisioning_ref provisioningRef FROM inhouse_config WHERE guild_id=?`)
    .get(guildId) as InhouseConfig | undefined;
}
export function beginInhouseConfiguration(db: Database.Database,
  input: Pick<InhouseConfig, 'guildId' | 'categoryId' | 'roleName' | 'channelName' | 'emoji'>): InhouseConfig {
  const existing = getInhouseConfig(db, input.guildId);
  if (existing && ['categoryId', 'roleName', 'channelName', 'emoji'].some(
    key => existing[key as keyof InhouseConfig] !== input[key as keyof typeof input])) {
    throw new Error('Inhouse ownership is already bound to another configuration. Review it before changing targets.');
  }
  db.prepare(`INSERT OR IGNORE INTO inhouse_config
    (guild_id,category_id,role_name,channel_name,optin_emoji) VALUES (?,?,?,?,?)`)
    .run(input.guildId, input.categoryId, input.roleName, input.channelName, input.emoji);
  return getInhouseConfig(db, input.guildId)!;
}
export function bindInhouseResource(db: Database.Database, guildId: string,
  field: 'roleId' | 'channelId' | 'messageId', id: string): InhouseConfig {
  const columns = { roleId: 'role_id', channelId: 'channel_id', messageId: 'optin_message_id' };
  const column = columns[field];
  const result = db.prepare(`UPDATE inhouse_config SET ${column}=?
    WHERE guild_id=? AND (${column} IS NULL OR ${column}=?)`).run(id, guildId, id);
  if (result.changes !== 1) throw new Error('Inhouse resource ownership changed; preserve the original binding.');
  return getInhouseConfig(db, guildId)!;
}
export type InhouseSubscription = { userId: string; subscribed: number; revision: number; pending: number; nextAttemptAt: number };
export function setInhouseSubscription(db: Database.Database, guildId: string, userId: string, subscribed: boolean) {
  db.prepare(`INSERT INTO inhouse_subscriptions (guild_id,user_id,subscribed) VALUES (?,?,?)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET subscribed=excluded.subscribed,
      revision=revision+1,pending=1,next_attempt_at=0`).run(guildId, userId, Number(subscribed));
}
export function listInhouseSubscriptions(db: Database.Database, guildId: string): InhouseSubscription[] {
  return db.prepare(`SELECT user_id userId,subscribed,revision,pending,next_attempt_at nextAttemptAt
    FROM inhouse_subscriptions WHERE guild_id=? ORDER BY user_id`).all(guildId) as InhouseSubscription[];
}
