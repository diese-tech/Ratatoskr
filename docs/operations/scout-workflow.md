# Scout Games Operations

Scout games let preseason players show captains what they can play before a draft. They are independent of seasons and publish rosters only—never match scores.

## One-time setup

1. Manually create a `Scouting Operations` category with `#scout-ops` inside it.
2. An admin runs `/scout config operations_channel:#scout-ops timezone:<IANA zone>`.
3. Provision or repair each active division with `/division add`. Ratatoskr moves the managed `<division>-scout-signups` and `<division>-scout-results` channels into the configured category by Discord ID, preserving their messages and links.
4. The admin selects any additional staff roles in the private config response.
5. The admin runs `/scout config bind_emoji:true` and reacts with five distinct custom guild emoji in Solo, Jungle, Mid, Support, Carry order. The admin may then bind a sixth **Fill** emoji or press **Skip Fill**.

Allfather, Aesir, Franchise Representative, and configured additional staff may manage every division. A division's Manager and Captain roles may manage only that division. Ratatoskr derives `<Division> Captain` from membership in both the global `Captain` role and the division role.

Each division has two channels: scout-signups contains signup posts followed by roster posts; scout-results contains screenshots manually posted by players after matches. The bot needs View Channel, Send Messages, Read Message History, Embed Links, Add Reactions, and Manage Messages in signups and scout-ops. Players need View Channel, Read Message History, Send Messages and Attach Files in their results channel. Its configured Discord application must retain the Guild Members and Guild Message Reactions gateway intents. Division provisioning additionally needs Manage Channels and Manage Roles.

## Run a scout setup

1. From `#scout-ops`, run `/scout create division:<division>`.
2. Enter the start time, number of roles each player may select, and an optional note. Optionally select one Discord eligibility role; all reactions remain recorded, but only current members of that role may be rostered.
3. Review the private preview and post it. The division role is pinged only when the public post is created.
4. Players react for roles. Ratatoskr enforces the per-player limit separately for each setup.
5. Once the signup post succeeds, a status-only card appears in `#scout-ops` with unique eligible players, uncapped role counts and Fill coverage. When ten compatible players can fill the two teams, Ratatoskr removes that temporary card and posts the fresh persistent control panel, pinging the creator once. Live counts remain visible in that panel throughout review. The public signup post stays information and reactions only. Fill counts against the role limit and can cover a standard role; explicit choices are preferred.
6. From that control panel, authorized staff or that division's captains open a private review, shuffle, swap, change roles, replace slots, and publish. If twenty compatible eligible players are currently available, Review roster also offers **Build 2 games**. Its confirmation explains that both games are recalculated, including prior one-game manual edits. Signups remain open while the roster is reviewed.
7. A two-game roster is still one setup. Shuffle balances all twenty unique players, **Swap any two players** can exchange assignments across games, teams, or roles, and replacement excludes everyone already seated in either game. A withdrawn signup blocks publication until resolved; staff-selected substitutes remain explicit overrides.
8. Publish after the confirmation names the correct division signup channel. Ratatoskr posts a separate combined roster containing Game 1 and Game 2 (or the original single game) in `<division>-scout-signups`. The original signup post closes to signups and links the roster. Its Swap/Replace controls and change notices stay with that roster. Players post match-result screenshots manually in `<division>-scout-results`; the bot does not process scores.

Multiple setups may be open in the same or different divisions. Every signup, roster version, result, and cancellation is isolated by setup ID.

## Cancellation and published replacements

- Use `/scout cancel` in `#scout-ops` to immediately list all open or roster-ready postings you can manage. Entries show division, scheduled time and status; select one and confirm. Larger lists have Previous/Next pages. Published, cancelled and still-posting setups are excluded. A roster-ready setup's Scout Ops panel reaches the same confirmation directly.
- Cancellation is final. The post is marked cancelled, reactions become inert, and controls are removed.
- Published setups cannot be cancelled. Use **Swap players** to exchange any two published assignments, including across games. Use **Replace player** to select an occupied slot and then a current, non-bot, non-rostered server member. Ratatoskr edits the one combined result and sends a non-pinging notice naming the exact game, team, and role locations.

## Failure and recovery

- Interrupted publication retains its claim when the send or cleanup is uncertain. Startup searches for the exact persisted marker before recovering the original message; retry only when the bot reports the claim is safely released.
- Published swaps/replacements atomically save the roster and a pending Discord update. An edit failure keeps that saved state for startup or button-triggered recovery. Further changes and division teardown remain blocked until recovery completes; do not repeat the player change.
- Cancellation remains effective if Discord refuses the post edit. Reactions are inert, and Ratatoskr retries the public-post repair on startup; the immediate failure response also provides a manual retry button.
- Ratatoskr reconciles incomplete signup creation, offline reaction changes, interrupted publication, cancellations, and Scout Ops control panels from SQLite on startup. A private creation preview does not survive a restart; run `/scout create` again.
- A deleted result message prevents replacement or swap and leaves the database unchanged. A deleted signup post prevents publication and returns the setup to retryable roster-ready state.

