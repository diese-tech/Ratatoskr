# Ratatoskr

Ratatoskr is the Discord operations bot for the **Yggdrasil Smite League (YSL)**. It manages league infrastructure and durable Discord workflows while keeping competitive rules, permissions, and state changes explicit and recoverable.

> **Status:** active development and live YSL use. Ratatoskr is purpose-built for YSL rather than a plug-and-play general Discord bot.

## What Ratatoskr does

Ratatoskr currently provides:

- **Server provisioning** — plan, create, repair, and reconcile Ratatoskr-managed server resources.
- **Division lifecycle** — create/repair divisions, inspect managed resources, archive divisions, and perform guarded deletion.
- **Season workspaces** — create and activate season-specific Discord structure.
- **Scout operations** — configure, create, monitor, review, publish, edit, cancel, finish, and recover division-scoped preseason Scout workflows.
- **Readiness telemetry** — show current eligible-player and role coverage in Scout Ops using the same canonical eligibility and roster-matching rules used for roster formation.
- **Persistent controls** — keep roster review, Swap, Replace player, cancellation, and completion actions attached to the relevant Scout workflow instead of expanding the slash-command surface unnecessarily.
- **Failure recovery** — persist authoritative workflow state in SQLite and reconcile Discord messages after transient failures, ambiguous delivery, or bot restarts.
- **Operational reporting** — surface actionable reconciliation failures to staff instead of silently losing state.
- **Private help** — `/help` provides a plain-language quickstart for the shipped command surface.

For the full Scout operator workflow and permissions, see [`docs/operations/scout-workflow.md`](docs/operations/scout-workflow.md).

## Command surface

Ratatoskr intentionally keeps slash commands focused on starting, discovering, or configuring workflows. Contextual actions stay on the Discord message or control panel that already knows which object is being managed.

Current top-level namespaces:

| Namespace | Purpose |
| --- | --- |
| `/server` | managed server bootstrap and repair |
| `/division` | division lifecycle and resource management |
| `/season` | season lifecycle |
| `/scout` | Scout configuration, creation, and cancellation entry points |
| `/help` | private command quickstart |

The runtime command registry is authoritative. Product direction and candidate future domains are tracked in [issue #24](https://github.com/diese-tech/Ratatoskr/issues/24).

## Design principles

- **League operations first.** Automate repetitive league work without turning Ratatoskr into a catch-all Discord bot.
- **Jobs before commands.** Use slash commands for clear entry points; use contextual components and automation when the workflow already has the necessary identity and context.
- **Durable state over Discord state.** Discord messages and components are presentation/control surfaces. Workflows that must survive restart or partial failure store authoritative state in SQLite.
- **Authorization at mutation time.** UI visibility is not a security boundary. Current state, permissions, and expected scope are revalidated before protected mutations.
- **Retry-safe external writes.** Discord cannot participate in a database transaction, so recoverable writes use versioning, durable intent/state, reconciliation, and explicit failure handling rather than pretending distributed operations are atomic.
- **Preserve useful history.** Terminal workflow events should avoid destructively rewriting historical state when a separate completion/closure record is safer.
- **Deterministic core operations.** Core league administration must not depend on AI or probabilistic behavior.
- **League canon is authoritative.** Approved rules, policies, and terminology belong under [`docs/canon/`](docs/canon/). Any future knowledge assistant should answer from that material and cite its source.

See [`docs/architecture/overview.md`](docs/architecture/overview.md) for the current architecture boundary and workflow model.

## Repository layout

```text
src/
  commands/       Discord command entry points
  config/         Runtime and guild structure configuration
  db/             SQLite migrations, repositories, and persistence
  domain/         Deterministic league concepts and business rules
  services/       Application and Discord-facing workflow services
  knowledge/      Future approved-document retrieval layer

docs/
  architecture/   Architecture and workflow decisions
  canon/          Approved YSL source-of-truth material
  operations/     Staff/operator procedures and rollout guidance
  plans/          Dependency-aware implementation plans and checkpoints
  proposals/      Ideas not yet accepted as league canon
scripts/           Operational/bootstrap scripts
```

## Requirements

- **Node.js 24.x**
- A Discord application/bot with the required guild permissions
- SQLite storage; production should use persistent storage for the database file

The exact runtime dependency versions are defined in [`package.json`](package.json) and `package-lock.json`.

## Local development

```bash
git clone https://github.com/diese-tech/Ratatoskr.git
cd Ratatoskr
npm ci
cp .env.example .env
npm run dev
```

Configure `.env` with your Discord application values. The current template documents the required admin-role IDs and the optional local SQLite path:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
ROLE_ALLFATHER_ID=
ROLE_AESIR_ID=
DATABASE_PATH=
```

`DATABASE_PATH` defaults to `./data/ratatoskr.db` for local development. Production must point it at the existing persistent mounted volume.

Never commit `.env`, Discord tokens, or other credentials.

## Validation

Before opening or merging a change, run the same core checks expected by the repository:

```bash
npm run typecheck
npm run typecheck:scripts
npm test
npm run build
npm audit
```

CI validates the locked dependency set on Linux and Windows and runs the quoted nested test glob so repository tests are discovered consistently across shells. The suite exercises the native SQLite dependency rather than replacing persistence with a fake implementation.

## Persistence and recovery

Ratatoskr uses SQLite for durable operational state. Production deployments must preserve the database across restarts and releases.

Important workflow rules:

- interaction handlers resolve current state from the database instead of trusting stale component payloads;
- version checks and serialization protect concurrent or duplicate mutations where required;
- Discord-side failures do not silently roll authoritative domain state backward when recovery is safer;
- pending/ambiguous message operations are reconciled using durable IDs/markers and startup recovery;
- terminal Scout workflows retain historical snapshots instead of recomputing old eligibility from current Discord membership.

Private creation previews and other intentionally short-lived setup interactions may remain in memory when losing them on restart is safe and explicit.

## Deployment notes

The production deployment currently targets Railway.

Before deploying a runtime or migration change:

1. Confirm the runtime uses Node 24.
2. Confirm the native `better-sqlite3` module loads in the deployed environment.
3. Confirm `DATABASE_PATH` still points to the existing persistent volume.
4. Take a consistent database backup before schema changes.
5. Retain the previous deployment reference for rollback/recovery.
6. Rehearse migrations against a production copy when the change affects durable Scout or managed-resource state.
7. Treat successful CI as necessary but not sufficient; verify startup/reconciliation and any required live Discord acceptance separately.

Do not start a second production bot replica against the same Discord workflow/database state merely for verification unless the architecture has explicitly been changed to support multiple writers.

Operational rollout and recovery guidance lives under [`docs/operations/`](docs/operations/).

## Project direction

Ratatoskr's roadmap is intentionally driven by **league jobs**, not feature parity with general-purpose Discord bots. Candidate future domains include fuller season lifecycle management, team/roster operations, durable transactions, match operations, notification preferences, and grounded league-rule lookup.

Those ideas are planning inputs, not automatic implementation commitments. See [issue #24](https://github.com/diese-tech/Ratatoskr/issues/24) for the current product-scope map.
