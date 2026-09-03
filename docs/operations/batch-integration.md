# Scout batch integration and deployment evidence

Recorded September 3, 2026. The user authorized sequential B1 merges followed
by a separate B2 merge, then explicitly directed Railway auto-deployment to stay
enabled with deployment/startup logs checked before continuing. That direction
supersedes the earlier temporary deployment hold. Auto-deploy on main is ON.

## Merge boundaries

All implementation checkpoints are preserved. Each slice was retargeted to main,
main was merged into its branch, and fresh Windows/Ubuntu checks passed before
the PR was merged. Merge commit bodies record Done, Validation and Next.

| Slice | PR | Merge commit |
| --- | --- | --- |
| B1.1 validation/runtime | #70 | 309b23183d0f12d8b53906c8c34f89c9c7788174 |
| B1.2 division safety | #71 | 4734b15529164dd530fadc20ddaad2b6b19f3f73 |
| B1.3 signup-channel publication | #72 | 48053e3ea32b6edfdd26540c26d462826eb7ca40 |
| B1.4 published recovery | #73 | e5c440c1f2803e91f94c1296dfebfc91b99cf89f |
| B1.5 staff reporting | #74 | d3a5c8871100bd4445d6b5bbe6646655bc5386e0 |
| B1.6 active cancellation picker | #75 | b760062b2ed6a4b9499f1f3a0323b967e9379e2d |
| B1.7 readable names / complete B1 | #76 | c5945000e5b5836de170b6a5987ad37b9a6a3818 |
| B2 persistent readiness | #77 | 4ca02d0adb1c39e4d10327f10d1679ef59f6d0d0 |

B1 main CI passed in [run 33731791579](https://github.com/diese-tech/Ratatoskr/actions/runs/33731791579).
B2 main CI passed in [run 33731963595](https://github.com/diese-tech/Ratatoskr/actions/runs/33731963595).
B1 cumulative validation: 168 tests. B2: 187 tests, both typechecks, build and
zero-vulnerability production dependency audit. No issue was closed by these
merges; #68/#69 and live acceptance issues remain open.

## Railway rollout checks

Project: heartfelt-love, production; service: Ratatoskr. The service remains
connected to diese-tech/Ratatoskr main with automatic deployments enabled.
The temporary hold covered #70-#73; restoring the connection deployed that
combined head. Each subsequent deployment was verified before the next merge.

| Deployed boundary | Railway deployment | GitHub deployment record | Success UTC | Startup/recovery completed UTC |
| --- | --- | --- | --- | --- |
| Through #73 | 184bdea3-316f-4b92-b6ed-ca79b389e434 | 6239631819 | 08:04:46 | 08:04:48 |
| #74 | a9e4184b-b90f-4ae9-8828-eec3c9ba2944 | 6239654907 | 08:06:03 | 08:06:06 |
| #75 | 1604a008-4eaa-4163-bc9a-0c5efca2cb75 | 6239675834 | 08:07:28 | 08:07:29 |
| Complete B1 / #76 | 8b983d9f-2cd2-4325-9b97-62a99a73a0e5 | 6239704739 | 08:09:23 | 08:09:26 |
| Complete B2 / #77 | be9bed1b-b5c9-4142-87a5-8c925fadc7f5 | 6239735091 | 08:11:20 | 08:11:24 |

The first new build selected Node 24.19.0 from package.json engines, replacing
the prior Node 20 runtime. Each startup mounted the same attached volume,
reported Database ready, connected as Ratatoskr#6096, registered commands, and
completed pending signup/publication/roster-update, active/cancelled signup and
control-panel reconciliation. No startup failure was observed in these logs.
The npm production-config deprecation warning did not prevent startup.

Service: 8ae03a74-c126-4939-b59c-979855a8a02f; volume:
4cd3d8a4-922b-4296-9a26-e9a785624bae. The visible configuration is one replica
in US East (Virginia). A transient invalid-region warning disappeared once
settings finished loading; it was not a confirmed blocker. Lucid was not changed.

## Remaining acceptance

Successful startup is not a live Discord flow test. Verify the two-channel
workflow, historical roster controls, cancellation picker, staff-ops delivery,
mobile/name selection, exact multi-game changes, telemetry/eligibility refresh,
one creator notification and restart recovery under real permissions.

The Railway native backup UI reported no backups and a Pro-plan requirement for
that feature. No plan upgrade was purchased. Production-copy migration/restore
rehearsal remains unverified; synthetic v14/v15 checks are not equivalent.

The one-hour roster reminder remains a separate follow-up. B3's full #45/#62
acceptance session and B4-B7 remain outside this completed implementation/merge
scope. Continue preserving Done/Validation/Next commits for later authorized work.

## Recovered-post management follow-up — PR #79

The user's first B2 screenshot verified successful recovery of older listings,
but revealed missing management controls. PR #79 adds direct cancellation,
published roster edits in Scout Ops and durable explicit completion. It is a
bounded B2 follow-up; B3–B7 and reminder scope remain unchanged.

- Merge: `cd1be71284fafc7c69d0058807d046889101238d`, September 3 at 13:04:27 UTC.
- Preserved checkpoints: `8777d03` (recovered-card cancellation) and `3ba4306`
  (completion, editing and recovery).
- 196 local tests, application/script typechecks, build and production audit pass.
- PR CI `33758762949`; main CI `33758944912`: Windows and Ubuntu pass.
- Railway deployment `ba9e274e-fe5c-49ea-bd29-c632709f1463`; GitHub deployment
  `6244551865`, successful at 13:06:58 UTC.
- Inspected runtime: volume mounted at 13:06:51; database ready and bot online at
  13:06:53; finished posts reconciled at 13:07:00; cards reconciled at 13:07:07.
  No startup failures observed. Automatic deployments remained enabled.

Migration 17 adds completion records; synthetic v14/v15/v16 upgrade fixtures
preserve prior data. Follow the completion rollback constraints in
`../plans/scout-stale-post-management.md`. A coordinator must still verify live
cancel/finish behavior on chosen setups. No production setup was closed by the
agent, and successful startup does not substitute for that acceptance.
