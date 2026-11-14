# Production releases and read-only League Tools acceptance

## Owner-approved release process

Ratatoskr uses merge-to-deploy. Railway native autodeploy stays enabled for `diese-tech/Ratatoskr`, branch `main`. Do not disable or disconnect it, add a manual deployment pipeline, or introduce activation variables, protected-environment requirements or new deployment credentials. Quality gates happen before merging; an authorized merge intentionally triggers Railway deployment.

1. Develop the change on a branch and run the complete tests, application/script typechecks, production build, `git diff --check` and dependency audit.
2. Open or update the focused PR. Wait for successful Windows/Ubuntu CI and both CodeQL analyses on the exact final head. Missing, pending, failed or cancelled required checks do not pass. Report unchanged dependency findings separately; do not weaken gates or make unrelated upgrades.
3. Request Codex review on the final SHA and obtain independent source review with no unresolved blocking findings. Resolve actionable findings, validate the correction and obtain fresh review when the head changes.
4. Merge only with owner authorization. Record the reviewed head and merge SHA. Normal Railway autodeploy is the release mechanism; do not manually deploy or restart to accelerate it.
5. Verify Railway builds the merged SHA in the existing Ratatoskr service. Keep one replica, the existing `/data` volume and current build/start configuration. Wait for successful startup, Discord connectivity and canonical worker/recovery initialization before treating the release as healthy.
6. Check the League Status card and applicable read-only acceptance below. CI and Railway SUCCESS alone are not proof of private UI or transaction acceptance. Record limitations honestly.

For the ordered release-safety rollout, merge #218 first and verify its automatic deployment is healthy. Then synchronize #191 with the new main, revalidate the combined source, wait for final-head CI/CodeQL and fresh Codex/source review, and only then merge #191. Verify the second automatic deployment before declaring completion. A failed merge/deployment or storage validation stops the sequence; preserve evidence and report it. Do not bypass the SQLite safeguard, initialize replacement storage, blindly redeploy/restart or automatically roll back external state.

Existing destination: project `40ae1533-b171-461e-b2e1-8b68b4d48b39`, production environment `89f84014-d527-4496-839d-26885d1bb7c1`, Ratatoskr service `8ae03a74-c126-4939-b59c-979855a8a02f`, volume `4cd3d8a4-922b-4296-9a26-e9a785624bae` mounted at `/data`, and `DATABASE_PATH=/data/ratatoskr.db`. Retain one replica, Railpack, `npm run build` and `node /app/dist/index.js`. Lucid and YSL Archive DB are not release targets. No Railway settings change is part of this process.

## Storage, recovery and accepted risk

The owner accepts operating without a verified current production recovery backup under [ADR 0003](../adr/0003-backup-policy-and-accepted-operational-risk.md). Missing backups alone do not block source reviews, approved releases or read-only acceptance. No backup infrastructure or schedule is authorized; historical copies are not assumed current. Integrity, existing-file validation, migration safety and preserved durable recovery evidence remain mandatory.

PR #191 prevents production startup from silently creating a replacement database when the intended file is absent. Existing initialized databases retain normal migrations; local development can still create databases. Startup fails closed on invalid storage. Record available migration-ledger and integrity evidence with an explicitly read-only connection if access exists; never call application startup helpers such as `openApplicationStorage` or `openExistingDatabase` for inspection. Do not copy a live SQLite main file without its coherent WAL or restore a historical copy over current hosted data by assumption.

Production database inspection is optional when access is unavailable: say exactly what is unverified. Successful startup after the safeguard is evidence of its existing-file/initialization checks, not an independently queried migration ledger or proof of every historical record. Canonical recovery may resume proven pre-write intent and pending delivery, while ambiguous external writes retain reconciliation evidence and must not be replayed. Do not restart to test recovery or close saved operations without separate authorization.

## Clean-card human smoke checklist

P1–P5 was observed deployed at `a7838dbace7fda704753aaafff2e8adb81ec216a` on 2026-11-14. Recheck the actual revision after each release; this is historical evidence. The observed card was clean, so contextual exits could not be exercised without an eligible finding. Read-only acceptance does not require creating drift or executing a transaction.

Record time, deployment ID/SHA, operator and observed outcomes. Do not mark unperformed checks passed.

1. Verify the deployed revision and startup logs/Discord connection using read-only Railway/GitHub access. Do not restart or invoke recovery to test health.
2. In staff-ops, identify the latest Ratatoskr-owned League Status card. Record its audit timestamp and counts. Check for unexplained duplicate cards; a bounded message sample does not prove all history is duplicate-free.
3. As current OPERATIONS staff (Allfather/Aesir/Valkyrie), open your own private panel. An existing non-OPERATIONS account may test denial. Do not revoke/change roles to manufacture a case; structural ADMIN policy is unchanged.
4. Visit Roster problems → Saved actions → Check details → Roster problems. On a clean card expect no current problems, not invented exit candidates.
5. Record saved check times, then use **Reload saved status**. Expect saved data only, no renewed approval, fresh session or requested audit. Do not press public **Check again**; that is a separate explicit audit.
6. Inspect a known existing completed job through **Find by reference**; compare status/history and reload. Do not use repreview, reconciliation closure or any confirmation action.
7. Close and reopen from the status card. Expect a fresh independent session with no inherited preview/attestation. Closing does not cancel accepted work.
8. Leave a panel untouched for more than ten minutes, then use a read-only navigation control; expect expiry. Never submit CONFIRM, SAME PLAYER or HISTORY REVIEWED during read-only acceptance.
9. Compare available job/notice/history evidence before/after. There must be no new mutation approval or external roster write. Presentation/reload must not request extra full-guild reads; normal independently scheduled work may still occur, so correlate timestamps rather than attributing every background event to the smoke test.

Executable with current read-only access: deployment/log/card reads. Human Discord sessions are needed for private navigation, reload, completed-job inspection, close/new session, expiry and existing unauthorized-account denial. Remote SQLite integrity/ledger inspection needs authorized file access and must be reported unverified if unavailable.

Blocked without a suitable verified finding/fixture: contextual account replacement/departure/self-drop and layered preview cases. Do not manufacture drift or require a live transaction to complete this checklist. Controlled transaction acceptance, valid duplicate confirmations, permission-change races and interruption/recovery exercises require separate explicit approval and a fixture-specific plan. Read-only approval never supplies that authorization.
