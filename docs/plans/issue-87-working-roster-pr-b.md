# Issue 87 PR B implementation plan

Issue: https://github.com/diese-tech/Ratatoskr/issues/87

This document is the implementation handoff for PR B. Issue 87 remains the
authoritative product and UX specification. This plan maps that specification
onto Ratatoskr after PR A (`056392a`, merged as `feac704`) and must not be used
to broaden the issue's scope.

## Starting point

PR A is deployed to Railway with migration 18 applied. It provides:

- setup-level Organizer persistence in `scout_coordination`, created in the
  same transaction as `scout_setups`;
- per-game Lobby Host persistence in `scout_game_hosts` and guarded initial
  host assignment from each game's published players;
- assignment metadata on `scout_roster_slots`: `off_role`,
  `assigned_by_user_id`, `replacement_needed`, and
  `replacement_requested_at`;
- one-player-once-per-setup enforcement through
  `idx_scout_roster_slots_setup_user`;
- `scout_events` for internal lifecycle audit records;
- `scout_notifications` with dedupe keys, nonces, scheduled/attempted/sent/
  skipped states, persisted payloads, claims, and cooldown lookup;
- `generateScoutWorkingRoster()`, a maximum-cardinality partial matcher with
  fixed-seat support, while `generateScoutRoster()` retains the old complete
  roster contract;
- published setups remaining lifecycle blockers until completion and Discord
  reconciliation finish.

Production migration rehearsal and deployment verification passed. PR B must
not replace these primitives with parallel state.

## Architecture rules

1. `scout_setups` remains the lifecycle aggregate and its `version` remains
   the optimistic-concurrency token for all roster and coordination mutations.
2. `scout_roster_slots` stores occupied assignments only. Missing locations
   are derived and rendered as `OPEN`; do not persist placeholder users.
3. The signup message ID, result message ID, and Scout Ops control message ID
   already persisted on the setup are the canonical message relationship.
   Publication creates exactly one result message and later operations edit it
   in place.
4. Organizer is setup-level. Lobby Host is `(setup_id, game_number)`. A
   two-game setup always has two independently mutable Hosts.
5. The snapshotted `operations_channel_id` is the original hosting/ops
   location for Organizer escalations. Do not resolve it from current guild
   configuration at interaction or notification time.
6. Existing division management authorization remains the admin/coordinator
   boundary. Host and roster-member capabilities are narrow additional checks,
   never management-role grants.
7. Existing setup and division operation locks, database transactions, setup
   version claims, and Discord reconciliation are extended rather than
   bypassed.
8. Internal IDs remain available in database rows, custom IDs, logs, and audit
   payloads, but `SCOUT-*` markers must leave normal message content.

## Working roster lifecycle

### Persistence and reconciliation

Add one transactional repository operation that reconciles a working roster
from an already-resolved eligible-signup snapshot:

- Accept `setupId`, `expectedVersion`, generated occupied slots, and the
  actor/source of the reconciliation.
- Permit only active `open` or `roster_ready` setups that have not been
  published or completed.
- Preserve current manual assignments as `fixedSlots`; recalculate automatic
  assignments through `generateScoutWorkingRoster()`.
- Replace only automatic rows and keep manual row IDs/metadata stable where
  practical.
- Move status to `roster_ready` only at 10/10 per game, and back to `open` if
  an automatic assignment disappears and the working roster becomes
  incomplete. This preserves the existing meaning of `roster_ready` as
  publishable rather than introducing a new status.
- Increment `scout_setups.version` only when the occupied assignment,
  assignment metadata, game count, or readiness status actually changes.
- Enforce the setup-wide user uniqueness index inside the same transaction.
- Append a concise event after a successful material change.

Call this reconciliation from the existing per-setup locked paths in
`scoutSignups.ts`: reaction add, reaction remove, startup reconciliation, and
membership/eligibility refresh. Eligibility is still resolved by
`eligibleScoutSignups()` before domain matching. Staff-assigned seats retain
the existing explicit-override behavior rather than silently disappearing
because a reaction changed.

### Scout Ops rendering

Replace count-first telemetry with one working-roster renderer used by both
`open` and `roster_ready` Scout Ops states. It must derive:

- occupied seat lines grouped by game, team, and role;
- explicit `OPEN` locations;
- `X/10 seated` per game and missing role labels;
- every eligible, unseated signup and all declared roles;
- manual/off-role assignment labels;
- publish readiness and any withdrawn/manual exception warning.

The persisted readiness snapshot may remain for diagnostics, but it is no
longer the primary operator content. `refreshScoutStatusCard()` remains the
single serialized writer and must edit/recover the existing control artifact
instead of sending a second working card.

