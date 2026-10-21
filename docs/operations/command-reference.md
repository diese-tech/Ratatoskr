# Ratatoskr command guide

Use `/help` for a private quick guide. Commands run in the YSL server unless noted. A preview shows the proposed changes; it does not approve them.

**Admin** means Allfather or Aesir. **League staff** includes Allfather, Aesir and Valkyrie. **Scout staff** includes league staff, Franchise Representatives, any extra roles chosen in Scout settings, and the selected division’s Manager or Captain. Division Manager/Captain access applies only to their own division. A Discord Administrator permission alone does not give access to the other commands.

## General

`/help` — Show command help privately — Anyone.

## Server setup

`/server bootstrap plan` — Preview standard server roles and channels — Admin or Discord Administrator.

Review the report, including any old items that could be removed. Nothing changes.

`/server bootstrap apply [delete_obsolete:true]` — Set up or repair standard roles and channels — Admin or Discord Administrator.

The optional `delete_obsolete` setting removes the old bot-owned items shown in the report. Leave it off unless you reviewed that list. Rat leaves unrelated roles and channels alone. This command has a special Discord Administrator exception so an admin can set up a new server before the Allfather/Aesir roles exist.

## Seasons

`/season create number:<number> [name:<category name>]` — Set up and activate a season — Admin.

The number is required and must be at least 1. The optional name replaces `YSL Season N`. Rat stops if another season is active or that number belongs to a closed season. It can finish an incomplete setup without creating another season record.

`/season status [number:<number>]` — Check the season’s category and channels — Admin.

Leave the number out to check the active season. This command does not fix or change anything.

`/season close [number:<number>] [confirm:true]` — Preview or close the active season — Admin.

Run once without confirmation. Then run the exact command Rat provides, including the season number and `confirm:true`. Closing the season cannot be undone. Its Discord category and channels stay unchanged.

## Divisions

`/division add name:<division>` — Set up or repair a division — Admin.

The division is required; choose one from the list. This can restore a hidden division.

`/division status name:<division>` — Check a division’s roles and channels — Admin.

This only checks; it does not repair anything.

`/division archive name:<division>` — Hide division channels and keep their history — Admin.

This can be reversed by setting the division up again. Finish or cancel its active Scout games first.

`/division delete name:<division> confirm:false` — Preview permanent division removal — Admin.

`/division delete name:<division> confirm:true` — Remove the previewed division channels and roles — Admin.

Both arguments are required. The division must already be hidden. Removal cannot be undone. Rat stops if there are unfinished games/posts or channels in the category that it does not own. Check the preview before confirming.

## Scout games

`/scout create division:<division>` — Set up a division scouting game — Scout staff, in scout-ops.

Choose the required division. Enter a start time, how many play roles each player may choose, and an optional note. You can require a Discord role to join. Review the private preview, then post signups. Rat asks you to confirm if you already created another game at the same time.

Players react to sign up. Fill means any open role. When teams are ready, Rat alerts the creator. Use the game controls to review, shuffle, add or replace players, split enough signups into two games, and post the teams. After teams are posted, use their controls to swap/replace players, change the lobby host, notify players, or report that you cannot play. Staff can finish the game from its latest status card. Players post match screenshots in the results channel themselves.

`/scout cancel` — Choose a Scout game to cancel — Scout staff, in scout-ops.

Choose an open game you can manage, then confirm cancellation. There is no `division` option on this command. Once teams are posted, use the game controls to change players or finish instead.

`/scout config [timezone:<time zone>] [operations_channel:<channel>] [bind_emoji:true]` — Change Scout settings — Admin.

All options are optional. Choose a time zone from the suggestions, such as `America/New_York`. Choose a server text channel inside the Scout Operations category for staff tools. With `bind_emoji:true`, follow the reaction prompt to choose Solo, Jungle, Mid, Support and Carry emojis; Fill is optional. The role menu chooses extra staff roles that may manage games in every division. Valkyries can manage games but cannot change these settings.

## Inhouses

`/inhouse create` — Set up an open inhouse — Inhouse role, in inhouses.

React 🎮 to Rat’s pinned message for the Inhouse role and game pings. Unreact to remove it. Anyone with channel access can join a game without that role. Hosts can manage only games they created, and they must still have the role. No other host or admin can take over their game through these tools.

The setup and game controls work like Scout. Rat tries to balance teams by division after filling the play roles. An imperfect balance does not stop a game; hosts can change teams manually or in game.

