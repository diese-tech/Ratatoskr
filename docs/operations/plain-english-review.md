# Human-facing wording review

Tracked in [issue174](https://github.com/diese-tech/Ratatoskr/issues/174). Players, hosts and staff should understand a message without knowing how the bot is built. Explain what happened and what to do next. Keep messages short and respectful.

## Reviewed in the first pass

- `/help`: shorter instructions, correct staff access, new Inhouse entries, role opt-in/out and creator-only game management.
- Command descriptions and Scout settings: explain channel and emoji selection without "binding" or "IANA" terminology. Existing command syntax is preserved.
- Private Scout/Inhouse setup: who can join, separate games at the same time, expired controls, and unfinished signup posts.
- Private team review/editing: changed teams, players who cannot take a spot, manual choices, missing access, and readable explanations of rejected edits instead of stored result names.
- Posting/finishing/cancelling game replies: distinguish a saved game/player change from an unfinished Discord post. Keep warnings against posting or changing players again when the first action may have succeeded.
- Emoji selection prompts: say how to choose each emoji and how to restart when time runs out.

Existing integration checks still verify permissions, confirmation, competing changes, private replies, preserved history and recovery. Their text expectations follow the revised messages. The new result formatter is checked for both known and unknown internal outcomes.

## Remaining review

- Public working-roster and status cards, including readiness and terminal states. Review all dynamic values, omission markers and notification failure guidance.
- League Ops screens: readable operation states and repair/account-change choices; no raw payloads or stored state names.
- Shared error notices and human-facing service validation: keep technical details in logs and provide a useful next step plus a support reference.
- Division/season/server setup replies and attachments: simplify setup progress, repair summaries and failure explanations.
- Staff guides and the canonical command reference in issue145. Technical deployment/developer documentation can retain necessary implementation details.
- Live Discord wording/layout checks, distinct from automated and CI checks.

## Approved text to preserve

The Inhouse opt-in message and scripted public transaction announcements stay as approved. Keep named Discord roles/channels and exact command/option names so users can find them. Keep internal state names, technical codes, database fields and logs unchanged; only their presentation needs plain English.

Do not claim "nothing changed" when a write may have happened. Do not invite a user to repeat a saved or possibly completed action. Wording changes must preserve access restrictions and confirmation steps.