Controls:

- `Seat player`, `Swap players`, and `Refresh draft` are available to division
  managers while building.
- `Publish roster` is enabled only when every required location is occupied
  and no existing withdrawal block applies.
- Existing two-game construction remains explicit. A two-game working roster
  is 20 unique players and is rendered as two games.
- Cancel behavior remains unchanged.

### Manual and off-role assignment

Implement the seat flow as Player -> Game/Team/Role -> confirmation when
off-role. Candidate players must be eligible, unseated signups for the setup;
the setup-wide uniqueness constraint is the final database guard.

The repository mutation must atomically:

- claim the expected setup version;
- insert or replace the selected occupied location;
- set `staff_assigned = 1` and `assigned_by_user_id` to the staff actor;
- set `off_role` from the player's current declared role/fill signups;
- append an audit event containing the prior and resulting assignment;
- return a typed stale, duplicate, ineligible, occupied, or updated outcome.

Off-role confirmation must revalidate all facts when confirmed. A stale
confirmation never performs the seat.

Assignment metadata follows the player during a swap or move:
`user_id`, `staff_assigned`, `off_role`, `assigned_by_user_id`,
`replacement_needed`, and `replacement_requested_at` move as one assignment
tuple. Replacing a player clears the outgoing availability flag and computes
fresh off-role/actor metadata for the incoming assignment. Add repository
tests for this rule before wiring Discord controls.

## Publication and canonical messages

Extend the existing publish claim/reconciliation rather than adding another
published-roster record.

Before the first result send, a transaction must:

- revalidate the complete roster and expected setup version;
- claim publication using the existing status transition;
- choose one Host from each game's current roster, with injectable randomness
  for tests, and initialize every `(setup, game)` host row;
- create one scheduled T-30 notification for the setup when publication occurs
  before its T-30 cutoff;
- create skipped T-30 rows with a late-publication reason when the cutoff has
  passed, so a restart cannot reinterpret the publication as due;
- append publication and initial-host events.

Random Host selection is the issue's allowed fallback. Do not add a fairness
history algorithm in PR B; `scout_events` leaves room for that later without
expanding this issue.

The existing result-send recovery continues to own the one canonical roster
message. Render each game's Host next to that game's roster. After the result
message ID is durable, edit the signup post with a direct roster link and edit
the result with a direct original-signup link. The Scout Ops card collapses to
the filled direct-link reference. All swaps, replacements, Host changes, and
finish operations re-render that same result message.

Remove visible `SCOUT-RESULT-*`, `SCOUT-UPDATE-*`, `SCOUT-CONTROL-*`, and
`SCOUT-TELEMETRY-*` lines. Recover known messages by persisted IDs. For an
ambiguous initial send, correlate active cards/results through their setup-
scoped component custom IDs. Notification sends use their durable attempted
state and are never blindly resent after an ambiguous response.

## Organizer and per-game Hosts

Add transactional repository mutators for:

- changing the setup Organizer with an expected setup version;
- changing one game's Host with an expected setup version;
- automatically replacing one game's Host when the current Host becomes
  replacement-needed or is replaced.

Every Host mutation must prove that the selected user is currently seated in
that game. Automatic reassignment excludes the departing/replacement-needed
player and uses injectable randomness. A one-game setup has one Host; a
two-game setup has two Hosts. Host changes in one game cannot alter the other
game's row or notifications.

Append events for Organizer changes and each per-game Host change. Host status
does not modify Discord roles or management authorization.

## Availability and replacement flow

`Can't play` is a public roster button, but the handler authorizes from current
database state:

- setup is published, unreconciled work is absent, and scout is not finished;
- interaction user occupies exactly one setup slot;
- the target is implicitly the interaction user, never a client-provided user
  ID.

Confirmation revalidates the setup version and assignment. The transaction
sets `replacement_needed` and `replacement_requested_at` without removing the
player, appends an event, and reassigns that game's Host when required. A
repeat click is idempotent and does not send another alert.

Schedule an immediate `availability_alert` to the snapshotted operations
channel. Resolve the current Organizer, current canonical roster link, and
current slot context when claiming the notification. Refresh the Scout Ops
control message to its replacement-needed variant.

The authorized replacement picker orders unique, unseated eligible signups as:

1. exact role or fill candidates;
2. other signup-role candidates, visibly marked off-role;
3. the existing explicit eligible-member fallback where current management
   rules allow it.

Replacement confirmation atomically revalidates the candidate, expected
version, slot, uniqueness, and publication state; writes the new assignment;
clears replacement-needed state; recalculates off-role metadata; reassigns the
Host for that game if needed; and appends events. The existing roster-update
reconciliation edits the canonical message. Replace its technical notice with
an incoming-player-focused `replacement_notice` containing time, game, team,
role, outgoing player, and direct roster link. This notification is the
incoming player's reminder when replacement occurs after T-30; no retroactive
T-30 row is created.

