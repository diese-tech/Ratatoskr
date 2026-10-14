import type { Client, Guild } from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { AccountReplacementMember } from '../domain/leagueAccountReplacement.js';

export type LeagueMemberReadOptions = { observation?: boolean; signal?: AbortSignal };
export type MemberReadClock = { now?: () => number; sleep?: (delayMs: number) => Promise<void> };
type State = {
  version: number;
  shardId: number;
  snapshot?: { at: number; attempt: number; totalCount: number; members: AccountReplacementMember[] };
  flight?: Promise<AccountReplacementMember[]>;
  cooldownUntil: number;
  counts: { attempts: number; throttles: number; coalesced: number; observationHits: number; waits: number; deferrals: number; invalidations: number };
  loggedAt?: number;
};
const sessions = new WeakMap<Client, Map<string, State>>();
const detachedGuilds = new WeakMap<Guild, State>();
type CompleteMemberListener = (guild: Guild, members: readonly AccountReplacementMember[]) => void;
const completeListeners = new WeakMap<Client, Set<CompleteMemberListener>>();
export function listenToCompleteLeagueMembers(client: Client, listener: CompleteMemberListener): () => void {
  let listeners = completeListeners.get(client);
  if (!listeners) { listeners = new Set(); completeListeners.set(client, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const TTL_MS = 60_000;
const MAX_INTERACTIVE_WAIT_MS = 5_000;

export class LeagueMemberGatewayThrottleError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Discord asked Rat to wait. Try checking again in ${Math.ceil(retryAfterMs / 1_000)} seconds. No roster changes were made by this check.`);
  }
}

function throttleDelay(error: unknown, guildId: string): number | undefined {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  const data = error.data as { opcode?: unknown; retry_after?: unknown; meta?: { guild_id?: string } } | undefined;
  if (!data || data.opcode !== 8 || typeof data.retry_after !== 'number' || data.retry_after < 0
    || !Number.isFinite(data.retry_after * 1_000) || (data.meta?.guild_id && data.meta.guild_id !== guildId)) return undefined;
  // Do not shorten Discord's cooldown to bound an interactive wait. Defer the
  // caller instead; a response longer than our budget still governs all readers.
  return Math.ceil(data.retry_after * 1_000) + 250;
}

export class LeagueMemberSnapshotUnavailableError extends Error {
  constructor(message = 'Rat could not check every Discord member, or someone changed while it was checking. Try checking again.') {
    super(message);
  }
}

function invalidate(state: State): void {
  state.version += 1; state.snapshot = undefined; state.counts.invalidations += 1;
}
function guildUnavailable(guild: Guild): boolean { return guild.available === false; }

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // A transport callback can abort synchronously while starting the request.
    // Observe its eventual rejection even though this consumer is already done.
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function logCounts(state: State, now: number): void {
  if (state.loggedAt !== undefined && now - state.loggedAt < TTL_MS) return;
  state.loggedAt = now;
  console.info('League member reads:', { ...state.counts, cooldownMs: Math.max(0, state.cooldownUntil - now) });
}

export function leagueMemberReadDiagnostics(guild: Guild): Readonly<State['counts'] & { cooldownMs: number }> {
  const state = stateFor(guild);
  return { ...state.counts, cooldownMs: Math.max(0, state.cooldownUntil - Date.now()) };
}

function stateFor(guild: Guild): State {
  const create = (): State => ({ version: 0, shardId: guild.shardId, cooldownUntil: 0,
    counts: { attempts: 0, throttles: 0, coalesced: 0, observationHits: 0, waits: 0, deferrals: 0, invalidations: 0 } });
  // Unit fixtures may not have a Client. Production uses the guild/session ID,
  // so distinct adapters and Guild wrappers share only their own Gateway session.
  if (!guild.client?.on) {
    let state = detachedGuilds.get(guild);
    if (!state) { state = create(); detachedGuilds.set(guild, state); }
    return state;
  }
  let states = sessions.get(guild.client);
  if (!states) {
    states = new Map();
    sessions.set(guild.client, states);
    const scoped = states;
    const changed = (value: { guild: { id: string } }) => {
      const state = scoped.get(value.guild.id); if (state) invalidate(state);
    };
    guild.client.on('guildMemberAdd', changed);
    guild.client.on('guildMemberRemove', changed);
    guild.client.on('guildMemberUpdate', (_old, member) => changed(member));
    guild.client.on('roleUpdate', (_old, role) => changed(role));
    guild.client.on('roleDelete', changed);
    guild.client.on('userUpdate', () => { for (const state of scoped.values()) invalidate(state); });
    for (const event of ['guildUnavailable', 'guildDelete', 'guildAvailable'] as const)
      guild.client.on(event, (value) => { const state = scoped.get(value.id); if (state) invalidate(state); });
    const invalidateShard = (id: number) => {
      for (const state of scoped.values()) if (state.shardId === id) invalidate(state);
    };
    guild.client.on('shardDisconnect', (_close, id) => invalidateShard(id));
    guild.client.on('shardReconnecting', invalidateShard);
    guild.client.on('shardResume', invalidateShard);
    guild.client.on('shardReady', invalidateShard);
    guild.client.on('invalidated', () => { for (const state of scoped.values()) invalidate(state); });
  }
  let state = states.get(guild.id);
  if (!state) { state = create(); states.set(guild.id, state); }
  return state;
}

function fetchComplete(guild: Guild, state: State, now: () => number): Promise<AccountReplacementMember[]> {
  if (!state.flight) {
    const version = state.version;
    state.counts.attempts += 1;
    state.flight = (async () => {
      const fresh = await guild.members.fetch();
      if (state.version !== version || guildUnavailable(guild)
        || (typeof guild.memberCount === 'number' && fresh.size !== guild.memberCount)
        || fresh.some((member) => member.partial || (member.guild && member.guild.id !== guild.id)))
        throw new LeagueMemberSnapshotUnavailableError();
      const observed = fresh.map((member) => ({
        discordId: member.id, displayName: member.displayName, nickname: member.nickname,
        roleIds: [...member.roles.cache.keys()], guildId: guild.id, bot: member.user.bot,
      }));
      for (const listener of completeListeners.get(guild.client) ?? []) {
        try { listener(guild, observed); }
        catch { console.error('Complete member observation failed; league reads remain available.'); }
      }
      const members = observed.filter(member => !member.bot);
      state.snapshot = { at: now(), attempt: state.counts.attempts, totalCount: fresh.size, members };
      return members;
    })().catch((error: unknown) => {
      invalidate(state);
      const retryMs = throttleDelay(error, guild.id);
      if (retryMs === undefined) throw error;
      state.counts.throttles += 1;
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + retryMs);
      throw new LeagueMemberGatewayThrottleError(state.cooldownUntil - now());
    }).finally(() => { state.flight = undefined; logCounts(state, now()); });
  } else state.counts.coalesced += 1;
  return state.flight;
}

export async function readLeagueMembers(
  guild: Guild, options: LeagueMemberReadOptions = {}, clock: MemberReadClock = {},
): Promise<AccountReplacementMember[]> {
  const state = stateFor(guild);
  const now = clock.now ?? Date.now;
  const began = now();
  const startedAtAttempt = state.counts.attempts;
  options.signal?.throwIfAborted();
  if (guildUnavailable(guild)) {
    invalidate(state);
    throw new LeagueMemberSnapshotUnavailableError('Discord guild is unavailable. Retry a fresh check.');
  }
  if (state.snapshot && typeof guild.memberCount === 'number' && state.snapshot.totalCount !== guild.memberCount)
    invalidate(state);
  if (options.observation && state.snapshot && now() - state.snapshot.at >= 0 && now() - state.snapshot.at < TTL_MS) {
    state.counts.observationHits += 1;
    return structuredClone(state.snapshot.members);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = Math.max(0, state.cooldownUntil - now());
    if (remaining) {
      if (options.observation || remaining > MAX_INTERACTIVE_WAIT_MS - (now() - began)) {
        state.counts.deferrals += 1;
        throw new LeagueMemberGatewayThrottleError(remaining);
      }
      state.counts.waits += 1;
      if (clock.sleep) await abortable(clock.sleep(remaining), options.signal);
      else await delay(remaining, undefined, { signal: options.signal });
      // A shared cooldown may have been extended while we waited.
      if (state.cooldownUntil > now()) throw new LeagueMemberGatewayThrottleError(state.cooldownUntil - now());
      if (guildUnavailable(guild) || (state.snapshot && typeof guild.memberCount === 'number'
        && state.snapshot.totalCount !== guild.memberCount)) {
        invalidate(state);
        throw new LeagueMemberSnapshotUnavailableError();
      }
      // Another consumer can finish recovery before this caller's timer wakes.
      // Share only a complete request begun after this call, never its old TTL cache.
      if (state.snapshot && state.snapshot.attempt > startedAtAttempt) {
        options.signal?.throwIfAborted();
        state.counts.coalesced += 1;
        return structuredClone(state.snapshot.members);
      }
    }
    try { return structuredClone(await abortable(fetchComplete(guild, state, now), options.signal)); }
    catch (error) {
      if (!(error instanceof LeagueMemberGatewayThrottleError) || options.observation || attempt === 1) throw error;
    }
  }
  throw new LeagueMemberSnapshotUnavailableError();
}
