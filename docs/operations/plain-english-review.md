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

## Reviewed in the second pass

- Public working-roster and status cards, including signups, readiness, replacements and finished/cancelled games. Omission markers and unavailable-player explanations use plain English.
- League Status and private league tools: readable action states and repair/account-change choices, confirmation and expired-control instructions. Stored names and states are unchanged; display labels do not authorize actions.
- Shared error notices: technical codes and traces stay in logs. Unknown saved failures do not appear verbatim; known causes such as missing current-name records receive readable explanations. Locally generated validation text is checked separately from historical/external errors.
- Division/season/server replies and setup reports: readable states, actual channel names, setup progress and failure summaries. The alert message prefix/reference format is preserved for delivery recovery and cleanup.
- [Command guide](command-reference.md): every registered root/subcommand, arguments, actual permissions/channel restrictions, preview/confirmation steps, game tools, and Discord copy/paste instructions. Technical deployment/developer documentation retains necessary implementation details.

The source inventory reviewed 595 display expressions across 39 files, with separate checks of strings built in rendering functions and dynamic error/action/state paths. Approved intro and public transaction scripts were inspected and preserved. Credentials remain redacted; the standalone redactor does not load staff-alert settings into server setup.

## Live check still pending

Verify the new labels and message layout in Discord independently of tests/CI. The browser currently shows a sign-in page, so human Inhouse reaction-add/remove, the private create preview and visual acceptance have not been performed. A real game remains a separate acceptance check; do not create a public test game or replay a league transaction to manufacture evidence.

## Approved text to preserve

The Inhouse opt-in message and scripted public transaction announcements stay as approved. Keep named Discord roles/channels and exact command/option names so users can find them. Keep internal state names, technical codes, database fields and logs unchanged; only their presentation needs plain English.

Do not claim "nothing changed" when a write may have happened. Do not invite a user to repeat a saved or possibly completed action. Wording changes must preserve access restrictions and confirmation steps.
