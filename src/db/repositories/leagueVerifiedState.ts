import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DiscordLeagueMember, LeagueSnapshot } from '../../domain/leagueOperations.js';
export type VerifiedMember = {
  member: DiscordLeagueMember | null;
  managedRoleIds: string[];
  names: LeagueSnapshot['names'];
  rosters: LeagueSnapshot['rosters'];
  publicRosters: LeagueSnapshot['publicRosters'];
};
export function memberMarker(member: DiscordLeagueMember | null, managedRoleIds: string[]): string {
  return JSON.stringify(
    member
      ? { displayName: member.displayName, roleIds: member.roleIds.filter((id) => managedRoleIds.includes(id)).sort() }
      : null,
  );
}
export function getVerifiedLeagueMember(
  db: Database.Database,
  guildId: string,
  discordId: string,
): VerifiedMember | undefined {
  const row = db
    .prepare('SELECT state_json FROM league_verified_members WHERE guild_id=? AND discord_id=?')
    .get(guildId, discordId) as { state_json: string } | undefined;
  return row && (JSON.parse(row.state_json) as VerifiedMember);
}
export function cacheVerifiedLeagueMember(
  db: Database.Database,
  guildId: string,
  discordId: string,
  snapshot: LeagueSnapshot,
  now: Date,
  source: string,
): void {
  const state: VerifiedMember = {
    member: snapshot.discordMembers.find((m) => m.discordId === discordId) ?? null,
    managedRoleIds: [
      ...new Set([
        snapshot.freeAgentRoleId,
        ...snapshot.teams.filter((t) => t.active).flatMap((t) => [t.teamRoleId, t.divisionRoleId]),
      ]),
    ].sort(),
    names: snapshot.names.filter((n) => n.discordId === discordId),
    rosters: snapshot.rosters.filter((r) => r.discordId === discordId),
    publicRosters: snapshot.publicRosters,
  };
  const json = JSON.stringify(state);
  db.prepare(
    `INSERT INTO league_verified_members VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET state_json=excluded.state_json,fingerprint=excluded.fingerprint,verified_at=excluded.verified_at,source=excluded.source`,
  ).run(guildId, discordId, json, createHash('sha256').update(json).digest('hex'), now.toISOString(), source);
}
export function replaceLeagueFindings(
  db: Database.Database,
  guildId: string,
  resourceKey: string,
  findings: string[],
  now: Date,
): void {
  if (!findings.length) {
    db.prepare('DELETE FROM league_findings WHERE guild_id=? AND resource_key=?').run(guildId, resourceKey);
    return;
  }
  db.prepare(
    `INSERT INTO league_findings VALUES(?,?,?,?) ON CONFLICT(guild_id,resource_key) DO UPDATE SET findings_json=excluded.findings_json,checked_at=excluded.checked_at`,
  ).run(guildId, resourceKey, JSON.stringify(findings), now.toISOString());
}
export function listLeagueFindings(
  db: Database.Database,
  guildId: string,
): Array<{ resourceKey: string; findings: string[] }> {
  return (
    db
      .prepare('SELECT resource_key,findings_json FROM league_findings WHERE guild_id=? ORDER BY resource_key')
      .all(guildId) as Array<{ resource_key: string; findings_json: string }>
  ).map((r) => ({ resourceKey: r.resource_key, findings: (JSON.parse(r.findings_json) as unknown[]).map((finding) =>
    typeof finding === 'string' ? finding : 'Stored roster finding could not be read. A fresh full audit is required before resolving it.') }));
}
export function replaceFullLeagueFindings(
  db: Database.Database,
  guildId: string,
  snapshot: LeagueSnapshot,
  diagnostics: string[],
  humanized: string[],
  now: Date,
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM league_findings WHERE guild_id=?').run(guildId);
    const ids = [
      ...new Set([
        ...snapshot.names.map((n) => n.discordId),
        ...snapshot.rosters.map((r) => r.discordId),
        ...snapshot.discordMembers.map((m) => m.discordId),
      ]),
    ];
    const groups = new Map<string, string[]>();
    diagnostics.forEach((diagnostic, index) => {
      const id = ids.find((id) => diagnostic.split(/\s+/).includes(id));
      const key = id ? `member:${id}` : `sheet:${diagnostic}`;
      groups.set(key, [...(groups.get(key) ?? []), humanized[index]!]);
    });
    for (const [key, findings] of groups) replaceLeagueFindings(db, guildId, key, [...new Set(findings)], now);
    for (const id of ids) cacheVerifiedLeagueMember(db, guildId, id, snapshot, now, 'full');
  })();
}

export function listVerifiedLeagueMemberIds(db: Database.Database, guildId: string): string[] {
  return (
    db.prepare('SELECT discord_id FROM league_verified_members WHERE guild_id=?').all(guildId) as Array<{
      discord_id: string;
    }>
  ).map((row) => row.discord_id);
}