`/inhouse cancel` — Choose one of your open games to cancel — Inhouse role, in inhouses.

Choose your game, then confirm. Once teams are posted, use the game controls to change players or finish.

## Player changes

These commands are for **League staff**. Run once to review the changes. Run the same command with `confirm:true` to approve. Rat checks the latest records again before making changes. If they changed, review a new preview. Use the League Status message in staff-ops to check a saved action; do not repeat a change that is already being handled.

`/transaction trade player_one:<player> player_two:<player> [confirm:true]` — Swap players between teams in one division — League staff.

Both players are required, must be on different teams, and must be in the same division.

`/transaction drop player:<player> [replacement:<player>] [confirm:true]` — Release a player as a Free Agent — League staff.

The optional replacement must be a Free Agent from the same division.

`/transaction self-drop player:<player> [replacement:<player>] [confirm:true]` — Record a self-drop suspension — League staff.

Choose the player from the roster suggestions, including someone who left Discord. They are suspended for this season and the next; they do not become a Free Agent. An optional replacement must be a Free Agent from the same division.

`/transaction departure player:<player> [replacement:<player>] [confirm:true]` — Remove a player who left the server — League staff.

Choose the departed player from roster suggestions. An optional replacement must be a Free Agent from the same division.

`/transaction pickup player:<player> team:<team role> [confirm:true]` — Add a Free Agent to a team — League staff.

Choose the team role for the player’s division. Both arguments are required.

`/transaction rename player:<player> league_name:<name> [confirm:true]` — Change a Discord nickname and league name — League staff.

Both arguments are required; names must be 1–32 characters. Rat changes the server nickname and both roster sheets while keeping old names in history. Its Discord permissions and role position must allow it to change that player’s nickname.

## League tools

Use **Open league tools** on the latest **League Status** message in staff-ops. These are private buttons, not extra slash commands. League staff can review roster problems, check saved actions and preview fixes. Nothing changes until confirmation. For a player changing Discord accounts, verify that both accounts belong to the same person before typing `SAME PLAYER`. For an interrupted action, check Discord, sheets and history before typing `HISTORY REVIEWED` to close it. Rat does not run the old change again.

## Discord copy/paste guide

**Rat command guide**

**Access:** Admin = Allfather/Aesir. League staff = Admin/Valkyrie. Scout staff = League staff, Franchise Rep, extra Scout roles, or your division’s Manager/Captain.

**General**
`/help` — Private command help — Anyone

**Admin setup**
`/server bootstrap plan` — Preview standard roles/channels — Admin or Discord Administrator
`/server bootstrap apply` — Set up or repair roles/channels — Admin or Discord Administrator
`/season create number:<number>` — Start a new season — Admin
`/season status` — Check the active season — Admin
`/season close` — Preview closing the active season — Admin
`/scout config` — Choose Scout staff, channel, time zone and emojis — Admin
After reviewing `/season close`, run the exact command Rat gives you with the season number and `confirm:true`.

**Divisions**
`/division add name:<division>` — Set up or repair a division — Admin
`/division status name:<division>` — Check division roles/channels — Admin
`/division archive name:<division>` — Hide a division and keep history — Admin
`/division delete name:<division> confirm:false` — Preview permanent removal — Admin
After checking the removal list, run the same command with `confirm:true`. Permanent removal cannot be undone.

**Games**
Run Scout commands in scout-ops and Inhouse commands in inhouses.
`/scout create division:<division>` — Set up a scouting game — Scout staff
`/scout cancel` — Pick a game and confirm cancellation — Scout staff
`/inhouse create` — Host an open inhouse — Inhouse role
`/inhouse cancel` — Cancel one of your open games — Inhouse role
React 🎮 to the pinned Inhouse message for the role. Anyone can join; hosts manage their own games.

**Player changes**
Run once for a preview, then run the same command with `confirm:true`.
`/transaction trade player_one:<player> player_two:<player>` — Swap teammates across teams — League staff
`/transaction drop player:<player>` — Release a player as a Free Agent — League staff
`/transaction self-drop player:<player>` — Record a self-drop suspension — League staff
`/transaction departure player:<player>` — Remove someone who left the server — League staff
`/transaction pickup player:<player> team:<team role>` — Add a Free Agent to a team — League staff
`/transaction rename player:<player> league_name:<name>` — Change nickname and league records — League staff
Drop, self-drop and departure can include `replacement:<player>` from the same division.
Check saved actions through **Open league tools** in staff-ops. Do not repeat a saved change or unfinished post.
