import { PermissionFlagsBits } from 'discord.js';
import type { ManagedResource, ManagedResourceType } from '../db/types.js';

export type ServerStructureLike = {
  roles: readonly { name: string }[];
  categories: readonly { name: string; channels: readonly { name: string; type: 'text' | 'voice' }[] }[];
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

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

export function serverRoleLogicalKey(roleName: string): string {
  return `server:${slugify(roleName)}:role`;
}

export function serverCategoryLogicalKey(categoryName: string): string {
  return `server:${slugify(categoryName)}:category`;
}

// `kind` is required, not optional: Discord lets a text and a voice channel
// share the same (case-insensitive) name under one category -- e.g.
// Community's "general" text channel and "General" voice channel. Without
// the resource type in the key, both would slugify to the same logical key
// and silently clobber each other's managed_resources tracking on every
// run (confirmed live: the second one processed would find the first one's
// row, see a type mismatch, mark it obsolete, and re-adopt itself under the
// same key -- flip-flopping which one is "tracked" on every subsequent run).
export function serverChannelLogicalKey(
  categoryName: string,
  channelName: string,
  kind: Extract<ManagedResourceType, 'text_channel' | 'voice_channel'>,
): string {
  return `server:${slugify(categoryName)}:${slugify(channelName)}:${kind}`;
}

// Every logical key the current template defines -- the full set that
// "still belongs" this run. Anything managed but absent from this set is a
// cleanup candidate; anything in this set that has no managed_resources row
// yet is simply created and registered normally.
export function currentServerLogicalKeys(structure: ServerStructureLike): Set<string> {
  const keys = new Set<string>();

  for (const role of structure.roles) {
    keys.add(serverRoleLogicalKey(role.name));
  }

  for (const category of structure.categories) {
    keys.add(serverCategoryLogicalKey(category.name));
    for (const channel of category.channels) {
      keys.add(serverChannelLogicalKey(category.name, channel.name, channel.type === 'voice' ? 'voice_channel' : 'text_channel'));
    }
  }

  return keys;
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
