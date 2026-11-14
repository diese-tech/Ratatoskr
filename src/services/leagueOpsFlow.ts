import { redactOperationalText } from './redactOperationalText.js';
import { EventKind, action, container, flow, input, modal, policy, row, screen, text, view,
  type ActionEvent, type DeepReadonly, type ScreenKit } from 'fluxcord';
import { LeagueJobBlockedError } from './leagueJobWorker.js';
import { LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { leagueOpsText, type LeagueOpsIssue, type LeagueOpsOperation, type LeagueOpsReviewService,
  leagueOpsRepairAction, type LeagueOpsSnapshot, type ReviewAccountReplacementPreview, type ReviewTransactionPreview, type ReviewRepairPreview, type ReviewRecoveryPreview } from './leagueOpsReview.js';
import { LeagueAuditRepairNoWriteError } from './leagueAuditResolution.js';
import { draftPickVerificationText } from './draftPickTracking.js';
import { leagueFindingBody, leagueFindingTitle } from './leagueAuditPresentation.js';
import { leagueActionLabel, leagueStatusLabel, savedLeagueErrorMessage, leagueValidationMessage, leagueRepairNoWriteMessage, leagueEasternTime, leagueFixLabel, leagueFixExplanation } from './leaguePresentation.js';

export type LeagueOpsPanelData = { snapshot: LeagueOpsSnapshot; page: number; selectedIssue?: LeagueOpsIssue;
  selectedOperation?: LeagueOpsOperation; replacement?: ReviewAccountReplacementPreview; transaction?: ReviewTransactionPreview;
  repair?: ReviewRepairPreview;
  recovery?: ReviewRecoveryPreview;
  samePlayerConfirmed?: boolean; busy: boolean; notice: string; queued?: string };
const PAGE_SIZE = 5;
const NOTHING_YET = 'Nothing changes until you press Confirm.';
/** Each panel sends one fix; after that its change buttons stay off on purpose (#206 rule 7). */
export function leagueOpsLockedText(reference: string): string {
  return `You already sent a fix from this panel (${reference}). It’s saved and being done, so don’t send it again.
To fix another problem, press Review problems on the League Status card.`;
}
const statusLines = (data: DeepReadonly<LeagueOpsPanelData>, fallback = NOTHING_YET) =>
  [...(data.queued ? [text(leagueOpsLockedText(data.queued))] : []), text(data.notice || fallback)];
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
      ...(p.layeredAfter ? [`Keep their ${p.layeredAfter.division} team too: ${p.layeredAfter.franchise}, ${p.layeredAfter.rosterStatus}.`] : []),
      'Keep the old account and names in history. Add one current name for the new account. Past transactions keep their original account IDs.',
      `Name History row ${p.oldNameAfter.sheetRow}: ${p.oldNameBefore.currentLeagueName} / ${p.oldNameBefore.knownName} → Previous / Alternate.`,
      `New current name in row ${p.newName.sheetRow}: ${p.newName.currentLeagueName}; preserve ${p.preservedHistory.nameRows.length} past-name rows.`,
      `Public name: ${p.publicChanges.length ? p.publicChanges.map(c => `${c.from} → ${c.to}`).join('; ') : 'unchanged and checked'}.`,
      ...p.roles.map(r => `Account ${r.discordId}: roles to add ${r.add.map(id => replacement.roleLabels?.[id] ?? id).join(', ') || 'none'}; remove ${r.remove.map(id => replacement.roleLabels?.[id] ?? id).join(', ') || 'none'}.`),
      ...p.manualReview, `Draft Picks: ${draftPickVerificationText(replacement.draftVerification)}.`,
      `Earlier saved fixes: ${replacement.preservedJobReferences.join(', ') || 'none linked'}.`].join('\n');
  }
  if (data.recovery) return `Close the checked action: ${data.recovery.reference}\n${data.recovery.description}\nCheck the saved names and history first. This closes the unfinished action after checking today’s records. It does not run the old change again or say the old attempt succeeded.`;
  if (data.repair) return [leagueFindingTitle(data.repair.finding), '', 'What will change:', ...data.repair.description.split('\n').map(line => `- ${line}`), '',
    'Rat checks everything again when you confirm. Nothing has changed yet.'].join('\n');
  const plan = data.transaction?.plan;
  return plan ? [`${leagueActionLabel(plan.kind)}: ${plan.players.join(' / ')}`, ...plan.publicChanges.map(c => `${c.division} / ${c.group}: ${c.from || 'empty'} → ${c.to || 'empty'}`),
    `Earlier action needing review: ${data.transaction!.originalReference}.`, 'This shows a new preview. Rat will not run the earlier action again.'].join('\n') : 'No approved preview is available.';
}
export function createLeagueOpsFlow(service: LeagueOpsReviewService, ended: (id: string) => void = () => {}) {
  const run = (event: ActionEvent<LeagueOpsPanelData>, work: () => Promise<Partial<LeagueOpsPanelData>>, readOnly = false, loading = 'Checking the latest league records…') => {
    if (event.session.data.busy || (event.session.data.queued && !readOnly)) return;
    event.mutate(data => { data.busy = true; data.notice = loading; });
    event.launch(async job => {
      try { const changes = await work(); job.mutate(data => { Object.assign(data, changes); }); }
      catch (error) {
        const message = error instanceof LeagueMutationValidationError ? leagueValidationMessage(error.message)
          : error instanceof LeagueAuditRepairNoWriteError ? leagueRepairNoWriteMessage(error.message)
          : error instanceof LeagueJobBlockedError ? savedLeagueErrorMessage(error.message)
          : 'Rat couldn’t finish this step. Press Review problems on the League Status card to start again. If you already confirmed a fix, check Saved actions instead of sending it again.';
        job.mutate(data => { data.notice = leagueOpsText(message); });
      } finally { job.mutate(data => { data.busy = false; }); }
    });
  };
  const refresh = action<LeagueOpsPanelData>()(async event => {
    if (event.session.data.busy) return;
    const previousIssue = event.session.data.selectedIssue;
    const previousOperation = event.session.data.selectedOperation;
    const hadPreview = !!(event.session.data.replacement || event.session.data.transaction || event.session.data.repair || event.session.data.recovery);

    // Fluxcord 0.2.2 keeps modal nonces on ordinary redraws and same-screen go.
    // Two navigation transitions invalidate pending modals without a new session.
    const activeScreen = event.session.screen;
    const previewScreen = activeScreen === 'preview' || activeScreen === 'confirmation';
    const screen = previewScreen
      ? event.session.data.replacement || event.session.data.repair ? 'issue' : 'operation'
      : activeScreen;
    event.mutate(data => { Object.assign(data, clearedPreview); data.busy = true; data.notice = 'Reloading saved status…'; });
    event.ui.go(screen === 'issues' ? 'operations' : 'issues');
    event.ui.go(screen);
    // Saved reads stay in this interaction so navigation uses their reconciled result.
    try {
      const snapshot = await service.snapshot(event.actorId);
      const selectedIssue = previousIssue ? snapshot.issues.find(issue => issue.key === previousIssue.key
        && issue.finding === previousIssue.finding && issue.oldDiscordId === previousIssue.oldDiscordId
        && issue.requiresManualReview === previousIssue.requiresManualReview) : undefined;
      let selectedOperation: LeagueOpsOperation | undefined;
      if (previousOperation) {
        try { selectedOperation = await service.operationDetail(event.actorId, previousOperation.reference, true); }
        catch (error) { if (!(error instanceof LeagueMutationValidationError)) throw error; }
      }
      event.mutate(data => { Object.assign(data, { snapshot, selectedIssue, selectedOperation,
        notice: 'Saved status reloaded. No new Discord or Sheets check was run.'
          + (previousIssue && !selectedIssue ? ' This problem changed or is no longer listed. Choose a problem again.' : '')
          + (previousOperation && !selectedOperation ? ' This saved action is no longer available.' : '')
          + (event.session.data.queued ? ' Accepted work is unchanged. Check Saved actions for its result.'
            : hadPreview ? ' The unconfirmed preview was cleared. Request a new preview before approving.' : '') }); });
      const destination = screen === 'issue' && !selectedIssue ? 'issues'
        : screen === 'operation' && !selectedOperation ? 'operations' : screen;
      event.ui.go(destination);
    } catch {
      event.mutate(data => { data.selectedIssue = undefined; data.selectedOperation = undefined;
        data.notice = 'Saved status could not be loaded. Unconfirmed previews were cleared. Accepted work is unchanged; check Saved actions.'; });
      event.ui.go(screen === 'issue' ? 'issues' : screen === 'operation' ? 'operations' : screen);
    } finally { event.mutate(data => { data.busy = false; }); }
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
    run(event, async () => ({ ...clearedPreview, repair: await service.previewRepair(event.actorId, issue.key), notice: `Check the changes below. ${NOTHING_YET}` }));
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
        notice: `Sent. Rat is making this change now (${leagueStatusLabel(job.status).toLowerCase()}). You can follow it in Saved actions.` };
    });
  });
  const navigation = (kit: ScreenKit<LeagueOpsPanelData>) => row({},
    kit.Button({ label: 'Roster problems', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; Object.assign(d, clearedPreview); d.notice = ''; }); event.ui.go('issues'); } }),
    kit.Button({ label: 'Saved actions', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; Object.assign(d, clearedPreview); d.notice = ''; }); event.ui.go('operations'); } }),
    kit.Button({ label: 'Check details', secondary: true, onClick: event => { if (!event.session.data.busy) { event.mutate(d => { d.page = 0; }); event.ui.go('checks'); } } }),
    kit.Button({ label: 'Reload saved status', secondary: true, onClick: refresh }),
    kit.Button({ label: 'Close panel', secondary: true, onClick: event => event.ui.exit() }));
  // Paging buttons appear only when there is somewhere to go, so none sit greyed out without a reason.
  const pager = (kit: ScreenKit<LeagueOpsPanelData>, page: number, total: number) => {
    const buttons = [
      ...(page > 0 ? [kit.Button({ label: 'Previous', secondary: true, onClick: e => e.mutate(d => { d.page = Math.max(0, d.page - 1); }) })] : []),
      ...((page + 1) * PAGE_SIZE < total ? [kit.Button({ label: 'Next', secondary: true, onClick: e => e.mutate(d => { d.page++; }) })] : []),
    ];
    return buttons.length ? [row({}, ...buttons)] : [];
  };
  const issueScreen = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.issues.length / PAGE_SIZE) - 1));
    const issues = data.snapshot.issues.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const count = data.snapshot.issues.length;
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Roster problems' },
      count ? `${count} roster problem${count === 1 ? '' : 's'}. Pick one to look at.` : 'No roster problems found. Nothing needs doing.'),
      ...(data.snapshot.draftNeedsAttention ? [text('Draft records need checking. Open Check details to see why and what to do.')] : []),
      text('For a new trade, drop or pickup, use /transaction. This panel fixes records that disagree and shows saved actions.'),
      ...issues.flatMap(issue => [text(leagueOpsText(leagueFindingTitle(issue.finding), 200)), row({}, kit.Button({ label: 'View problem', disabled: data.busy, onClick: event => {
        event.mutate(d => { d.selectedIssue = issue; d.notice = ''; }); event.ui.go('issue');
      } }))]),
      ...statusLines(data), ...pager(kit, page, count), navigation(kit)));
  });
  const operations = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.operations.length / PAGE_SIZE) - 1));
    const items = data.snapshot.operations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const count = data.snapshot.operations.length;
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Saved actions' },
      count ? `${count} unfinished action${count === 1 ? '' : 's'}. Open one to see how it’s going.` : 'No unfinished actions. Nothing needs doing.'),
      ...items.flatMap(operation => [text(`${operation.reference} · ${leagueActionLabel(operation.type)} · ${leagueStatusLabel(operation.status)}`), row({}, kit.Button({ label: 'View action', disabled: data.busy, onClick: e => {
        e.mutate(d => { d.selectedOperation = { ...operation, targets: [...operation.targets], historyDetails: operation.historyDetails ? [...operation.historyDetails] : undefined, linkedReferences: operation.linkedReferences ? [...operation.linkedReferences] : undefined }; d.notice = ''; }); e.ui.go('operation');
      } }))]), ...statusLines(data), ...pager(kit, page, count),
      row({}, kit.Button({ label: 'Find by reference', disabled: data.busy, secondary: true, onClick: findOperation })), navigation(kit)));
  });
  // Moves to the next problem without changing anything.
  const skip = action<LeagueOpsPanelData>()(event => {
    if (event.session.data.busy) return;
    const issues = event.session.data.snapshot.issues;
    const index = issues.findIndex(item => item.key === event.session.data.selectedIssue?.key);
    const next = index >= 0 ? issues[index + 1] : undefined;
    event.mutate(d => {
      Object.assign(d, clearedPreview);
      if (next) { d.selectedIssue = { ...next }; d.notice = 'Skipped. Nothing was changed.'; }
      else { d.page = 0; d.notice = 'That was the last problem. Nothing was changed.'; }
    });
    if (!next) event.ui.go('issues');
  });
  const issue = screen<LeagueOpsPanelData>()((data, kit) => {
    const finding = data.selectedIssue?.finding;
    const fix = data.selectedIssue?.requiresManualReview ? undefined : leagueOpsRepairAction(finding ?? '');
    const departed = !!data.selectedIssue?.oldDiscordId;
    return view({}, container({ color: 0x2f6844 },
      text({ title: leagueOpsText(finding ? leagueFindingTitle(finding) : 'League tools · Roster problem', 200) },
        leagueOpsText(finding ? leagueFindingBody(finding) : 'Choose a current roster problem.')),
      text(departed ? 'What happened?\n- Same player, new Discord account: press Player changed Discord account.\n- They left the league: run /transaction departure.\n- They dropped themselves: run /transaction self-drop.\nEach one shows you the changes before anything happens.'
        : leagueFixExplanation(fix)),
      ...(departed ? [row({}, kit.Button({ label: 'Player changed Discord account', disabled: !!data.queued, onClick: replacement }))] : []),
      ...(!departed && fix ? [row({}, kit.Button({ label: leagueFixLabel(fix), disabled: !!data.queued, onClick: repairPreview }))] : []),
      row({}, kit.Button({ label: 'Skip for now', secondary: true, disabled: data.busy, onClick: skip })),
      ...statusLines(data), navigation(kit)));
  });
  const operation = screen<LeagueOpsPanelData>()((data, kit) => {
    const op = data.selectedOperation;
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Saved action' }, op ?
      [`Reference: ${op.reference}`, `Action: ${leagueActionLabel(op.action)}`, `Status: ${leagueStatusLabel(op.status)}`,
        `Requested: ${leagueEasternTime(op.createdAt)}; requested by: ${op.actor}`, `Affected players or teams: ${op.targets.join('; ') || 'See the saved problem'}`,
        ...(op.historyDetails ?? []), `What happened: ${savedLeagueErrorMessage(op.error)}`, `What to do: ${op.next}`].map(line => leagueOpsText(line, 1700)).join('\n') : 'Choose a saved action.'),
      ...(op?.linkedReferences ?? []).map(reference => row({}, kit.Button({ label: 'View linked action', secondary: true, disabled: data.busy, onClick: event => {
        run(event, async () => ({ selectedOperation: await service.operationDetail(event.actorId, reference), notice: 'Linked history loaded.' }), true);
      } }))),
      ...(op?.canRepreview || op?.canRecover ? [row({},
        ...(op.canRepreview ? [kit.Button({ label: 'Preview player change', disabled: !!data.queued, onClick: repreview })] : []),
        ...(op.canRecover ? [kit.Button({ label: 'Check unfinished changes', disabled: !!data.queued, secondary: true, onClick: recoveryPreview })] : []))] : []),
      ...statusLines(data), navigation(kit)));
  });
  const checks = screen<LeagueOpsPanelData>()((data, kit) => {
    const pages = leagueCheckDetailPages(data.snapshot.checkDetails ?? ['Reload saved status to load saved check details.']);
    const page = Math.min(data.page, pages.length - 1);
    const buttons = [
      ...(page > 0 ? [kit.Button({ label: 'Previous details', secondary: true, onClick: event => event.mutate(d => { d.page = Math.max(0, page - 1); }) })] : []),
      ...(page < pages.length - 1 ? [kit.Button({ label: 'Next details', secondary: true, onClick: event => event.mutate(d => { d.page = page + 1; }) })] : []),
    ];
    return view({}, container({ color: 0x2f6844 },
      text({ title: `League tools · Check details · ${page + 1} of ${pages.length}` }, 'Checks only read records. They never change the roster.'),
      text(leagueOpsText(pages[page]!, 3000)), text(data.notice || 'These are saved check results.'), ...(data.queued ? [text(leagueOpsLockedText(data.queued))] : []),
      ...(buttons.length ? [row({}, ...buttons)] : []), navigation(kit)));
  });
  const approvalLabel = (data: DeepReadonly<LeagueOpsPanelData>) => data.recovery ? 'Close checked action' : data.replacement ? 'Change Discord account' : data.repair ? leagueFixLabel(data.repair.action) : 'Approve player change';
  const preview = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Review changes' }, leagueOpsText(leagueOpsPreviewText(data), 3400)),
    ...statusLines(data, `${NOTHING_YET} The button below opens the final check.`),
    ...(data.recovery && !data.recovery.canConfirm ? [text('Fix the problems listed above first. This action can be closed once Discord and our records agree.')] : []),
    row({}, kit.Button({ label: approvalLabel(data), disabled: data.busy || !!data.queued || (data.recovery && !data.recovery.canConfirm) || (!data.replacement && !data.transaction && !data.repair && !data.recovery), onClick: confirm }),
      kit.Button({ label: 'Cancel and close', secondary: true, onClick: e => e.ui.exit() })), navigation(kit))));
  const confirmation = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Confirm changes' }, leagueOpsText(leagueOpsPreviewText(data), 3400)),
    ...statusLines(data), row({}, kit.Button({ label: 'Confirm changes', success: true, disabled: data.busy || !!data.queued, onClick: confirm }),
      kit.Button({ label: 'Close panel', secondary: true, onClick: e => e.ui.exit() })), navigation(kit))));
  return flow<LeagueOpsPanelData>('review', { screens: { issues: issueScreen, operations, issue, operation, preview, confirmation, checks },
    first: 'issues', initialData: { snapshot: { issues: [], operations: [] }, page: 0, busy: false, notice: `Choose Roster problems or Saved actions. ${NOTHING_YET}` }, ttlMs: 10 * 60_000,
    parting: { note: 'Use the main button on the latest League Status message in staff-ops. Start a new review; expired confirmations are not used again.' } },
    { policy: policy.all(policy.owner(), policy.privilege('OPERATIONS')), onSessionEnd: event => ended(event.sessionId) });
}
