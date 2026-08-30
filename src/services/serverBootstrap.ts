import { PermissionFlagsBits } from 'discord.js';
import type { ManagedResource, ManagedResourceType } from '../db/types.js';

export type ServerStructureLike = {
  roles: readonly { key: string }[];
  categories: readonly { key: string; channels: readonly { key: string; type: 'text' | 'voice' }[] }[];
};

// Pure ownership-determination and obsolete-detection logic for Server
// Bootstrap v2 (issue #16). Kept free of discord.js so it can be tested
// without a live Discord connection -- scripts/bootstrap-guild.ts maps real
// Guild/Channel/Role data into the plain shapes below and calls these.

export type CandidateResource = {
  discordId: string;
  name: string;
  kind: ManagedResourceType;
  // The Discord id of the parent category for a channel; null for
  // categories and roles, which have no relevant parent here.
  parentId: string | null;
};

export type TemplateSlot = {
  logicalKey: string;
  name: string;
  kind: ManagedResourceType;
  parentId: string | null;
};

export type MatchResult =
  | { outcome: 'exact'; candidate: CandidateResource }
  | { outcome: 'ambiguous'; candidates: CandidateResource[] }
  | { outcome: 'none' };

// See #16 "Ownership determination": exactly one candidate matching name,
// kind, and parent is the only case eligible for adoption. Zero same-named
// candidates means nothing exists for this slot yet (safe to create). Any
// other shape -- multiple same-named candidates, or a single same-named
// candidate that doesn't fully match kind/parent -- is ambiguous and must
// never be automatically adopted, regardless of how close it looks.
export function classifyMatch(
  candidates: readonly CandidateResource[],
  slot: Pick<TemplateSlot, 'name' | 'kind' | 'parentId'>,
): MatchResult {
  const sameName = candidates.filter((candidate) => candidate.name === slot.name);

  if (sameName.length === 0) return { outcome: 'none' };

  const exact = sameName.filter((candidate) => candidate.kind === slot.kind && candidate.parentId === slot.parentId);

  if (sameName.length === 1 && exact.length === 1) {
    return { outcome: 'exact', candidate: exact[0] };
  }

  return { outcome: 'ambiguous', candidates: sameName };
}

// A managed resource is obsolete only if it is currently active *and* its
// logicalKey no longer corresponds to any slot in the current template.
// Resources that were never registered (nothing in managedResources) never
// pass through here at all -- this function only ever narrows an
// already-managed set, it never expands ownership.
export function detectObsoleteManagedResources(
  managedResources: readonly ManagedResource[],
  currentLogicalKeys: ReadonlySet<string>,
): ManagedResource[] {
  return managedResources.filter((resource) => resource.status === 'active' && !currentLogicalKeys.has(resource.logicalKey));
}

// Logical keys are authored (config's `key` field), never derived from
// `name` -- see #31 Defect 2. A config-side display-name rename must not
// change identity, so these builders only ever consume `key`. `kind` stays
// a required, separate segment (not folded into the author's key) as a
// mechanical safety net: Discord lets a text and a voice channel share a
// name under one category, and scoping by kind means even an authoring
// mistake that reuses one channel key for both can't silently collide the
// way the old name-derived scheme did (confirmed live before PR #18: two
// channels quietly clobbered each other's managed_resources tracking).
export function serverRoleLogicalKey(key: string): string {
  return `server:role:${key}`;
}

export function serverCategoryLogicalKey(key: string): string {
  return `server:category:${key}`;
}

export function serverChannelLogicalKey(
  categoryKey: string,
  channelKey: string,
  kind: Extract<ManagedResourceType, 'text_channel' | 'voice_channel'>,
): string {
  return `server:channel:${categoryKey}:${channelKey}:${kind}`;
}

