# Contributing to Ratatoskr

Thanks for your interest in improving Ratatoskr.

Ratatoskr is the Discord operations bot for the Yggdrasil Smite League (YSL). It is purpose-built around real league workflows, so contributions should solve a concrete Ratatoskr/YSL problem rather than expand the bot into a generic Discord utility.

## Before you start

For non-trivial changes, start from an existing GitHub issue or open one before implementation.

Before proposing or beginning work:

1. search existing issues and pull requests for overlapping work;
2. read the relevant issue completely, including dependencies and acceptance criteria;
3. review the current repository documentation and nearby implementation patterns;
4. read root `AGENTS.md` and `CONTEXT.md` when present;
5. review relevant records under `docs/adr/`, `docs/architecture/`, `docs/operations/`, and `docs/plans/` where they apply;
6. preserve dependency order and avoid silently broadening the issue scope.

Use [issue #24](https://github.com/diese-tech/Ratatoskr/issues/24) as the broader product-scope reference and [issue #124](https://github.com/diese-tech/Ratatoskr/issues/124) for current command-domain and Fluxcord interaction boundaries.

Do not add a command, workflow, abstraction, or service merely because it is technically possible. New behavior should solve a real operator, captain, player, or system job.

## Security reports

Do not place vulnerability details, leaked credentials, exploit steps, private Discord content, or other security-sensitive information in a public issue or pull request.

Follow [SECURITY.md](SECURITY.md) and use the repository's private vulnerability reporting workflow for security issues.

## Development setup

Ratatoskr requires Node.js 24.x.

Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/diese-tech/Ratatoskr.git
cd Ratatoskr
npm ci
cp .env.example .env
```

Configure `.env` for your development environment, then run:

```bash
npm run dev
```

Never commit `.env`, Discord tokens, API keys, service-account credentials, production database files, or other secrets.

Ratatoskr currently uses native SQLite dependencies in its active persistence path. If local installation fails around `better-sqlite3`, fix the local Node/native-build environment rather than replacing persistence with a fake implementation just to make tests pass.

The repository's persistence migration toward Postgres is staged. Follow the current code and issue requirements rather than assuming that the presence of `DATABASE_URL` makes Postgres authoritative.

## Architecture expectations

Prefer the patterns already established in the repository.

### Keep entry points thin

Slash-command and Discord interaction handlers should primarily:

- resolve input and current context;
- perform or invoke authorization checks;
- call the relevant application/domain service;
- render the result back to Discord.

Do not bury durable business rules or workflow state transitions inside presentation handlers when they can live behind testable service/domain boundaries.

### Treat durable state as authoritative

When a workflow must survive bot restart, duplicate interactions, stale components, or partial Discord failure, authoritative state belongs in Ratatoskr's persistence layer rather than only in Discord messages or in-memory UI state.

Discord messages, embeds, buttons, selects, and modals are presentation/control surfaces. They are not substitutes for durable workflow truth.

### Revalidate protected mutations

UI visibility is not an authorization boundary.

Protected actions must resolve current durable state and current authorization at mutation time. Treat component payloads, old messages, cached membership, and stale interaction state as untrusted inputs.

### Reuse reliability patterns

Before inventing a parallel mechanism, inspect Ratatoskr's existing patterns for:

- reconciliation;
- idempotency;
- optimistic version checks / compare-and-set behavior;
- serialization of conflicting work;
- restart recovery;
- durable pending operations;
- explicit lifecycle state;
- authorization policy;
- managed Discord resource identity.

Reuse those patterns where the failure boundary is genuinely the same. Do not force unrelated workflows into an abstraction merely for symmetry.

### Keep changes scoped

Avoid unrelated refactors, speculative framework work, drive-by renames, command-taxonomy churn, or premature genericization.

If an implementation uncovers a separate problem, record it as a focused follow-up instead of silently expanding the current PR.

## Required validation

Before opening a pull request, run the repository's core validation commands:

```bash
npm run typecheck
npm run typecheck:scripts
npm test
npm run build
npm audit
```

Fix failures caused by your change before handing the work off for review.

Do not weaken tests, suppress TypeScript errors, or remove meaningful validation solely to make the checks pass.

Automated validation is necessary, but it is not equivalent to deployment or live Discord acceptance.

If the linked issue requires Railway verification, migration rehearsal, restart testing, or live Discord interaction checks, record those separately and do not claim them complete from CI alone.

## Evidence states

Use precise completion language.

These states are not interchangeable:

- **Code complete**: implementation is finished locally.
- **CI green**: required automated checks passed for the relevant commit.
- **Reviewed**: required review feedback is resolved for the current head.
- **Merged**: the change is on the target branch.
- **Deployed**: the intended runtime environment is running the change.
- **Live verified**: required real Discord/Railway/operator acceptance was actually observed.

Do not report a later state when only an earlier state is supported by evidence.

## Pull request expectations

Keep each pull request focused and reviewable.

A useful PR description should include:

- the issue or issues being addressed;
- what changed;
- why the change was needed;
- important architecture or state implications;
- migrations, environment variables, configuration, or deployment changes;
- validation commands run and their results;
- meaningful edge/failure cases covered;
- documentation changed;
- any deployment or live acceptance that remains outstanding;
- any intentional deviation from the linked issue's acceptance criteria.

Do not hide unresolved requirements behind vague phrases such as "works locally" or "tests pass."

If a command, configuration value, architecture boundary, persistence behavior, or operator workflow changes, update the relevant documentation in the same work unless the issue explicitly separates that documentation into another task.

## Agent-authored contributions

Ratatoskr uses coding agents heavily. Agent-authored work follows the same standards as human-authored work.

Before implementation, an agent should:

- inspect the current issue and its dependencies;
- inspect the current code and nearby tests;
- read applicable repository documentation and agent guidance;
- follow existing repository patterns instead of inventing local conventions;
- distinguish locked requirements from suggestions or historical context.

During implementation, an agent must not:

- silently reinterpret ambiguous product requirements;
- invent final command names where the owning issue leaves naming to the product owner;
- broaden scope to unrelated refactors;
- claim runtime or live acceptance it did not perform;
- bypass authorization, persistence, recovery, or validation requirements because a simpler implementation is easier.

Before handoff, an agent should:

- run the required validation suite;
- inspect the final diff for unintended changes;
- verify the PR/branch is based on the intended current repository state;
- leave concise human-readable context explaining implementation choices, risks, validation, and remaining work;
- verify final-head CI/review state when the available tooling permits it.

## Documentation ownership

Use the repository's existing documentation boundaries instead of duplicating long explanations:

- `README.md` describes the product, setup, major architecture principles, and operational entry points;
- `CONTRIBUTING.md` owns contributor workflow;
- `SECURITY.md` owns vulnerability reporting and security-policy expectations;
- `AGENTS.md` and `docs/agents/` own repository-specific agent instructions;
- `docs/architecture/` and `docs/adr/` own architecture decisions and boundaries;
- `docs/operations/` owns operator/deployment procedures;
- `docs/plans/` owns implementation plans and checkpoints;
- `docs/canon/` contains approved YSL source-of-truth material;
- `docs/proposals/` contains non-canonical proposals.

Prefer links to authoritative material over copying the same policy into several files.

## Licensing of contributions

Ratatoskr's software is licensed under the Apache License 2.0. See [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE).

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion in Ratatoskr are provided under the repository's Apache 2.0 licensing terms.

Yggdrasil Smite League branding and third-party game intellectual property remain subject to the exclusions and notices documented in [NOTICE](NOTICE).

## Keep the process proportional

Ratatoskr does not require heavyweight RFCs or design documents for small, well-scoped fixes.

Use enough process to make the change safe, understandable, testable, and reviewable. Do not add ceremony simply because larger projects use it.
