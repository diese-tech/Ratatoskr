# Optional open inhouses

Inhouses reuse Scout's play-role signups, working roster, manual swaps/replacements, publication, lobby-host selection, participant withdrawal and finish/recovery flow. `/inhouse create` opens a private setup preview in the configured permanent channel; `/inhouse cancel` lists only the caller's unpublished games. The current Inhouse role is required to host and to manage one's own game, including confirmed actions. Other role holders and administrators cannot manage another creator's inhouse. Removing the opt-in reaction removes hosting access as well as notifications. Any human with access to the channel can join without the Inhouse role or a division role.

Opening signups pings only the configured Inhouse role. The permanent opt-in post itself does not ping anyone. Existing participant notifications and lobby-host actions still use the shared game flow.

Automatic seat matching fills as many compatible play-role seats as possible, then spreads active division representation between Order and Chaos. A member with zero or multiple matching division roles supplies no balance hint. There are no invented skill weights, eligibility restrictions or balance thresholds. Balancing never drops participants or blocks a full roster; manual seats remain fixed during signup reconciliation. Hosts can adjust teams in Ratatoskr or in game. Shuffle deliberately regenerates the roster, as in Scout.

Migration 35 adds an explicit workflow and permits a null division only for open inhouses, with no eligibility role. Existing Scout rows retain their division and default Scout workflow. The persistent role/channel/message bindings are separate from division/season managed resources, so division reset and archival do not target them. SQLite 3.53 or later is required for the nullability change. Follow the README deployment backup and production-copy migration rehearsal before deploying.

## Provisioning the permanent channel and opt-in post

Use the existing authorized Railway service context after migration 35 is deployed. Confirm the owner's exact category, role/channel names and Unicode reaction before provisioning. The proposed names are Inhouse / #inhouses in Midgard with 🎮; live approval of these names remains separate from code delivery.

Run the operator script with the actual deployed commit and persistent database path:

```sh
npx tsx scripts/setup-inhouses.ts --expect-guild-id="$DISCORD_GUILD_ID" --expect-database-path="$DATABASE_PATH" --expect-commit="$RAILWAY_GIT_COMMIT_SHA" --category-id=APPROVED_ID --category-name=APPROVED_NAME --role-name=APPROVED_ROLE --channel-name=approved-channel --emoji=APPROVED_UNICODE
```

This preview opens the existing database read-only, applies no migrations and creates nothing. Save and inspect its fingerprint, then rerun with the same arguments plus `--write --expect-plan=REVIEWED_FINGERPRINT`. Changed bindings, category permissions or resource targets require a fresh preview. The new zero-permission role must be below Ratatoskr; the channel inherits category privacy. Bot management and posting permissions must already exist. The script never grants broader access or replaces bound resources.

Creation is checkpointed in SQLite. A lost role/channel response can be adopted only with Ratatoskr's matching creation audit reason; a lost opt-in response is recovered by its unique bot-owned message marker. Re-preview after a partial failure instead of blindly replaying a stale fingerprint. Missing, renamed, duplicate or unowned resources stop setup for review. The canonical post is pinned, and startup/hourly reaction reconciliation observes offline opt-ins/opt-outs; pending targeted role changes retry up to 25 per minute, without fetching all server members or calling Sheets.

## Discord acceptance

Verify the channel is in the approved permanent category and retains its privacy. React to the pinned post and confirm only the Inhouse role is added; unreact and confirm only that role is removed. Rejoin the role and inspect `/inhouse create`'s private preview. Check signups ping only Inhouse, non-role players can join, creator-only controls reject another host, and unsubscribing prevents confirmed management. With real participants, verify balanced/manual roster edits, publication, lobby-host actions and finish. Source integration tests and CI do not substitute for this live game acceptance.
