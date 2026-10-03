# Issue tracker: GitHub

Issues and PRDs for this repository live in [diese-tech/Ratatoskr GitHub Issues](https://github.com/diese-tech/Ratatoskr/issues). Use the `gh` CLI from this checkout for issue operations.

## Conventions

- Create issues with `gh issue create`, preferably using `--body-file` for multiline bodies.
- Read an issue and its discussion with `gh issue view <number> --comments` and include labels when triaging.
- List issues with `gh issue list`, narrowing by state and label as appropriate.
- Comment with `gh issue comment <number>`.
- Apply or remove labels with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Close with `gh issue close <number>` and include a concise evidence-backed comment when useful.
- GitHub shares one number space across issues and pull requests. Resolve ambiguous references before acting.

## Standard issue information model

Human-created and agent-created implementation issues should use the same information model even when the issue is created through the API or `gh issue create` instead of GitHub's issue-form UI.

For implementation-facing bugs, features, and workflow changes, preserve the following structure where it is relevant:

1. **Problem / job**: the concrete failure, operator pain point, or league job being solved.
2. **Actor / owner**: who performs, owns, or is affected by the job when that context matters.
3. **Current behavior / workaround**: what happens today and how the work is currently handled.
4. **Desired outcome**: the observable result the change should create.
5. **Locked decisions**: product or architecture decisions that an implementation agent must not reinterpret.
6. **State / authorization / history requirements**: durable state, permissions, approvals, auditability, concurrency, restart, or recovery requirements where applicable.
7. **Scope**: what the issue includes.
8. **Non-goals**: nearby work that is intentionally excluded.
9. **Acceptance criteria**: specific observable conditions required for completion.
10. **Validation**: automated, migration, deployment, or live-Discord evidence required to prove the change.
11. **Dependencies / references**: blocking issues, ADRs, plans, or canonical docs.
12. **Definition of done**: the point at which no implementation decision remains and the issue can close.

Do not manufacture empty sections merely to satisfy formatting. Use the structure to improve clarity, not to add ceremony.

When creating a bug report, match the intent of the repository bug issue form: capture problem, expected behavior, affected area, environment, reproduction, actual result, useful sanitized evidence, regression information when known, and the pre-submit security checks.

When creating a feature/workflow request, match the intent of the repository workflow issue form: lead with the real YSL job/problem and desired outcome before proposing commands or implementation shape, then capture actor, current workaround, state/auth/history needs, overlap, and scope/non-goals where known.

## Specialized issue types

Do not force every repository artifact into the implementation-issue structure.

Roadmaps, master trackers, architecture contracts, design records, parent issues, and deployment/live-acceptance gates may use specialized structures when those structures communicate their purpose more clearly.

When using a specialized structure:

- identify the artifact's role clearly;
- preserve links to implementation children or authoritative records;
- keep acceptance/evidence expectations explicit where applicable;
- do not rewrite historical or closed issues merely for cosmetic consistency.

Normalize an older active issue only when the rewrite improves implementation clarity while preserving all substantive requirements, decisions, dependencies, and historical context.

## Pull request authoring

Pull requests should use the same evidence model expected by the repository PR template, whether authored through GitHub UI, API, CLI, or an agent.

A useful implementation PR should include:

- linked issue(s);
- what changed;
- why the change was needed;
- meaningful architecture or durable-state implications;
- migrations, environment variables, configuration, or deployment changes;
- the repository's required validation results;
- relevant failure and edge cases covered;
- documentation changed;
- deployment/live acceptance status stated separately from CI;
- security/sensitive-data confirmation;
- deviations from the linked issue or remaining work.

Do not claim deployment or live Discord acceptance from CI alone. Distinguish code complete, CI green, reviewed, merged, deployed, and live verified when reporting status.

Agent-authored PRs must inspect the final diff, preserve linked-issue acceptance criteria, and leave concise human-readable context rather than relying on generated code as the only explanation.

## Pull requests as a triage surface

External pull requests are **not** a request surface. Do not add them to the issue triage queue. Pull requests still receive normal code review and CI handling.

## Triage readiness

The issue template or information model does not itself determine readiness.

Use the canonical labels from `docs/agents/triage-labels.md`. In particular, apply `ready-for-agent` only when the issue is sufficiently specified for an agent to implement without unresolved product decisions. Use `needs-info` or `ready-for-human` when human input or coordination is still required.

## Skill routing

When a skill says to publish to the issue tracker, create a GitHub issue in `diese-tech/Ratatoskr` using the standard information model when it is an implementation-facing issue. When a skill says to fetch a ticket, read the current GitHub issue and its comments before relying on repository or conversation summaries.
