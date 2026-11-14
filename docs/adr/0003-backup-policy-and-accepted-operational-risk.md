# ADR 0003: Ratatoskr Backup Policy and Accepted Operational Risk

- **Status:** Accepted by the owner
- **Recorded:** 2026-11-14
- **Scope:** Current backup expectations, not database or mutation correctness

## Context

Ratatoskr currently operates without a verified current production recovery backup. Historical database copies and local Docker files are not assumed to be current backups. The owner explicitly accepts the resulting potential data loss and recovery limitations at the present scale.

## Decision

Managed Railway/cloud backups are deferred until usage, operational criticality or business requirements justify them. No mandatory recurring backup schedule, cloud storage integration or backup infrastructure is authorized. Backup absence alone must not block routine source reviews, approved releases or read-only acceptance. This decision supersedes earlier mandatory backup prerequisites in operational checklists and deployment guidance; it does not certify that any backup is current or restorable.

Existing SQLite integrity, durable-state protections, migration safety and recovery semantics remain required. Missing production files, corruption, unsafe migration or accidental creation/overwrite of production storage are genuine defects, not accepted backup risk. Preserve the canonical job worker, approval evidence and partial-write reconciliation; never infer that a historical copy can safely replace current hosted data.

## Reconsideration

Revisit this decision when material circumstances change, including higher usage, difficult-to-reconstruct records or a new business continuity requirement, or when the owner requests it. Do not repeatedly reopen it solely because a current backup is absent. Any backup creation, schedule or infrastructure still needs separate authorization.

## Related records

- [Authoritative mutations and durable acceptance](0001-authoritative-league-roster-mutations.md)
- [Release activation and acceptance](../operations/production-release.md)
- [League transaction operations](../operations/league-transactions.md)