Scout Ops returns to filled only when no slot in any game is replacement-
needed. If multiple games have flags, render all affected game/team/role
locations while keeping replacement actions game-specific.

## Notifications and scheduler

Create a `scoutNotifications` service over the PR A repository primitives.
Use one in-process scheduler because Ratatoskr runs as one Railway replica and
SQLite is the durable source of truth:

- run once during `clientReady` after existing publication/update recovery;
- poll due rows at a short fixed interval (for example 15 seconds);
- claim each row transactionally before Discord work;
- resolve current setup, completion, roster, Host, Organizer, and message IDs
  at claim time;
- persist the final payload before sending;
- mark sent with the returned Discord message ID;
- skip scheduled rows for cancelled, finished, unpublished, late-published,
  missing-game, or otherwise invalid current state;
- process a bounded batch and serialize notifications per setup so they do not
  race roster/control-card edits.

T-30 remains one notification per scout, with dedupe key `t30:<setupId>` and a
null `game_number`. At execution it resolves the complete current roster and
all current per-game Hosts. A two-game reminder identifies each game's Host;
it is not split into two sends. Host reassignment and `Ping organizer` remain
game-scoped.

Manual `Ping roster` is an admin/coordinator action and resolves the complete
current setup roster at confirmation time. A two-game setup therefore pings
both current game rosters once. Add one atomic scheduling operation that checks
scheduled, attempted, and sent rows inside the cooldown window before inserting
the immediate notification; the existing read helper alone is not sufficient
for concurrent clicks. Use an approximately five-minute setup-level cooldown.

`Ping organizer` is authorized only when the actor is the current Host for the
encoded game. It resolves the current Organizer and posts to the original ops
channel with a short per-game cooldown. It grants no other control.

Discord has no idempotency key for sends. Preserve at-most-once behavior across
the crash window: a persisted `attempted` row without `message_id` is delivery-
uncertain and must not be automatically resent. Report it through the existing
operational-error path for inspection. Scheduled rows that were never claimed
continue normally after restart.

## Interaction routing and authorization

Keep `scout:<action>:<setupId>:<version>[:<game/slot>]` custom IDs and add
handlers through `commands/index.ts`. Parse IDs strictly and treat all embedded
IDs as routing hints only.

Every state-changing handler must reload and verify:

- guild and snapshotted channel identity;
- setup lifecycle/completion state;
- expected setup version where the operation mutates state;
- division management access for all management actions;
- exact current per-game Host identity for `Ping organizer`;
- exact current roster membership for `Can't play`;
- relevant game, slot, candidate, and message relationship.

Unauthorized or stale interactions answer ephemerally and perform no mutation
or public send. Link buttons remain public navigation.

## Finish behavior

Keep `finishScoutSetupIfVersion()` and the existing linked-signup finish path.
Extend finish reconciliation to:

- keep the canonical roster content intact;
- remove mutation, reminder, availability, Host, and Organizer controls;
- retain direct signup/roster navigation;
- render finished signup, roster, and compact Scout Ops states without
  technical markers;
- skip any still-scheduled notifications in the database;
- append the finish event while retaining the existing completion record.

Finish and cancel must win safely against scheduler claims and interactions by
using current-state checks in both the mutation transaction and notification
claim path. An already-attempted Discord send remains delivery-uncertain and is
not duplicated.

## Expected file changes

Modify:

- `src/db/repositories/scoutSetups.ts`: partial-roster reconciliation and
  metadata-correct seat/swap/replace transactions.
- `src/db/repositories/scoutCoordination.ts`: versioned Organizer change.
- `src/db/repositories/scoutGameHosts.ts`: versioned per-game Host changes and
  automatic reassignment.
- `src/db/repositories/scoutNotifications.ts`: atomic cooldown scheduling and
  claim-time validation support.
- `src/db/repositories/scoutEvents.ts`: event constants/helpers if useful;
  retain the generic durable event representation.
- `src/db/index.ts` and `src/db/types.ts`: typed exports/outcomes only; no
  migration 19 is currently expected.
- `src/domain/scoutRoster.ts`: only matcher/result helpers required by the
  persisted reconciliation; preserve the complete-wrapper contract.
- `src/services/scoutSignups.ts`: invoke working-roster reconciliation from
  existing locked signup and eligibility paths.
- `src/services/scoutReview.ts`: working-card rendering, refresh, manual seat,
  off-role confirmation, and metadata-correct draft edits.
