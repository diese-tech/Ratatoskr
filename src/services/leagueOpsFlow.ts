import { EventKind, action, container, flow, input, modal, policy, row, screen, text, view,
  type ActionEvent, type DeepReadonly, type ScreenKit } from 'fluxcord';
import { LeagueJobBlockedError } from './leagueJobWorker.js';
import { LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { leagueOpsText, type LeagueOpsIssue, type LeagueOpsOperation, type LeagueOpsReviewService,
  leagueOpsRepairAction, type LeagueOpsSnapshot, type ReviewTransactionPreview, type ReviewRepairPreview, type ReviewRecoveryPreview } from './leagueOpsReview.js';
import { LeagueAuditRepairNoWriteError } from './leagueAuditResolution.js';
import type { AccountReplacementPreview } from './leagueAccountReplacement.js';

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
      `${p.rosterAfter.division} / ${p.rosterAfter.franchise} / ${p.rosterAfter.rosterStatus}; same roster row ${p.rosterAfter.sheetRow}.`,
      'Retire the old current-name entry; preserve all aliases and historical transaction IDs. Establish one new current-name record.',
      `Name History row ${p.oldNameAfter.sheetRow}: ${p.oldNameBefore.currentLeagueName} / ${p.oldNameBefore.knownName} → Previous / Alternate.`,
      `New current-name row ${p.newName.sheetRow}: ${p.newName.currentLeagueName}; preserve ${p.preservedHistory.nameRows.length} existing alternate-name rows.`,
      `Public name: ${p.publicChanges.length ? p.publicChanges.map(c => `${c.from} → ${c.to}`).join('; ') : 'unchanged, still verified'}.`,
      ...p.roles.map(r => `Account ${r.discordId}: managed roles add ${r.add.join(', ') || 'none'}; remove ${r.remove.join(', ') || 'none'}.`),
      ...p.manualReview, `Draft Picks: ${replacement.draftVerification === 'verified' ? 'identity and move continuity checked' : 'tracking tab is missing; draft verification was skipped'}.`,
      `Original repair evidence: ${replacement.preservedJobReferences.join(', ') || 'none linked'}.`].join('\n');
  }
  if (data.recovery) return `Reconciliation acknowledgement for ${data.recovery.reference}\n${data.recovery.description}\nInspect preserved name/history records. This closes the verified interrupted record without replaying its mutation or claiming its old write succeeded.`;
  if (data.repair) return `${data.repair.finding}\n\n${data.repair.description}\nFresh source values are bound to this approval. No changes were made.`;
  const plan = data.transaction?.plan;
  return plan ? [`${plan.kind}: ${plan.players.join(' / ')}`, ...plan.publicChanges.map(c => `${c.division} / ${c.group}: ${c.from || 'empty'} → ${c.to || 'empty'}`),
    `Original blocked reference: ${data.transaction!.originalReference}.`, 'This is a fresh preview. The original approval will not be replayed.'].join('\n') : 'No approved preview is available.';
}
export function createLeagueOpsFlow(service: LeagueOpsReviewService, ended: (id: string) => void = () => {}) {
  const run = (event: ActionEvent<LeagueOpsPanelData>, work: () => Promise<Partial<LeagueOpsPanelData>>) => {
    if (event.session.data.busy || event.session.data.queued) return;
    event.mutate(data => { data.busy = true; data.notice = 'Checking fresh league state…'; });
    event.launch(async job => {
      try { const changes = await work(); job.mutate(data => { Object.assign(data, changes); }); }
      catch (error) {
        const message = error instanceof LeagueMutationValidationError || error instanceof LeagueJobBlockedError || error instanceof LeagueAuditRepairNoWriteError
          ? error.message : 'This review could not finish. Reopen League Ops from the current status card. If you submitted confirmation, inspect Operations before trying again.';
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
      return { snapshot, ...(selectedOperation ? { selectedOperation } : {}), notice: 'Current saved state loaded.' };
    });
  });
  const findOperation = action<LeagueOpsPanelData>()(async event => {
    if (event.session.data.busy) return;
    if (event.kind !== EventKind.ModalSubmit) {
      await event.ui.showModal(modal({ title: 'Inspect an operation reference' },
        input({ id: 'reference', label: 'Durable YSL operation reference', required: true, maxLength: 64 })));
      return;
    }
    const reference = String(event.inputs?.reference ?? '').trim();
    event.ui.go('operation');
    run(event, async () => ({ selectedOperation: await service.operationDetail(event.actorId, reference), notice: 'Current durable operation state loaded.' }));
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
        notice: 'Fresh replacement preview. Review manual captain/staff access separately before confirming.' };
    });
  });
  const repreview = action<LeagueOpsPanelData>()(event => {
    const operation = event.session.data.selectedOperation;
    if (!operation?.canRepreview || event.session.data.replacement || event.session.data.transaction) return;
    event.ui.go('preview');
    run(event, async () => {
      const preview = await service.previewTransaction(event.actorId, operation.reference);
      return { transaction: preview, notice: 'Review the freshly computed transaction. No changes were made.' };
    });
  });
  const repairPreview = action<LeagueOpsPanelData>()(event => {
    const issue = event.session.data.selectedIssue;
    if (!issue || event.session.data.replacement || event.session.data.transaction || event.session.data.repair) return;
    event.ui.go('preview');
    run(event, async () => ({ repair: await service.previewRepair(event.actorId, issue.key), notice: 'Review the exact fresh repair, then confirm explicitly.' }));
  });
  const recoveryPreview = action<LeagueOpsPanelData>()(event => {
    const operation = event.session.data.selectedOperation;
    if (!operation?.canRecover || event.session.data.recovery) return;
    event.ui.go('preview');
    run(event, async () => ({ recovery: await service.previewRecovery(event.actorId, operation.reference), notice: 'Inspect fresh convergence and preserved history before acknowledging reconciliation.' }));
  });
  const confirm = action<LeagueOpsPanelData>()(async event => {
    const data = event.session.data;
    if (data.busy || data.queued || (!data.replacement && !data.transaction && !data.repair && !data.recovery)) return;
    if (event.kind !== EventKind.ModalSubmit) {
      await event.ui.showModal(modal({ title: data.recovery ? 'Acknowledge reconciliation' : data.replacement ? 'Confirm account replacement' : data.repair ? 'Confirm audit repair' : 'Confirm fresh transaction' },
        text(leagueOpsPreviewText(data).slice(0, 2000)),
        input({ id: 'confirm', label: data.recovery ? 'Type HISTORY REVIEWED after checking history' : 'Type CONFIRM to approve this exact preview', required: true, maxLength: 20 })));
      return;
    }
    if (String(event.inputs?.confirm).trim() !== (data.recovery ? 'HISTORY REVIEWED' : 'CONFIRM')) {
      event.mutate(d => { d.notice = data.recovery ? 'Type HISTORY REVIEWED after checking the preserved history.' : 'Type CONFIRM to submit this exact reviewed operation.'; });
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
        notice: `Operation ${job.status.toLowerCase().replaceAll('_', ' ')}. Reference: ${job.reference}. Reopen Operations for durable progress.` };
    });
  });
  const navigation = (kit: ScreenKit<LeagueOpsPanelData>) => row({},
    kit.Button({ label: 'Issues', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; }); event.ui.go('issues'); } }),
    kit.Button({ label: 'Operations', secondary: true, onClick: event => { if (event.session.data.busy) return; event.mutate(d => { d.page = 0; }); event.ui.go('operations'); } }),
    kit.Button({ label: 'Refresh', secondary: true, onClick: refresh }),
    kit.Button({ label: 'Close', secondary: true, onClick: event => event.ui.exit() }));
  const issueScreen = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.issues.length / PAGE_SIZE) - 1));
    const issues = data.snapshot.issues.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League Ops · Issues' },
      data.snapshot.issues.length ? `${data.snapshot.issues.length} current findings. Select an issue privately.` : 'No current roster findings.'),
      ...issues.flatMap(issue => [text(leagueOpsText(issue.finding, 450)), row({}, kit.Button({ label: 'Inspect issue', disabled: data.busy, onClick: event => {
        event.mutate(d => { d.selectedIssue = issue; d.notice = ''; }); event.ui.go('issue');
      } }))]),
      text(data.notice || 'Review is read-only until explicit confirmation.'), row({}, kit.Button({ label: 'Previous', secondary: true, disabled: page === 0, onClick: e => e.mutate(d => { d.page = Math.max(0, d.page - 1); }) }),
        kit.Button({ label: 'Next', secondary: true, disabled: (page + 1) * PAGE_SIZE >= data.snapshot.issues.length, onClick: e => e.mutate(d => { d.page++; }) })), navigation(kit)));
  });
  const operations = screen<LeagueOpsPanelData>()((data, kit) => {
    const page = Math.min(data.page, Math.max(0, Math.ceil(data.snapshot.operations.length / PAGE_SIZE) - 1));
    const items = data.snapshot.operations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League Ops · Operations' }, `${data.snapshot.operations.length} operations needing attention. Historical attempts remain preserved.`),
      ...items.flatMap(operation => [text(`${operation.reference} · ${operation.type} · ${operation.status}`), row({}, kit.Button({ label: 'Inspect operation', disabled: data.busy, onClick: e => {
        e.mutate(d => { d.selectedOperation = { ...operation, targets: [...operation.targets] }; d.notice = ''; }); e.ui.go('operation');
      } }))]), text(data.notice || 'Review is read-only until explicit confirmation.'), row({}, kit.Button({ label: 'Previous', secondary: true, disabled: page === 0, onClick: e => e.mutate(d => { d.page = Math.max(0, d.page - 1); }) }),
        kit.Button({ label: 'Next', secondary: true, disabled: (page + 1) * PAGE_SIZE >= data.snapshot.operations.length, onClick: e => e.mutate(d => { d.page++; }) })),
      row({}, kit.Button({ label: 'Find operation reference', disabled: data.busy, secondary: true, onClick: findOperation })), navigation(kit)));
  });
  const issue = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League Ops · Issue detail' }, leagueOpsText(data.selectedIssue?.finding ?? 'Select a current issue.')),
    text(data.selectedIssue?.oldDiscordId ? 'Choose the event that actually happened. Account replacement continues one player; departure and self-drop use the existing transaction previews.' : 'Resolve this finding through the managed sheet/audit workflow. Refresh after correcting its source.'),
    row({}, kit.Button({ label: 'Player changed Discord account', disabled: !data.selectedIssue?.oldDiscordId, onClick: replacement })),
    row({}, kit.Button({ label: 'Preview managed repair', disabled: !!data.selectedIssue?.oldDiscordId || !leagueOpsRepairAction(data.selectedIssue?.finding ?? ''), onClick: repairPreview })),
    text('Left league: /transaction departure. Self-dropped: /transaction self-drop. Both require a separate preview and explicit confirmation.'), text(data.notice || 'Review is read-only until explicit confirmation.'), navigation(kit))));
  const operation = screen<LeagueOpsPanelData>()((data, kit) => {
    const op = data.selectedOperation;
    return view({}, container({ color: 0x2f6844 }, text({ title: 'League Ops · Operation detail' }, op ?
      [`Reference: ${op.reference}`, `Type/action: ${op.type} / ${op.action}`, `State: ${op.status}; attempts: ${op.attempts}`,
        `Created: ${op.createdAt}; actor: ${op.actor}`, `Targets: ${op.targets.join('; ') || 'See saved finding'}`,
        `Saved error: ${op.error}`, `Next: ${op.next}`].map(line => leagueOpsText(line, 1700)).join('\n') : 'Select an operation.'),
      row({}, kit.Button({ label: 'Fresh transaction preview', disabled: !op?.canRepreview, onClick: repreview }),
        kit.Button({ label: 'Inspect reconciliation', disabled: !op?.canRecover, secondary: true, onClick: recoveryPreview })), text(data.notice || 'Review is read-only until explicit confirmation.'), navigation(kit)));
  });
  const preview = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League Ops · Resolution preview' }, leagueOpsText(leagueOpsPreviewText(data), 3400)), text(data.notice || 'Review is read-only until explicit confirmation.'),
    row({}, kit.Button({ label: 'Review confirmation', disabled: data.busy || (data.recovery && !data.recovery.canConfirm) || (!data.replacement && !data.transaction && !data.repair && !data.recovery), onClick: e => e.ui.go('confirmation') }),
      kit.Button({ label: 'Cancel and close', secondary: true, onClick: e => e.ui.exit() })))));
  const confirmation = screen<LeagueOpsPanelData>()((data, kit) => view({}, container({ color: 0x2f6844 },
    text({ title: 'League Ops · Explicit confirmation' }, leagueOpsText(leagueOpsPreviewText(data), 3400)),
    text(data.notice || 'Review is read-only until explicit confirmation.'), row({}, kit.Button({ label: 'Confirm this reviewed operation', success: true, disabled: data.busy || !!data.queued, onClick: confirm }),
      kit.Button({ label: 'Close', secondary: true, onClick: e => e.ui.exit() })))));
  return flow<LeagueOpsPanelData>('review', { screens: { issues: issueScreen, operations, issue, operation, preview, confirmation },
    first: 'issues', initialData: { snapshot: { issues: [], operations: [] }, page: 0, busy: false, notice: 'Choose a private read-only issue or operation view.' }, ttlMs: 10 * 60_000,
    parting: { note: 'Reopen Review League Ops on the current staff-ops status card. No expired approval is resumed.' } },
    { policy: policy.all(policy.owner(), policy.privilege('OPERATIONS')), onSessionEnd: event => ended(event.sessionId) });
}
