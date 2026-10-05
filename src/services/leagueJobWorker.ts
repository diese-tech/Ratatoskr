import type Database from 'better-sqlite3';
import {
  claimLeagueJob,
  dismissResolvedBackgroundFailures,
  enqueueLeagueJob,
  getLeagueJob,
  recoverLeagueJobs,
  releaseBackgroundDedupe,
  transitionLeagueJob,
  type LeagueJob,
  type LeagueJobStatus,
  type LeagueJobType,
} from '../db/repositories/leagueJobs.js';
export type LeagueJobHandler = (job: LeagueJob, phase: (status: LeagueJobStatus) => void) => Promise<unknown>;
export class LeagueJobBlockedError extends Error {
  constructor(
    readonly status: 'BLOCKED_REVIEW' | 'RECONCILIATION_REQUIRED' | 'FAILED',
    message: string,
    readonly result?: unknown,
  ) {
    super(message);
  }
}
export class LeagueJobWorker {
  private running = new Set<boolean>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly db: Database.Database,
    readonly guildId: string,
    private readonly handlers: Record<LeagueJobType, LeagueJobHandler>,
    private readonly recoverMutation: (job: LeagueJob) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  enqueue(type: LeagueJobType, payload: unknown, dedupeKey: string, delayMs = 0): LeagueJob {
    const job = enqueueLeagueJob(this.db, {
      guildId: this.guildId,
      type,
      payload,
      dedupeKey,
      now: this.now(),
      delayMs,
    });
    this.wake();
    return job;
  }
  async recover(): Promise<void> {
    for (const job of recoverLeagueJobs(this.db, this.guildId)) {
      if (job.type === 'transaction' || job.type === 'repair') await this.recoverMutation(job);
      else transitionLeagueJob(this.db, job.reference, 'QUEUED');
    }
  }
  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  wake(): void {
    if (this.stopped) return;
    // The presentation lane cannot hold the serialized canonical worker.
    for (const presentation of [false, true])
      void this.drain(presentation).catch((error) => console.error('League worker failed:', error));
  }
  async drain(presentation = false): Promise<void> {
    if (this.running.has(presentation) || this.stopped) return;
    this.running.add(presentation);
    try {
      for (;;) {
        if (this.stopped) break;
        const job = claimLeagueJob(this.db, this.guildId, presentation, this.now());
        if (!job) break;
        try {
          const result = await this.handlers[job.type](job, (status) =>
            transitionLeagueJob(this.db, job.reference, status),
          );
          transitionLeagueJob(this.db, job.reference, 'COMPLETED', { result });
          dismissResolvedBackgroundFailures(this.db, job);
          releaseBackgroundDedupe(this.db, job.reference);
        } catch (error) {
          if (error instanceof LeagueJobBlockedError) {
            transitionLeagueJob(this.db, job.reference, error.status, { error: error.message, result: error.result });
          } else {
            const current = getLeagueJob(this.db, job.reference)!;
            const mutation = job.type === 'transaction' || job.type === 'repair';
            const ambiguous = mutation && ['APPLYING', 'VERIFYING'].includes(current.status);
            const status = ambiguous ? 'RECONCILIATION_REQUIRED' : job.attemptCount >= 5 ? 'FAILED' : 'RETRYING';
            transitionLeagueJob(this.db, job.reference, status, {
              error: String(error),
              availableAt: new Date(this.now().getTime() + Math.min(120_000, 5000 * 2 ** job.attemptCount)),
            });
            console.error(`League job ${job.reference} ${status}:`, error);
          }
          if (
            ['FAILED', 'RECONCILIATION_REQUIRED', 'BLOCKED_REVIEW'].includes(
              getLeagueJob(this.db, job.reference)!.status,
            )
          ) {
            releaseBackgroundDedupe(this.db, job.reference);
            if (!['panel', 'heartbeat'].includes(job.type)) this.enqueue('panel', {}, 'panel', 500);
          }
        }
      }
    } finally {
      this.running.delete(presentation);
    }
  }
}
const workers = new WeakMap<object, Map<string, LeagueJobWorker>>();
export function registerLeagueJobWorker(scope: object, worker: LeagueJobWorker): void {
  let guilds = workers.get(scope);
  if (!guilds) {
    guilds = new Map();
    workers.set(scope, guilds);
  }
  guilds.set(worker.guildId, worker);
}
export function leagueJobWorkerFor(scope: object, guildId: string): LeagueJobWorker {
  const worker = workers.get(scope)?.get(guildId);
  if (!worker) throw new Error('League operations are still starting. Try again shortly.');
  return worker;
}