Production must use a persistent `DATABASE_PATH`. Back up that SQLite file according to the hosting platform's volume procedure before infrastructure changes.

## Provisioning and pending work

The franchise representative role is created/adopted under a stable server-managed
identity by bootstrap or division provisioning. Duplicate untracked names require
operator resolution; managed role renames do not change Scout authorization.

Division provisioning and Scout creation reject simultaneous work in the same
division. Other divisions remain independent. Keep one bot process per database.
Archive/delete blocks open and roster-ready setups, pending signup creation, and
unfinished roster publication. Cancel open setups; allow pending recovery to finish
before retrying teardown. Already settled published history remains preserved.

## Routing upgrade

Existing published rosters and already-claimed publications retain their original message/channel IDs. Their controls and updates stay there; no historical messages move or duplicate. Unpublished setups switch to signup-channel routing atomically when publication is claimed. The legacy results_channel_id field identifies the bot roster destination, not the manual screenshot channel. No schema migration or bulk snapshot rewrite is needed. Run division provisioning to reconcile player screenshot permissions; verify legacy controls and new publication after deployment.

## Pending published-update recovery

Migration 15 adds scout_roster_updates without rewriting historical setups. Rehearse on a consistent database backup. Keep one bot process. A pending edit retries against the stored roster message ID; its successful notice carries an exact setup/version marker. A lost notice response is resolved by a paginated marker search. If absence remains uncertain, Ratatoskr retains the pending record and does not resend blindly.

Operators should inspect the stored setup/version, canonical slots and destination message, then search for the exact notice marker. Restore channel/message access and retry the roster controls or restart for ordinary failures. If notice absence cannot be established, leave it pending. Any manual completion must first verify the roster message matches the saved version and confirm delivery of exactly one notice; stop the bot and take a consistent backup before an explicitly reviewed, setup/version-specific repair. Do not clear all pending rows or revert the roster from an old snapshot. Rolling back application code with pending updates requires resolving or preserving these records first.

## Player selection labels

Draft and published swap/replacement menus show compact labels such as
`G2 • Chaos • Carry — Diese`. Names prefer the server display name, then global
Discord display name, username, and an abbreviated unknown-player fallback.
Internal selection values remain stable slot IDs, including across both games.
Long names are shortened; duplicate display names receive a username or unique
abbreviated account ID so staff can distinguish candidates without changing slot identity.
The bot acknowledges the private interaction before fetching missing names.

## Persistent readiness cards (B2)

Readiness describes the eligible signup pool. Role numerators are never capped:
Solo 4/2 means four eligible Solo choices, not four distinct spare players.
The unique-player total counts each person once. Fill has its own count and can
cover standard roles; matching, including flex overlap, determines feasibility.
Two-game drafts show 20 players and four per standard role. Once a draft exists,
eligible unseated participants are shown separately and unavailable drafted
players produce a warning. Explicit staff substitutes can make a draft differ
from the signup pool; existing publish validation remains authoritative.

Reactions, member eligibility changes, departures and draft edits refresh the
card. Staff-card edits do not hold the live signup persistence lock. Unchanged
views are not edited repeatedly. Unknown role/member access marks the last
snapshot historical and reports an actionable error; the bot never silently
turns a restricted setup into an unrestricted one.

Publication/cancellation captures current counts while coordinating with signup
writes, then saves that snapshot atomically with closure. Card delivery can retry
independently. If eligibility cannot be verified, retain the last known snapshot
and report the failure to staff. Published/cancelled cards show the last recorded
snapshot and timestamp; restart does not recalculate historical eligibility.
Those historical signups are not confirmation that unseated players remain
available as substitutes. Published cards link the original roster destination.

Migration 16 adds `scout_readiness_cards`. Rehearse on a consistent backup and
verify existing pending roster updates from migration 15 remain unchanged. On
restart the bot recovers cards by exact markers and stored IDs. A denied deletion
keeps temporary-card ownership and delays the fresh ready notification. An
uncertain send stays pending until its message can be recovered; do not clear
attempt flags and resend without verifying the original delivery. Known Discord
message-creation rejections automatically release the failed attempt for retry;
replacing a deleted card retains the previous creator notification. Restore access
and retry via a normal refresh or restart. Review pending cards before rolling
back to older code, which does not manage their lifecycle.

Live acceptance remains required: check initial zero counts, overflow/Fill,
eligibility loss/gain/departure, one fresh creator ping, counts through two-game
review, terminal snapshots, concurrent setups and restart. Reminder pings are
a separate planned feature and are not enabled by B2.
