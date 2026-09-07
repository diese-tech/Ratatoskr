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

## Pull requests as a triage surface

External pull requests are **not** a request surface. Do not add them to the issue triage queue. Pull requests still receive normal code review and CI handling.

## Skill routing

When a skill says to publish to the issue tracker, create a GitHub issue in `diese-tech/Ratatoskr`. When a skill says to fetch a ticket, read the current GitHub issue and its comments before relying on repository or conversation summaries.
