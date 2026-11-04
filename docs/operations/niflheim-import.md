# Niflheim import runbook (#199)

This one-time import puts the Niflheim teams and players into Rat's sheets, so `/transaction` and the roster check work for Niflheim. It **only writes the Google Sheets**. It never changes Discord roles. Background: [ADR 0002](../adr/0002-layered-niflheim-membership.md) and tracker #195.

What it does:

- adds a **League Teams** row for each Niflheim team that has players;
- adds a **Niflheim row in Current Rosters** for each player holding a `<Team> ND` role. The draft captain is marked `Captain`;
- gives players **new to Rat** a Svartalfheim free-agent record and adds them to the public Svartalfheim free-agent list;
- returns **Inactive** drafted players to Svartalfheim free agency, with one `reactivation` row in Transaction History;
- creates the public **Niflheim Roster** tab from `Roster Default (DNE)` and fills in the team blocks.

It does not track draft picks, refresh the Member Directory or Role Guide, or change anyone's Discord roles.

## Before you start

- **Run it from the Railway service console in a browser.** Open the Ratatoskr service, then the **Console** tab. That shell already has the bot's secrets, including the sealed Google key.
- **Set up the shell.** The console starts without Node on its path, so run this first:

  ```bash
  export $(tr '\0' '\n' < /proc/1/environ | grep '^PATH=')
  ```

- **Pick a quiet time.** Don't run roster commands while the import is running.

## 1. Dry run (changes nothing)

```bash
node_modules/.bin/tsx scripts/import-league-division.ts --division=Niflheim
```

Read the output top to bottom:

- **Must be resolved before importing:** nothing can be written until each item is fixed in Discord or the sheets, or explicitly accepted. Each item has an ID in brackets.
  - **A player on a new account.** If they match an earlier Rat record, such as Thinks, and it is the same person, link the accounts:

    ```
    --link=<new Discord ID>:<earlier Discord ID>
    ```

    The earlier account must be Inactive, out of the server and on no roster. If they are a different person, accept the finding so they are added as a new player:

    ```
    --accept=earlier-account:<new Discord ID>
    ```

  - **Anything else** you have checked and want to import anyway: `--accept=<id>`. Several IDs are comma-separated.
- **For your information:** nothing blocks. Read it anyway.
- **Teams, players, new to Rat, returning:** exactly what will be written.
- **Discord roles to fix afterwards:** who needs roles fixed after the import (step 4).

Re-run the dry run, with your `--link` and `--accept` options, until "Must be resolved" shows `(0)`. The last line then prints the exact command to apply that plan.

## 2. Apply

Copy the command the dry run printed, keeping any `--link` and `--accept` options:

```bash
node_modules/.bin/tsx scripts/import-league-division.ts --division=Niflheim --write --expect-admin-id=<id> --expect-public-id=<id> --expect-plan=<hash>
```

- **If the plan changed**, because anyone edited the sheets or Discord after the dry run, the import stops and **writes nothing**. Run a new dry run, review it, and use its new command.
- **Run the dry run and the apply on the same day.** The date is part of the plan.
- **When it finishes**, it checks the sheets again and says "Import complete" when nothing is left to import. Running it again just says there is nothing to do.

## 3. Check

On the **League Status** card in staff-ops, press **Check again**. The Niflheim players should now appear, with no problems except Discord roles still to fix.

## 4. Fix Discord roles

In **Open league tools → Review problems**, open each role problem the dry run listed and choose **Set Discord roles from roster sheets**. This adds missing `Free Agent` and `Svartalfheim` roles for the new players.

## Optional clean-up

The old `ROLE_NIFLHEIM_FREE_AGENT_ID` Railway variable is no longer used. The bot ignores it and logs one warning at startup. You can delete it whenever you like.

## If something goes wrong

- **The import stops before writing** (it says nothing was changed): fix what it names and start again from the dry run.
- **The import stops part-way:** do **not** run `--write` again. Run a dry run and compare it with the sheets. To undo, open each workbook's **File → Version history** and restore the version from just before the import.
