# Implementation checkpoint

Authorized scope: B1 in `docs/plans/backlog-execution-plan.md` v1.3.
Commit each meaningful chunk with Done, Validation and Next in the commit body.
Apply this process to every authorized batch, preserving separate code/deployment/live evidence.

## B1.1 — validation/runtime

Done: quote the test glob so Node handles recursive discovery on both shells;
pin Node 24; run the CI matrix on Ubuntu and Windows; document runtime/volume checks.

Validation: Node 24.14.1, locked native SQLite installation, all 133 baseline tests,
application/script typechecks, build and dependency audit pass locally.
Remote CI and Railway runtime verification remain pending. No production changes.

Next: open the B1.1 PR and verify both CI jobs. Continue B1.2 with regressions for
managed franchise-role identity, interrupted channel-parent repair and pending-work
teardown/concurrency guards. Then B1.3 routing, B1.4 durable writes, B1.5 reporting,
B1.6 cancellation and B1.7 readable names. B2 remains out of current scope.
