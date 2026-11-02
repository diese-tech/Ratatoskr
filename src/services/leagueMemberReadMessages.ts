import { LeagueMemberGatewayThrottleError, LeagueMemberSnapshotUnavailableError } from './leagueMemberReads.js';

/**
 * Private wording for a whole-member read that failed before anything was saved or written.
 * Callers must only use it for read-only phases; failures after a job exists keep their
 * normal reporting and recovery path. Returns undefined for any other error.
 */
export function memberReadDeferralMessage(error: unknown, wording: { unchanged: string; retry: string }): string | undefined {
  if (error instanceof LeagueMemberGatewayThrottleError) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
    return `Discord asked Rat to wait before checking the member list again. ${wording.unchanged} ${wording.retry} in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }
  if (error instanceof LeagueMemberSnapshotUnavailableError)
    return `Rat could not check every Discord member just now. ${wording.unchanged} ${wording.retry} in a moment.`;
  return undefined;
}

export function logMemberReadDeferral(guildId: string, step: string, error: unknown): void {
  console.warn('League member check deferred before any change', { guildId, step,
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof LeagueMemberGatewayThrottleError ? { retryAfterMs: error.retryAfterMs } : {}) });
}
