import { EventKind, action, container, flow, input, modal, policy, row, screen, text, view,
  type ActionEvent, type DeepReadonly, type ScreenKit } from 'fluxcord';
import { LeagueJobBlockedError } from './leagueJobWorker.js';
import { LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { leagueOpsText, type LeagueOpsIssue, type LeagueOpsOperation, type LeagueOpsReviewService,
  leagueOpsRepairAction, type LeagueOpsSnapshot, type ReviewTransactionPreview, type ReviewRepairPreview, type ReviewRecoveryPreview } from './leagueOpsReview.js';
import { LeagueAuditRepairNoWriteError } from './leagueAuditResolution.js';
import type { AccountReplacementPreview } from './leagueAccountReplacement.js';
import { draftPickVerificationText } from './draftPickTracking.js';
import { leagueActionLabel, leagueStatusLabel, savedLeagueErrorMessage, leagueValidationMessage, leagueRepairNoWriteMessage } from './leaguePresentation.js';

export type LeagueOpsPanelData = { snapshot: LeagueOpsSnapshot; page: number; selectedIssue?: LeagueOpsIssue;
  selectedOperation?: LeagueOpsOperation; replacement?: AccountReplacementPreview; transaction?: ReviewTransactionPreview;
  repair?: ReviewRepairPreview;
  recovery?: ReviewRecoveryPreview;
  samePlayerConfirmed?: boolean; busy: boolean; notice: string; queued?: string };
const PAGE_SIZE = 5;
export function leagueOpsPreviewText(data: DeepReadonly<Pick<LeagueOpsPanelData, 'replacement' | 'transaction' | 'repair' | 'recovery'>>): string {
  const replacement = data.replacement;
  if (replacement) {
    const p = replacement.plan;
    return [`${p.oldDiscordId} → ${p.newDiscordId}`, `${p.rosterBefore.player} → ${p.rosterAfter.player}`,
      `${p.rosterAfter.division} / ${p.rosterAfter.franchise} / ${p.rosterAfter.rosterStatus}; keep roster row ${p.rosterAfter.sheetRow}.`,
      'Keep the old account and names in history. Add one current name for the new account. Past transactions keep their original account IDs.',
      `Name History row ${p.oldNameAfter.sheetRow}: ${p.oldNameBefore.currentLeagueName} / ${p.oldNameBefore.knownName} → Previous / Alternate.`,
      `New current name in row ${p.newName.sheetRow}: ${p.newName.currentLeagueName}; preserve ${p.preservedHistory.nameRows.length} past-name rows.`,
      `Public name: ${p.publicChanges.length ? p.publicChanges.map(c => `${c.from} → ${c.to}`).join('; ') : 'unchanged and checked'}.`,
      ...p.roles.map(r => `Account ${r.discordId}: roles to add ${r.add.join(', ') || 'none'}; remove ${r.remove.join(', ') || 'none'}.`),
      ...p.manualReview, `Draft Picks: ${draftPickVerificationText(replacement.draftVerification)}.`,
      `Earlier saved fixes: ${replacement.preservedJobReferences.join(', ') || 'none linked'}.`].join('\n');
  }
  if (data.recovery) return `Close the checked action: ${data.recovery.reference}\n${data.recovery.description}\nCheck the saved names and history first. This closes the unfinished action after checking today’s records. It does not run the old change again or say the old attempt succeeded.`;
  if (data.repair) return `${data.repair.finding}\n\n${data.repair.description}\nRat will check the same records again when you confirm. No changes were made.`;
  const plan = data.transaction?.plan;
  return plan ? [`${leagueActionLabel(plan.kind)}: ${plan.players.join(' / ')}`, ...plan.publicChanges.map(c => `${c.division} / ${c.group}: ${c.from || 'empty'} → ${c.to || 'empty'}`),
    `Earlier action needing review: ${data.transaction!.originalReference}.`, 'This shows a new preview. Rat will not run the earlier action again.'].join('\n') : 'No approved preview is available.';
}
export function createLeagueOpsFlow(service: LeagueOpsReviewService, ended: (id: string) => void = () => {}) {
  const run = (event: ActionEvent<LeagueOpsPanelData>, work: () => Promise<Partial<LeagueOpsPanelData>>) => {
    if (event.session.data.busy || event.session.data.queued) return;
    event.mutate(data => { data.busy = true; data.notice = 'Checking the latest league records…'; });
    event.launch(async job => {
      try { const changes = await work(); job.mutate(data => { Object.assign(data, changes); }); }
      catch (error) {
        const message = error instanceof LeagueMutationValidationError ? leagueValidationMessage(error.message)
          : error instanceof LeagueAuditRepairNoWriteError ? leagueRepairNoWriteMessage(error.message)
          : error instanceof LeagueJobBlockedError ? savedLeagueErrorMessage(error.message)
          : 'Rat could not finish this review. Open league tools from the latest League Status message and ask staff to check Saved actions. If you already confirmed, do not repeat the action.';
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
    });
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
    run(event, async () => ({ selectedOperation: await service.operationDetail(event.actorId, reference), notice: 'Latest saved action loaded.' }));
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
      return { replacement: preview, samePlayerConfirmed: true,
        notice: 'Review the account change. Check any captain or staff roles listed below before confirming.' };
    });
  });
  const repreview = action<LeagueOpsPanelData>()(event => {
    const operation = event.session.data.selectedOperation;
    if (!operation?.canRepreview || event.session.data.replacement || event.session.data.transaction) return;
    event.ui.go('preview');
    run(event, async () => {
      const preview = await service.previewTransaction(event.actorId, operation.reference);
      return { transaction: preview, notice: 'Review these player changes. No changes were made.' };
    });
  });
  const repairPreview = action<LeagueOpsPanelData>()(event => {
    const issue = event.session.data.selectedIssue;
    if (!issue || event.session.data.replacement || event.session.data.transaction || event.session.data.repair) return;
    event.ui.go('preview');
    run(event, async () => ({ repair: await service.previewRepair(event.actorId, issue.key), notice: 'Review this fix, then confirm if it is correct.' }));
  });
  const recoveryPreview = action<LeagueOpsPanelData>()(event => {
    const operation = event.session.data.selectedOperation;
    if (!operation?.canRecover || event.session.data.recovery) return;
    event.ui.go('preview');
    run(event, async () => ({ recovery: await service.previewRecovery(event.actorId, operation.reference), notice: 'Check that Discord and the sheets agree, then review the saved history before closing this action.' }));
  });
  const confirm = action<LeagueOpsPanelData>()(async event => {
    const data = event.session.data;
    if (data.busy || data.queued || (!data.replacement && !data.transaction && !data.repair && !data.recovery)) return;
    if (event.kind !== EventKind.ModalSubmit) {
      await event.ui.showModal(modal({ title: data.recovery ? 'Close checked action' : data.replacement ? 'Confirm account replacement' : data.repair ? 'Confirm roster fix' : 'Confirm player change' },
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
    kit.Button({ label: 'Roster problems', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; }); event.ui.go('issues'); } }),
    kit.Button({ label: 'Saved actions', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; }); event.ui.go('operations'); } }),
    kit.Button({ label: 'Refresh', secondary: true, onClick: refresh }),
    kit.Button({ label: 'Close', secondary: true, onClick: event => event.ui.exit() }));
  const issueScreen = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.issues.length / PAGE_SIZE) - 1));
    const issues = data.snapshot.issues.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Roster problems' },
      data.snapshot.issues.length ? `${data.snapshot.issues.length} roster problems. Choose one to review.` : 'No roster problems found.'),
      ...issues.flatMap(issue => [text(leagueOpsText(issue.finding, 450)), row({}, kit.Button({ label: 'View problem', disabled: data.busy, onClick: event => {
        event.mutate(d => { d.selectedIssue = issue; d.notice = ''; }); event.ui.go('issue');
      } }))]),
      text(data.notice || 'Nothing changes until you confirm.'), row({}, kit.Button({ label: 'Previous', secondary: true, disabled: page === 0, onClick: e => e.mutate(d => { d.page = Math.max(0, d.page - 1); }) }),
        kit.Button({ label: 'Next', secondary: true, disabled: (page + 1) * PAGE_SIZE >= data.snapshot.issues.length, onClick: e => e.mutate(d => { d.page++; }) })), navigation(kit)));
  });
  const operations = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.operations.length / PAGE_SIZE) - 1));
    const items = data.snapshot.operations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Saved actions' }, `${data.snapshot.operations.length} saved actions need review. Earlier attempts are kept in history.`),
      ...items.flatMap(operation => [text(`${operation.reference} · ${leagueActionLabel(operation.type)} · ${leagueStatusLabel(operation.status)}`), row({}, kit.Button({ label: 'View action', disabled: data.busy, onClick: e => {
        e.mutate(d => { d.selectedOperation = { ...operation, targets: [...operation.targets] }; d.notice = ''; }); e.ui.go('operation');
      } }))]), text(data.notice || 'Nothing changes until you confirm.'), row({}, kit.Button({ label: 'Previous', secondary: true, disabled: page === 0, onClick: e => e.mutate(d => { d.page = Math.max(0, d.page - 1); }) }),
        kit.Button({ label: 'Next', secondary: true, disabled: (page + 1) * PAGE_SIZE >= data.snapshot.operations.length, onClick: e => e.mutate(d => { d.page++; }) })),
      row({}, kit.Button({ label: 'Find by reference', disabled: data.busy, secondary: true, onClick: findOperation })), navigation(kit)));
  });
  const issue = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Roster problem' }, leagueOpsText(data.selectedIssue?.finding ?? 'Choose a current roster problem.')),
    text(data.selectedIssue?.oldDiscordId ? 'Choose what happened. If this is the same player on a new Discord account, use Player changed Discord account. For someone who left or self-dropped, use the commands below.' : 'Preview the fix below if available. Otherwise, check the named sheet and correct the problem, then refresh this view.'),
    row({}, kit.Button({ label: 'Player changed Discord account', disabled: !data.selectedIssue?.oldDiscordId, onClick: replacement })),
    row({}, kit.Button({ label: 'Preview fix', disabled: !!data.selectedIssue?.oldDiscordId || !leagueOpsRepairAction(data.selectedIssue?.finding ?? ''), onClick: repairPreview })),
    text('Left league: /transaction departure. Self-dropped: /transaction self-drop. Both require a separate preview and explicit confirmation.'), text(data.notice || 'Nothing changes until you confirm.'), navigation(kit))));
  const operation = screen<LeagueOpsPanelData>()((data, kit) => {
    const op = data.selectedOperation;
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League tools · Saved action' }, op ?
      [`Reference: ${op.reference}`, `Action: ${leagueActionLabel(op.action)}`, `Status: ${leagueStatusLabel(op.status)}; times tried: ${op.attempts}`,
        `Requested: ${op.createdAt}; requested by: ${op.actor}`, `Affected players or teams: ${op.targets.join('; ') || 'See the saved problem'}`,
        `What happened: ${savedLeagueErrorMessage(op.error)}`, `What to do: ${op.next}`].map(line => leagueOpsText(line, 1700)).join('\n') : 'Choose a saved action.'),
      row({}, kit.Button({ label: 'Preview player change', disabled: !op?.canRepreview, onClick: repreview }),
        kit.Button({ label: 'Check unfinished changes', disabled: !op?.canRecover, secondary: true, onClick: recoveryPreview })), text(data.notice || 'Nothing changes until you confirm.'), navigation(kit)));
  });
  const preview = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Review changes' }, leagueOpsText(leagueOpsPreviewText(data), 3400)), text(data.notice || 'Nothing changes until you confirm.'),
    row({}, kit.Button({ label: 'Continue to confirmation', disabled: data.busy || (data.recovery && !data.recovery.canConfirm) || (!data.replacement && !data.transaction && !data.repair && !data.recovery), onClick: e => e.ui.go('confirmation') }),
      kit.Button({ label: 'Cancel and close', secondary: true, onClick: e => e.ui.exit() })))));
  const confirmation = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League tools · Confirm changes' }, leagueOpsText(leagueOpsPreviewText(data), 3400)),
    text(data.notice || 'Nothing changes until you confirm.'), row({}, kit.Button({ label: 'Confirm changes', success: true, disabled: data.busy || !!data.queued, onClick: confirm }),
      kit.Button({ label: 'Close', secondary: true, onClick: e => e.ui.exit() })))));
  return flow<LeagueOpsPanelData>('review', { screens: { issues: issueScreen, operations, issue, operation, preview, confirmation },
    first: 'issues', initialData: { snapshot: { issues: [], operations: [] }, page: 0, busy: false, notice: 'Choose Roster problems or Saved actions. Nothing changes until you confirm.' }, ttlMs: 10 * 60_000,
    parting: { note: 'Use Open league tools on the latest League Status message in staff-ops. Start a new review; expired confirmations are not used again.' } },
    { policy: policy.all(policy.owner(), policy.privilege('OPERATIONS')), onSessionEnd: event => ended(event.sessionId) });
}
