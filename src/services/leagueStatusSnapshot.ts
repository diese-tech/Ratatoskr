import type { PersistedLeagueOpsCard } from '../db/repositories/leagueAudits.js';
import { leagueEasternTime } from './leaguePresentation.js';

export function draftSnapshotStatus(findings?: readonly string[]): 'ready' | 'attention' | 'unknown' {
  if (!findings?.length) return 'unknown';
  return findings.every(value => /^(?:Draft picks checked: all 96 top-four picks have matching player records\.|Draft tracking ready: 96 resolved top-four picks\.)/.test(value)) ? 'ready' : 'attention';
}

export function buildLeagueStatusSnapshot(input: {
  result: 'clean' | 'dirty' | 'error'; problems: number; unfinished: number;
  lastFullAt?: string | null; draftFindings?: readonly string[];
}): PersistedLeagueOpsCard {
  const draft = draftSnapshotStatus(input.draftFindings);
  const pending = !input.lastFullAt;
  const clear = input.result === 'clean' && !input.problems && !input.unfinished && !pending && draft === 'ready';
  const count = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
  const summary = input.problems || input.unfinished
    ? [input.problems ? count(input.problems, 'roster problem') : '', input.unfinished ? count(input.unfinished, 'unfinished action') : ''].filter(Boolean).join(' · ')
    : input.result === 'error' || pending ? 'Roster status is not confirmed.' : 'No roster problems or unfinished actions.';
  return {
    title: `League Status · ${clear ? 'All clear' : input.result === 'error' ? 'Check incomplete' : pending ? 'Checking' : 'Needs attention'}`,
    description: [input.result === 'error' ? 'The latest check could not finish. Previous results may have changed.' : pending ? 'Waiting for the first full roster check.' : '',
      summary,
      `Draft records: ${draft === 'ready' ? 'up to date' : draft === 'attention' ? 'needs attention' : 'not checked yet'}.`].filter(Boolean).join('\n'),
    footer: `Last roster check: ${leagueEasternTime(input.lastFullAt)}`,
    allowedMentions: false,
    actions: [{ id: 'league-ops:open', label: clear ? 'Open league tools' : 'Review problems' }, { id: 'league-recovery:recheck', label: 'Check again' }],
  };
}
