# Scout Games Operations

Scout games let preseason players show captains what they can play before a draft. They are independent of seasons and publish rosters only—never match scores.

## One-time setup

1. Provision each active division with `/division add`.
2. An admin runs `/scout config timezone:<IANA zone>`.
3. The admin selects any additional staff roles in the private config response.
4. The admin runs `/scout config bind_emoji:true` and reacts with five distinct custom guild emoji in Solo, Jungle, Mid, Support, Carry order. The admin may then bind a sixth **Fill** emoji or press **Skip Fill**.

Admins and configured additional staff may manage every division. Captains may manage only the division whose Captain Access role they hold.

The bot needs View Channel, Send Messages, Read Message History, Add Reactions, and Manage Messages in both scout channels. Its configured Discord application must retain the Guild Members and Guild Message Reactions gateway intents. Division provisioning additionally needs Manage Channels and Manage Roles.

## Run a scout setup

1. From `<division>-scout-signups`, run `/scout create`.
2. Enter the start time, number of roles each player may select, and an optional note. Optionally select one Discord eligibility role; all reactions remain recorded, but only current members of that role may be rostered.
3. Review the private preview and post it. The division role is pinged only when the public post is created.
4. Players react for roles. Ratatoskr enforces the per-player limit separately for each setup.
5. When ten compatible players can fill Solo, Jungle, Mid, Support, and Carry on both teams, the original post gains Review roster and Cancel setup controls. A Fill signup counts against the player's selection limit and may satisfy any missing standard role; explicit role selections are preferred.
6. An authorized manager reviews privately, shuffles, swaps same-role players between teams, exchanges occupied role assignments, or seats a replacement. A withdrawn signup blocks publication until resolved.
7. Publish only after the confirmation names the correct division results channel. Ratatoskr posts Order and Chaos to the setup's snapshotted `<division>-scout-results` channel and links that result from the signup post.

Multiple setups may be open in the same or different divisions. Every signup, roster version, result, and cancellation is isolated by setup ID.

## Cancellation and published replacements

- Use `/scout cancel` in the division signup channel to select among that division's open or roster-ready setups. A setup's public Cancel setup button reaches the same confirmation directly.
- Cancellation is final. The post is marked cancelled, reactions become inert, and controls are removed.
- Published setups cannot be cancelled. Use Replace player on the published result; select the occupied slot and then a current, non-bot, non-rostered server member. Ratatoskr preserves that slot's team and role, edits the existing result, and sends a non-pinging notice.

## Failure and recovery

- If publication cannot write both the result and original signup post, no result is claimed. Fix the reported channel, message, or permission problem and retry from Review roster.
- If a published replacement cannot edit the result, Ratatoskr rolls the database change back when safe and tells the manager to retry. If it reports an unsafe rollback, stop editing that setup and reconcile the stored roster with the result message.
- Cancellation remains effective if Discord refuses the post edit. Reactions are inert. Click the still-visible Cancel setup control again after fixing access to retry post reconciliation.
- Public controls survive a bot restart because they resolve current state from SQLite. A private creation preview does not; run `/scout create` again.
- A deleted result message prevents replacement and leaves the database unchanged. A deleted signup post prevents publication and returns the setup to retryable roster-ready state.

Production must use a persistent `DATABASE_PATH`. Back up that SQLite file according to the hosting platform's volume procedure before infrastructure changes.
