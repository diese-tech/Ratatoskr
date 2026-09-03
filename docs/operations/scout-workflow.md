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
5. When ten compatible players can fill Solo, Jungle, Mid, Support, and Carry on both teams, Ratatoskr posts a persistent control panel in `#scout-ops` and pings the setup creator once. The public signup post remains information and reactions only. A Fill signup counts against the player's selection limit and may satisfy any missing standard role; explicit role selections are preferred.
6. From that control panel, authorized staff or that division's captains open a private review, shuffle, swap, change roles, replace slots, and publish. If twenty compatible eligible players are currently available, Review roster also offers **Build 2 games**. Its confirmation explains that both games are recalculated, including prior one-game manual edits. Signups remain open while the roster is reviewed.
7. A two-game roster is still one setup. Shuffle balances all twenty unique players, **Swap any two players** can exchange assignments across games, teams, or roles, and replacement excludes everyone already seated in either game. A withdrawn signup blocks publication until resolved; staff-selected substitutes remain explicit overrides.
8. Publish after the confirmation names the correct division signup channel. Ratatoskr posts a separate combined roster containing Game 1 and Game 2 (or the original single game) in `<division>-scout-signups`. The original signup post closes to signups and links the roster. Its Swap/Replace controls and change notices stay with that roster. Players post match-result screenshots manually in `<division>-scout-results`; the bot does not process scores.

Multiple setups may be open in the same or different divisions. Every signup, roster version, result, and cancellation is isolated by setup ID.

## Cancellation and published replacements

- Use `/scout cancel division:<division>` in `#scout-ops` to select among that division's open or roster-ready setups. A roster-ready setup's Scout Ops panel reaches the same confirmation directly.
- Cancellation is final. The post is marked cancelled, reactions become inert, and controls are removed.
- Published setups cannot be cancelled. Use **Swap players** to exchange any two published assignments, including across games. Use **Replace player** to select an occupied slot and then a current, non-bot, non-rostered server member. Ratatoskr edits the one combined result and sends a non-pinging notice naming the exact game, team, and role locations.

## Failure and recovery

- If publication cannot write both the result and original signup post, no result is claimed. Fix the reported channel, message, or permission problem and retry from Review roster.
- If a published replacement or swap cannot edit the result, Ratatoskr rolls the database change back when safe and tells the manager to retry. If it reports an unsafe rollback, stop editing that setup and reconcile the stored roster with the result message.
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