- `src/services/scoutPublish.ts`: atomic publication preparation, Host-aware
  canonical rendering, navigation, role-aware replacement notices, and marker
  removal.
- `src/services/scoutCardLifecycle.ts`: working/filled/replacement-needed/
  finished compact states and marker-free recovery.
- `src/services/scoutSignupPost.ts` and `src/services/scoutFinish.ts`:
  bidirectional links and final read-only states.
- `src/services/scoutAuthorization.ts`: shared management/Host/member guards
  without granting Host management authority.
- `src/commands/index.ts`, `src/services/interactionErrors.ts`, and
  `src/index.ts`: new interaction routing, operational context, scheduler
  startup, and graceful interval shutdown.

Create where separation keeps the existing files manageable:

- `src/services/scoutCoordination.ts`: Organizer/Host controls and escalation.
- `src/services/scoutAvailability.ts`: Can't Play and replacement-needed flow.
- `src/services/scoutNotifications.ts`: render, claim, send, recovery, cooldown,
  and scheduler lifecycle.
- focused unit/integration tests beside each service.

## Implementation order

Keep PR B reviewable with the following commit sequence:

1. Repository transactions and metadata-follow-assignment tests.
2. Persisted partial reconciliation from signup/restart paths.
3. Working Scout Ops renderer and manual/off-role controls.
4. Publication transaction, per-game Hosts, canonical links, and collapsed Ops.
5. Can't Play, role-aware replacement, Host reassignment, and contextual notice.
6. Durable T-30/manual/Host notification worker and restart recovery.
7. Finish-state controls, visible internal-ID removal, integration tests, and
   operational documentation.

Do not begin a later commit while its prerequisite repository behavior is
untested.

## Required tests

Repository/domain tests:

- maximum-cardinality partial seating, deterministic ordering, fill roles,
  fixed manual seats, one/two-game uniqueness, and complete-wrapper parity;
- partial reconcile add/remove/no-op/stale transitions and `open` <->
  `roster_ready` status changes;
- manual exact-role and confirmed off-role seating;
- assignment metadata follows players through every draft/published swap;
- replacement clears availability metadata and recomputes off-role metadata;
- Organizer changes are setup-scoped; Host changes/reassignment are game-
  scoped and roster-validated;
- notification dedupe, atomic cooldown, claim, skip, sent, and attempted-
  uncertain behavior.

Interaction/integration tests:

- signup reactions and membership changes update the same working Ops card;
- stale refresh/seat/swap/publish confirmations make no change;
- public buttons deny unauthorized users server-side and only ephemerally;
- a Host cannot mutate rosters or ping another game's Organizer path;
- a roster member can flag only themselves and only while currently seated;
- repeat Can't Play is idempotent and does not duplicate alerts;
- replacement candidates are exact-role first, then labeled off-role;
- one canonical result message survives swaps, replacements, Host changes,
  reminders, and finish;
- signup/result deep links remain stable through the full lifecycle;
- T-30 resolves the complete current roster and all per-game Hosts, sends once
  per setup, skips late/unpublished/finished/cancelled setups, and does not ping
  replaced players;
- manual ping resolves at confirmation time and concurrent clicks respect the
  cooldown;
- replacement after T-30 sends only the replacement notice to the incoming
  player;
- restart recovers scheduled notifications, refuses ambiguous attempted
  resends, and reconciles working/filled/replacement-needed/final cards;
- finish racing a notification or roster mutation produces one valid terminal
  state and no later send;
- no normal rendered message contains `SCOUT-RESULT`, `SCOUT-UPDATE`,
  `SCOUT-CONTROL`, `SCOUT-TELEMETRY`, or equivalent technical correlation IDs.

Run `npm ci`, both typechecks, build, full tests, `npm audit`, and
`git diff --check` on the final head. CI must pass on Ubuntu and Windows.

## Deployment gate

PR B is behavior-only against migration 18 unless implementation uncovers a
demonstrated schema gap. If a migration becomes necessary, stop and review it
explicitly rather than folding it into unrelated behavior.

After merge, verify the Railway deployment uses the PR B merge SHA, startup
reconciliation completes, the notification worker starts once, schema remains
18 (or the explicitly reviewed later version), and live integrity/foreign-key
checks remain clean. Keep the existing manual Discord acceptance boundary:
exercise a disposable one-game scout and a two-game scout through partial
seating, off-role confirmation, publication, per-game Hosts, Can't Play,
replacement, reminders/cooldowns, navigation, and finish before closing issue
87.

## Non-goals

Do not add attendance tracking, ready checks, automatic replacement selection,
match reporting, Discord roles for Hosts, a general assignment system, or a
second roster/notification source of truth.
