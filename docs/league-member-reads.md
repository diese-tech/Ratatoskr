# League Discord member reads

Issue #156 separates full-guild observation from mutation proof. `leagueMemberReads.ts` coordinates requests by Discord Client session and guild ID. Separate command, UI, startup and worker adapters share a pending request. A different guild or Client has independent state. Nothing is persisted across reconnect/restart as mutation authority.

## Call-site inventory

| Caller | Adapter lifetime and use | Read contract |
| --- | --- | --- |
| `commands/transaction.ts` | New adapter for each command; full Sheets load builds the preview | Fresh complete request; no TTL fallback |
| `leagueOpsUi.ts` | Startup adapter bound to private UI; transaction/repair previews | Fresh complete request |
| `leagueTransactions.ts` | Worker adapter; rebuild/audit inside the canonical lock before writing | Fresh complete request |
| `leagueAuditResolution.ts` | Worker adapter; recheck finding/fingerprint for confirmed repair | Fresh complete request |
| `leagueRepairRecovery.ts` | Registered worker adapter; inspect interrupted repair | Fresh complete request; interrupted writes remain reviewable |
| `leagueAccountReplacement.ts` | Worker service; old/new identity plus full roster inspection | Fresh full request, then forced old/new member reads; no cache proof |
| `leagueOpsRuntime.ts` recovery | Long-lived worker adapter; inspect interrupted intent | Fresh complete request; no automatic ambiguous-write replay |
| `leagueAudit.ts` | Startup/6 AM/New York and on-demand recheck, through worker | Fresh complete request |
| `leagueOpsRuntime.ts` dirty fallback | Existing 2-minute read-only dirty cycle when targeted checks cannot cover findings | Detached complete snapshot younger than 60 seconds, otherwise one request; no cooldown wait |
| `leagueReconciliation.ts` | Member-event/dirty verification | Existing `getMember(id)` forced REST read plus targeted `loadMember` Sheets ranges; no full member request |
| Hourly heartbeat/panel | Presentation lane | No member request |

Participant role/name/nickname preconditions, write verification, rollback and absence checks retain forced single-member REST reads. Only `UnknownMember` confirms absence. Authorization also retains the existing forced worker/UI checks. The full pre-mutation comparison cannot be replaced by participant-only reads: ADR 0001 requires unrelated configured team/name/public drift to block writes too. This change does not weaken that contract to reduce network counts.

The structural division archival path in `divisions.ts` also requests every member. It needs actual SDK members for its separate management operation and is outside league transaction/audit coordination. Scout participant operations use single-member reads. No archival, Scout or league-management behavior changes here.

## Cache and recovery rules

- A fulfilled SDK collection supplies the snapshot, never the mutable `guild.members.cache`. Known member count, partial members, foreign-guild identities, unavailable guild and events during the request fail closed. Each consumer receives detached values.
- Only an explicit read-only observation can use the 60-second snapshot. Member add/remove/update, user name change, role update/delete, guild availability changes and shard disconnect/reconnect/ready/resume invalidate it. Count mismatch also invalidates it. Expired, failed and incomplete reads cannot produce an absence finding or authorize writes.
- A fresh caller may share an equivalent in-flight full request. Callers already waiting for cooldown may share a recovery request started after they began, even if their timers wake at different times. A new mutation read cannot reuse a completed TTL snapshot.
- Actual Gateway `opcode: 8` errors use `retry_after` **seconds**, plus a 250 ms margin. There is no 60-second clamp that retries before Discord allows it. REST/Sheets errors are not Gateway cooldowns. See [Discord Gateway Rate Limited fields](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway-events.mdx#rate-limited).
- A fresh reader waits at most 5 seconds total for cooldown and performs at most one recovery retry. Longer cooldowns return a typed transient error immediately. Observation readers never sleep. The existing durable worker schedules transient retries no earlier than the supplied cooldown while releasing the canonical lane; existing attempt limits, priorities and ambiguous-write classification remain.
- `AbortSignal` cancels a consumer's pending read or wait without cancelling other consumers' shared SDK request. Native cooldown timers are cancelled too. SDK requests retain discord.js's existing member-request timeout and listener cleanup; cancellation does not pretend the underlying Gateway request was revoked.
- Audit read failures retain prior resource findings and record a connection problem. Gateway cooldown, incomplete snapshot, Discord REST quota, and Sheets quota remain distinct. Failed reads never mark the full audit clean. Startup, 6 AM and on-demand audits still request fresh data; hourly heartbeat remains presentation only.

## Bounded diagnostics and live validation

`League member reads:` logs at most once per minute when a full request completes, containing cumulative attempts, actual throttles, coalesced consumers, observation hits, cooldown waits, deferrals and invalidations plus current cooldown milliseconds. No player data, token, workbook IDs or per-read staff messages are logged. `leagueMemberReadDiagnostics(guild)` provides a detached counter snapshot for an in-process diagnostic. Existing durable jobs expose queued wait through `availableAt` and retain the typed error privately.

After final-head CI/review and deployment:

1. Check startup, command registration, unchanged schema 34, no active/ambiguous canonical writes, and the fresh startup audit result. Record the deployment commit separately from local tests and CI.
2. Use the current League Ops card's authorized **Recheck roster** control. This is read-only. Confirm a new full-audit timestamp, healthy/current findings and no transaction/account-replacement records or role/Sheet writes caused by the check.
3. Capture `League member reads:` counters from the active process. A normal smoke test may show zero throttles/coalesced consumers: do not manufacture a production throttle or approve player operations just to increase counters.
4. On ordinary future parallel previews, check that coalesced consumers increase without equivalent duplicate attempts. On a real upstream throttle, check cooldown, bounded waits/deferrals and later recovery; preserve the private operation's retry/reference. Do not replay old incident jobs.

Automated tests exercise distinct adapters/guilds/sessions, fresh vs observation consumers, event invalidation, cache eviction, incomplete/expired reads, short and long cooldowns, staggered recovery, cancellation, second-throttle stopping, worker priority/deferral and audit finding preservation. An installed discord.js request test emits the actual `RATE_LIMITED` payload and member chunk to verify SDK error shape and listener cleanup; it is a simulation, not a real upstream rate-limit event.