// Every logical key the current template defines -- the full set that
// "still belongs" this run. Anything managed but absent from this set is a
// cleanup candidate; anything in this set that has no managed_resources row
// yet is simply created and registered normally.
export function currentServerLogicalKeys(structure: ServerStructureLike): Set<string> {
  const keys = new Set<string>();

  for (const role of structure.roles) {
    keys.add(serverRoleLogicalKey(role.key));
  }

  for (const category of structure.categories) {
    keys.add(serverCategoryLogicalKey(category.key));
    for (const channel of category.channels) {
      keys.add(serverChannelLogicalKey(category.key, channel.key, channel.type === 'voice' ? 'voice_channel' : 'text_channel'));
    }
  }

  return keys;
}

// Fails loudly and immediately (module load, not first reconciliation run)
// if two config entries were authored with the same logical key. This is
// the load-bearing check that makes "keys are authored" safe: nothing else
// catches an authoring mistake before it corrupts managed-resource tracking.
export function assertNoDuplicateServerLogicalKeys(structure: ServerStructureLike): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  function record(key: string) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }

  for (const role of structure.roles) record(serverRoleLogicalKey(role.key));
  for (const category of structure.categories) {
    record(serverCategoryLogicalKey(category.key));
    for (const channel of category.channels) {
      record(serverChannelLogicalKey(category.key, channel.key, channel.type === 'voice' ? 'voice_channel' : 'text_channel'));
    }
  }

  if (duplicates.size > 0) {
    throw new Error(`Duplicate server logical key(s) in guild structure config: ${Array.from(duplicates).join(', ')}`);
  }
}

export type ChannelAccessSpec = {
  access?: readonly string[];
  readOnly?: boolean;
};

export type RoleOverwriteEntry = { id: string; allow: bigint[]; deny: bigint[] };

// Pure merge of the two permission-overwrite dimensions the server scaffold
// uses: view-gating (`access`, unchanged from the original bootstrap) and
// the new read-only-for-members primitive (`readOnly`: visible to everyone
// who can already view the channel, but only `staffRoleNames` may post).
// Takes a plain role-name -> id resolver rather than discord.js Role
// objects so it's testable without a live guild -- the same role id can be
// touched by both dimensions and only ever produces one merged overwrite
// entry, never two competing entries for the same id.
export function resolveChannelPermissionOverwrites(
  everyoneId: string,
  resolveRoleId: (roleName: string) => string | undefined,
  staffRoleNames: readonly string[],
  spec: ChannelAccessSpec,
): RoleOverwriteEntry[] | undefined {
  const overwritesById = new Map<string, { allow: bigint[]; deny: bigint[] }>();

  function addOverwrite(id: string, allow: bigint[] = [], deny: bigint[] = []) {
    const existing = overwritesById.get(id) ?? { allow: [], deny: [] };
    overwritesById.set(id, { allow: [...existing.allow, ...allow], deny: [...existing.deny, ...deny] });
  }

  if (spec.access) {
    addOverwrite(everyoneId, [], [PermissionFlagsBits.ViewChannel]);
    for (const roleName of spec.access) {
      const roleId = resolveRoleId(roleName);
      if (!roleId) throw new Error(`Missing configured role: ${roleName}`);
      addOverwrite(roleId, [PermissionFlagsBits.ViewChannel]);
    }
  }

  if (spec.readOnly) {
    // Denying only SendMessages/CreatePublicThreads still lets a member post
    // inside an existing thread (via the inherited SendMessagesInThreads
    // permission) or spin up a private thread -- deny both thread-posting
    // surfaces too so the channel is actually read-only, not just
    // top-level-read-only.
    const readOnlyDenies = [
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
      PermissionFlagsBits.SendMessagesInThreads,
    ];
    addOverwrite(everyoneId, [], readOnlyDenies);
    for (const roleName of staffRoleNames) {
      const roleId = resolveRoleId(roleName);
      if (roleId) addOverwrite(roleId, readOnlyDenies);
    }
  }

  if (overwritesById.size === 0) return undefined;
  return Array.from(overwritesById, ([id, overwrite]) => ({ id, ...overwrite }));
}
