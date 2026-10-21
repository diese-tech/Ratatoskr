import { redactOperationalText } from './redactOperationalText.js';
import { EventKind, action, container, flow, input, modal, policy, row, screen, text, view,
  type ActionEvent, type DeepReadonly, type ScreenKit } from 'fluxcord';
import { LeagueJobBlockedError } from './leagueJobWorker.js';
import { LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { leagueOpsText, type LeagueOpsIssue, type LeagueOpsOperation, type LeagueOpsReviewService,
  leagueOpsRepairAction, type LeagueOpsSnapshot, type ReviewAccountReplacementPreview, type ReviewTransactionPreview, type ReviewRepairPreview, type ReviewRecoveryPreview } from './leagueOpsReview.js';
import { LeagueAuditRepairNoWriteError } from './leagueAuditResolution.js';
import { draftPickVerificationText } from './draftPickTracking.js';
import { leagueActionLabel, leagueStatusLabel, savedLeagueErrorMessage, leagueValidationMessage, leagueRepairNoWriteMessage, leagueEasternTime, leagueFixLabel, leagueFixExplanation } from './leaguePresentation.js';

export type LeagueOpsPanelData = { snapshot: LeagueOpsSnapshot; page: number; selectedIssue?: LeagueOpsIssue;
  selectedOperation?: LeagueOpsOperation; replacement?: ReviewAccountReplacementPreview; transaction?: ReviewTransactionPreview;
  repair?: ReviewRepairPreview;
  recovery?: ReviewRecoveryPreview;
  samePlayerConfirmed?: boolean; busy: boolean; notice: string; queued?: string };
const PAGE_SIZE = 5;
export function leagueCheckDetailPages(details: readonly string[]): string[] {
  const pages: string[] = [];
  let remaining = redactOperationalText(details.join('\n\n')) || 'No check details available yet.';
  while (remaining.length) {
    let length = Math.min(1400, remaining.length);
    // Keep Unicode pairs together while bounding escaped Discord text.
    if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1]!)) length--;
    pages.push(remaining.slice(0, length));
    remaining = remaining.slice(length);
  }
  return pages;
}
const clearedPreview = { replacement: undefined, transaction: undefined, repair: undefined, recovery: undefined, samePlayerConfirmed: undefined };
export function leagueOpsPreviewText(data: DeepReadonly<Pick<LeagueOpsPanelData, 'replacement' | 'transaction' | 'repair' | 'recovery'>>): string {
  const replacement = data.replacement;
  if (replacement) {
    const p = replacement.plan;
    return [`Move ${p.rosterBefore.player} to their new Discord account.`, `Old account: ${p.oldDiscordId}; new account: ${p.newDiscordId}.`, `Roster name: ${p.rosterBefore.player} → ${p.rosterAfter.player}`,
      `Keep their team and position: ${p.rosterAfter.franchise}, ${p.rosterAfter.division}, ${p.rosterAfter.rosterStatus}.`,
      'Keep the old account and names in history. Add one current name for the new account. Past transactions keep their original account IDs.',
      `Name History row ${p.oldNameAfter.sheetRow}: ${p.oldNameBefore.currentLeagueName} / ${p.oldNameBefore.knownName} → Previous / Alternate.`,
      `New current name in row ${p.newName.sheetRow}: ${p.newName.currentLeagueName}; preserve ${p.preservedHistory.nameRows.length} past-name rows.`,
      `Public name: ${p.publicChanges.length ? p.publicChanges.map(c => `${c.from} → ${c.to}`).join('; ') : 'unchanged and checked'}.`,
      ...p.roles.map(r => `Account ${r.discordId}: roles to add ${r.add.map(id => replacement.roleLabels?.[id] ?? id).join(', ') || 'none'}; remove ${r.remove.map(id => replacement.roleLabels?.[id] ?? id).join(', ') || 'none'}.`),
      ...p.manualReview, `Draft Picks: ${draftPickVerificationText(replacement.draftVerification)}.`,
      `Earlier saved fixes: ${replacement.preservedJobReferences.join(', ') || 'none linked'}.`].join('\n');
  }
  if (data.recovery) return `Close the checked action: ${data.recovery.reference}\n${data.recovery.description}\nCheck the saved names and history first. This closes the unfinished action after checking today’s records. It does not run the old change again or say the old attempt succeeded.`;
  if (data.repair) return `Problem: ${data.repair.finding}\n\nWhat will change: ${data.repair.description}\nRat will check the same records again when you confirm. No changes were made.`;
  const plan = data.transaction?.plan;
  return plan ? [`${leagueActionLabel(plan.kind)}: ${plan.players.join(' / ')}`, ...plan.publicChanges.map(c => `${c.division} / ${c.group}: ${c.from || 'empty'} → ${c.to || 'empty'}`),
    `Earlier action needing review: ${data.transaction!.originalReference}.`, 'This shows a new preview. Rat will not run the earlier action again.'].join('\n') : 'No approved preview is available.';
}
export function createLeagueOpsFlow(service: LeagueOpsReviewService, ended: (id: string) => void = () => {}) {
  const run = (event: ActionEvent<LeagueOpsPanelData>, work: () => Promise<Partial<LeagueOpsPanelData>>, readOnly = false) => {
    if (event.session.data.busy || (event.session.data.queued && !readOnly)) return;
    event.mutate(data => { data.busy = true; data.notice = 'Checking the latest league records…'; });
    event.launch(async job => {
      try { const changes = await work(); job.mutate(data => { Object.assign(data, changes); }); }
      catch (error) {
        const message = error instanceof LeagueMutationValidationError ? leagueValidationMessage(error.message)
          : error instanceof LeagueAuditRepairNoWriteError ? leagueRepairNoWriteMessage(error.message)
          : error instanceof LeagueJobBlockedError ? savedLeagueErrorMessage(error.message)
          : 'Rat could not finish this review. Choose Open league tools on the latest League Status message and ask staff to check Saved actions. If you already confirmed, do not repeat the action.';
        job.mutate(data => { data.notice = leagueOpsText(message); });
      } finally { job.mutate(data => { data.busy = false; }); }
    });
  };
  const refresh = action<LeagueOpsPanelData>()(event => {
    const reference = event.session.data.selectedOperation?.reference;
    run(event, async () => {
      const snapshot = await service.snapshot(event.actorId);
      const selectedOperation = reference ? await service.operationDetail(event.actorId, reference) : undefined;
      // This is a finite read, never an unattended polling/redraw loop.
      return { snapshot, ...(selectedOperation ? { selectedOperation } : {}), notice: 'Latest records loaded.' };
    }, true);
  });
  const findOperation = action<LeagueOpsPanelData>()(async event => {
    if (event.session.data.busy) return;
    if (event.kind !== EventKind.ModalSubmit) {
      await event.ui.showModal(modal({ title: 'Find a saved action' },
        input({ id: 'reference', label: 'Reference shown on the saved action', required: true, maxLength: 64 })));
      return;
    }
    const reference = String(event.inputs?.reference ?? '').trim();
    event.ui.go('operation');
    run(event, async () => ({ selectedOperation: await service.operationDetail(event.actorId, reference), notice: 'Latest saved action loaded.' }), true);
  });
  const replacement = action<LeagueOpsPanelData>()(async event => {
    if (event.session.data.busy || event.session.data.replacement || event.session.data.transaction) return;
    const issue = event.session.data.selectedIssue;
    if (!issue?.oldDiscordId) return;
    if (event.kind !== EventKind.ModalSubmit) {
      await event.ui.showModal(modal({ title: 'Player changed Discord account' },
        input({ id: 'old', label: 'Old rostered Discord ID', value: issue.oldDiscordId, required: true, minLength: 16, maxLength: 20 }),
        input({ id: 'new', label: 'Replacement Discord ID', required: true, minLength: 16, maxLength: 20 }),
        input({ id: 'attestation', label: 'Type SAME PLAYER after verifying ownership', required: true, maxLength: 20 })));
      return;
    }
    const oldId = String(event.inputs?.old ?? '').trim();
    const newId = String(event.inputs?.new ?? '').trim();
    if (oldId !== issue.oldDiscordId || !/^\d{16,20}$/.test(newId) || String(event.inputs?.attestation).trim() !== 'SAME PLAYER') {
      event.mutate(data => { data.notice = 'Verify both exact IDs and type SAME PLAYER. No changes were made.'; });
      return;
    }
    event.ui.go('preview');
    run(event, async () => {
      const preview = await service.previewReplacement(event.actorId, issue.key, oldId, newId);
      return { ...clearedPreview, replacement: preview, samePlayerConfirmed: true,
        notice: 'Review the account change. Check any captain or staff roles listed below before confirming.' };
    });
  });
  const repreview = action<LeagueOpsPanelData>()(event => {
    const operation = event.session.data.selectedOperation;
    if (!operation?.canRepreview || event.session.data.replacement || event.session.data.transaction) return;
    event.ui.go('preview');
    run(event, async () => {
      const preview = await service.previewTransaction(event.actorId, operation.reference);
      return { ...clearedPreview, transaction: preview, notice: 'Review these player changes. No changes were made.' };
    });
  });
  const repairPreview = action<LeagueOpsPanelData>()(event => {
    const issue = event.session.data.selectedIssue;
    if (!issue || event.session.data.replacement || event.session.data.transaction || event.session.data.repair) return;
    event.ui.go('preview');
    run(event, async () => ({ ...clearedPreview, repair: await service.previewRepair(event.actorId, issue.key), notice: 'Review this fix, then confirm if it is correct.' }));
  });
  const recoveryPreview = action<LeagueOpsPanelData>()(event => {
    const operation = event.session.data.selectedOperation;
    if (!operation?.canRecover || event.session.data.recovery) return;
    event.ui.go('preview');
    run(event, async () => ({ ...clearedPreview, recovery: await service.previewRecovery(event.actorId, operation.reference), notice: 'Check that Discord and the sheets agree, then review the saved history before closing this action.' }));
  });
  const confirm = action<LeagueOpsPanelData>()(async event => {
    const data = event.session.data;
    if (data.busy || data.queued || [data.replacement, data.transaction, data.repair, data.recovery].filter(Boolean).length !== 1) return;
    if (event.kind !== EventKind.ModalSubmit) {
      if (data.recovery && !data.recovery.canConfirm) return;
      await event.ui.showModal(modal({ title: data.recovery ? 'Close checked action' : data.replacement ? 'Confirm account replacement' : data.repair ? leagueFixLabel(data.repair.action) : 'Confirm player change' },
        text(leagueOpsPreviewText(data).slice(0, 2000)),
        input({ id: 'confirm', label: data.recovery ? 'Type HISTORY REVIEWED after checking history' : 'Type CONFIRM to approve this exact preview', required: true, maxLength: 20 })));
      return;
    }
    if (String(event.inputs?.confirm).trim() !== (data.recovery ? 'HISTORY REVIEWED' : 'CONFIRM')) {
      event.mutate(d => { d.notice = data.recovery ? 'Type HISTORY REVIEWED after checking the preserved history.' : 'Type CONFIRM to approve the changes shown here.'; });
      return;
    }
    const reviewedReplacement = data.replacement;
    const reviewedTransaction = data.transaction;
    const reviewedRepair = data.repair;
    const reviewedRecovery = data.recovery;
    const samePlayerConfirmed = data.samePlayerConfirmed === true;
    run(event, async () => {
      const job = reviewedRecovery ? await service.confirmRecovery(event.actorId, reviewedRecovery, true)
        : reviewedReplacement ? await service.confirmReplacement(event.actorId, reviewedReplacement, samePlayerConfirmed)
        : reviewedRepair ? await service.confirmRepair(event.actorId, reviewedRepair) : await service.confirmTransaction(event.actorId, reviewedTransaction!);
      return { queued: job.reference,
        notice: `${leagueStatusLabel(job.status)}. Reference: ${job.reference}. Open Saved actions to check its progress. Do not submit it again.` };
    });
  });
  const navigation = (kit: ScreenKit<LeagueOpsPanelData>) => row({},
    kit.Button({ label: 'Roster problems', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; Object.assign(d, clearedPreview); d.notice = ''; }); event.ui.go('issues'); } }),
    kit.Button({ label: 'Saved actions', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; Object.assign(d, clearedPreview); d.notice = ''; }); event.ui.go('operations'); } }),
    kit.Button({ label: 'Check details', secondary: true, onClick: event => { if (!event.session.data.busy) { event.mutate(d => { d.page = 0; }); event.ui.go('checks'); } } }),
    kit.Button({ label: 'Refresh', secondary: true, onClick: refresh }),
    kit.Button({ label: 'Close', secondary: true, onClick: event => event.ui.exit() }));
  const issueScreen = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.issues.length / PAGE_SIZE) - 1));
    const issues = data.snapshot.issues.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Roster problems' },
      data.snapshot.issues.length ? `${data.snapshot.issues.length} roster problems. Choose one to review.` : 'No roster problems found.'),
      ...(data.snapshot.draftNeedsAttention ? [text('Draft records need checking. Open Check details for the reason and next step.')] : []),
      text('For a new trade, drop or pickup, use /transaction. These tools fix disagreements in existing records and check saved actions.'),
      ...issues.flatMap(issue => [text(leagueOpsText(issue.finding, 450)), row({}, kit.Button({ label: 'View problem', disabled: data.busy, onClick: event => {
        event.mutate(d => { d.selectedIssue = issue; d.notice = ''; }); event.ui.go('issue');
      } }))]),
      text(data.notice || 'Nothing changes until you confirm.'), row({}, kit.Button({ label: 'Previous', secondary: true, disabled: page === 0, onClick: e => e.mutate(d => { d.page = Math.max(0, d.page - 1); }) }),
        kit.Button({ label: 'Next', secondary: true, disabled: (page + 1) * PAGE_SIZE >= data.snapshot.issues.length, onClick: e => e.mutate(d => { d.page++; }) })), navigation(kit)));
  });
  const operations = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.operations.length / PAGE_SIZE) - 1));
    const items = data.snapshot.operations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Saved actions' }, `${data.snapshot.operations.length} unfinished actions. Open one to check progress or review a problem.`),
      ...items.flatMap(operation => [text(`${operation.reference} · ${leagueActionLabel(operation.type)} · ${leagueStatusLabel(operation.status)}`), row({}, kit.Button({ label: 'View action', disabled: data.busy, onClick: e => {
        e.mutate(d => { d.selectedOperation = { ...operation, targets: [...operation.targets] }; d.notice = ''; }); e.ui.go('operation');
      } }))]), text(data.notice || 'Nothing changes until you confirm.'), row({}, kit.Button({ label: 'Previous', secondary: true, disabled: page === 0, onClick: e => e.mutate(d => { d.page = Math.max(0, d.page - 1); }) }),
        kit.Button({ label: 'Next', secondary: true, disabled: (page + 1) * PAGE_SIZE >= data.snapshot.operations.length, onClick: e => e.mutate(d => { d.page++; }) })),
      row({}, kit.Button({ label: 'Find by reference', disabled: data.busy, secondary: true, onClick: findOperation })), navigation(kit)));
  });
  const issue = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Roster problem' }, leagueOpsText(data.selectedIssue?.finding ?? 'Choose a current roster problem.')),
    text(data.selectedIssue?.oldDiscordId ? 'Choose what happened. If this is the same player on a new Discord account, use Player changed Discord account. For someone who left or self-dropped, use the commands below.' : leagueFixExplanation(leagueOpsRepairAction(data.selectedIssue?.finding ?? ''))),
    row({}, kit.Button({ label: 'Player changed Discord account', disabled: !!data.queued || !data.selectedIssue?.oldDiscordId, onClick: replacement })),
    row({}, kit.Button({ label: leagueFixLabel(leagueOpsRepairAction(data.selectedIssue?.finding ?? '')), disabled: !!data.queued || !!data.selectedIssue?.oldDiscordId || !leagueOpsRepairAction(data.selectedIssue?.finding ?? ''), onClick: repairPreview })),
    ...(data.selectedIssue?.oldDiscordId ? [text('Left league: /transaction departure. Self-dropped: /transaction self-drop. Both show the changes for you to confirm.')] : []),
    text('The action button opens a preview. Nothing changes until you type CONFIRM in the final form.'), text(data.notice || 'Nothing changes until you confirm.'), navigation(kit))));
  const operation = screen<LeagueOpsPanelData>()((data, kit) => {
    const op = data.selectedOperation;
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Saved action' }, op ?
      [`Reference: ${op.reference}`, `Action: ${leagueActionLabel(op.action)}`, `Status: ${leagueStatusLabel(op.status)}`,
        `Requested: ${leagueEasternTime(op.createdAt)}; requested by: ${op.actor}`, `Affected players or teams: ${op.targets.join('; ') || 'See the saved problem'}`,
        `What happened: ${savedLeagueErrorMessage(op.error)}`, `What to do: ${op.next}`].map(line => leagueOpsText(line, 1700)).join('\n') : 'Choose a saved action.'),
      row({}, kit.Button({ label: 'Preview player change', disabled: !!data.queued || !op?.canRepreview, onClick: repreview }),
        kit.Button({ label: 'Check unfinished changes', disabled: !!data.queued || !op?.canRecover, secondary: true, onClick: recoveryPreview })), text(data.notice || 'Nothing changes until you confirm.'), navigation(kit)));
  });
  const checks = screen<LeagueOpsPanelData>()((data, kit) => {
    const pages = leagueCheckDetailPages(data.snapshot.checkDetails ?? ['Refresh to load the latest check details.']);
    const page = Math.min(data.page, pages.length - 1);
    return view({}, container({ color: 0x2f6844 },
      text({ title: `League tools · Check details · ${page + 1} of ${pages.length}` }, 'Checks only read records. No roster changes are made.'),
      text(leagueOpsText(pages[page]!, 3000)), row({},
        kit.Button({ label: 'Previous details', secondary: true, disabled: page === 0, onClick: event => event.mutate(d => { d.page = Math.max(0, page - 1); }) }),
        kit.Button({ label: 'Next details', secondary: true, disabled: page === pages.length - 1, onClick: event => event.mutate(d => { d.page = page + 1; }) })), navigation(kit)));
  });
  const approvalLabel = (data: DeepReadonly<LeagueOpsPanelData>) => data.recovery ? 'Close checked action' : data.replacement ? 'Change Discord account' : data.repair ? leagueFixLabel(data.repair.action) : 'Approve player change';
  const preview = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Review changes' }, leagueOpsText(leagueOpsPreviewText(data), 3400)), text(data.notice || 'No changes made. The button below opens the final confirmation form.'),
    row({}, kit.Button({ label: approvalLabel(data), disabled: data.busy || !!data.queued || (data.recovery && !data.recovery.canConfirm) || (!data.replacement && !data.transaction && !data.repair && !data.recovery), onClick: confirm }),
      kit.Button({ label: 'Cancel and close', secondary: true, onClick: e => e.ui.exit() })), navigation(kit))));
  const confirmation = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Confirm changes' }, leagueOpsText(leagueOpsPreviewText(data), 3400)),
    text(data.notice || 'Nothing changes until you confirm.'), row({}, kit.Button({ label: 'Confirm changes', success: true, disabled: data.busy || !!data.queued, onClick: confirm }),
      kit.Button({ label: 'Close', secondary: true, onClick: e => e.ui.exit() })), navigation(kit))));
  return flow<LeagueOpsPanelData>('review', { screens: { issues: issueScreen, operations, issue, operation, preview, confirmation, checks },
    first: 'issues', initialData: { snapshot: { issues: [], operations: [] }, page: 0, busy: false, notice: 'Choose Roster problems or Saved actions. Nothing changes until you confirm.' }, ttlMs: 10 * 60_000,
    parting: { note: 'Use the main button on the latest League Status message in staff-ops. Start a new review; expired confirmations are not used again.' } },
    { policy: policy.all(policy.owner(), policy.privilege('OPERATIONS')), onSessionEnd: event => ended(event.sessionId) });
}
