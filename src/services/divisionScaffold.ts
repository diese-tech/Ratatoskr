import type { ManagedResourceType } from '../db/types.js';

// Pure key-building, validation, and safety-check logic for the division
// domain (#31 Phase 1 PR 2) -- kept free of discord.js, mirroring
// serverBootstrap.ts, so it's testable without a live Discord connection.

// Logical keys are authored (config's `key` field on each division and
// channel template entry), never derived from a division's display name --
// see #31 Defect 1/Defect 2. The division key sits directly after the
// `division:` domain prefix (not nested under a resource-type segment like
// server's `server:role:<key>`) specifically so `division:<key>:` is a safe,
// unambiguous prefix for "every resource belonging to this division" --
// used by resourcesForDivision below for status reporting and the
// archive/delete safety split.
export function divisionRoleLogicalKey(divisionKey: string): string {
  return `division:${divisionKey}:role`;
}

export function divisionManagerRoleLogicalKey(divisionKey: string): string {
  return `division:${divisionKey}:manager_role`;
}

export function divisionCaptainRoleLogicalKey(divisionKey: string): string {
  return `division:${divisionKey}:captain_role`;
}

export function divisionCategoryLogicalKey(divisionKey: string): string {
  return `division:${divisionKey}:category`;
}

export function divisionChannelLogicalKey(
  divisionKey: string,
  channelKey: string,
  kind: Extract<ManagedResourceType, 'text_channel' | 'voice_channel'>,
): string {
  return `division:${divisionKey}:channel:${channelKey}:${kind}`;
}

// Fails loudly and immediately (module load) if two divisions -- or two
// channel template entries -- were authored with the same key. Two separate,
// independent checks (rather than one combined structure like server's
// ServerStructureLike) are sufficient here: every division shares the same
// channel template, so logical-key uniqueness follows from divisions having
// unique keys AND the shared channel template having unique keys, with `kind`
// as the same mechanical safety net server/season already use.
export function assertNoDuplicateKeys(kind: string, entries: readonly { key: string }[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.key)) duplicates.add(entry.key);
    seen.add(entry.key);
  }

  if (duplicates.size > 0) {
    throw new Error(`Duplicate ${kind} key(s): ${Array.from(duplicates).join(', ')}`);
  }
}

export type DivisionResourceLike = {
  logicalKey: string;
  discordResourceId: string;
  resourceType: ManagedResourceType;
};

// Narrows a mixed list of managed resources (any domain/division) down to
// just the ones belonging to one division. Relies on `division:<key>:` being
// a safe prefix -- see the key-builder comment above for why that's safe
// even when one division key is a textual prefix of another's.
export function resourcesForDivision<T extends DivisionResourceLike>(resources: readonly T[], divisionKey: string): T[] {
  const prefix = `division:${divisionKey}:`;
  return resources.filter((resource) => resource.logicalKey.startsWith(prefix));
}

// The pure decision at the heart of the archive/delete safety split (#31
// required change): a destructive delete may only ever act on Discord
// resources Ratatoskr can prove it manages. Given every child channel
// currently in a division's category and the Discord ids of every channel
// this division actually manages, returns the ones with no managed row --
// deletion must surface and block on these, never silently include or
// silently skip them. Archive is exempt from this check by design: hiding a
// category-wide permission overwrite is reversible and safe to apply to
// unmanaged children too (containment, not adoption).
export function findUnmanagedCategoryChildren(
  categoryChildDiscordIds: readonly string[],
  managedChannelDiscordIds: readonly string[],
): string[] {
  const managed = new Set(managedChannelDiscordIds);
  return categoryChildDiscordIds.filter((id) => !managed.has(id));
}
