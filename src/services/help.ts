export type HelpEntry = {
  usage: string;
  description: string;
};

export type HelpSection = {
  title: string;
  entries: readonly HelpEntry[];
};

// Hand-written, plain-language descriptions kept separate from each
// SlashCommandBuilder's own (more terse) .setDescription() text -- /help
// reads like a quick guide for someone unfamiliar with the bot, not a dump
// of Discord's command metadata. Add a new command's entry to the section
// matching the access policy that gates it (see
// src/services/authorization.ts); a section with no entries is simply
// omitted by formatHelpSections, so a future Player or Captain section only
// appears once a command actually exists for it.
export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    title: '🔎 Scout Commands',
    entries: [
      {
        usage: '/scout create',
        description:
          'Staff: run this in scout-ops. Choose the division, time and how many roles each player can pick. You can add a note or require a Discord role to join. Fill means any open role. Confirm before posting another game at the same time. With twenty players who can join, build two games. Rat pings the creator when teams are ready. Use Review roster to Shuffle, edit and Publish. After posting teams, use Swap or Replace player to make changes. Post match screenshots in the results channel.',
      },
      {
        usage: '/scout cancel',
        description: 'Staff: run this in scout-ops. Pick a game you can manage, then confirm cancellation. If teams are already posted, use Swap or Replace player instead.',
      },
    ],
  },
  {
    title: '🎮 Inhouse Commands',
    entries: [
      {
        usage: '/inhouse create',
        description: 'React 🎮 to the pinned message in inhouses to get the Inhouse role and game pings. Unreact to remove the role. With the role, run this command in inhouses to host. Anyone can join. Hosts manage only their own games. Rat tries to balance teams by division; you can change them yourself.',
      },
      {
        usage: '/inhouse cancel',
        description: 'In inhouses, pick one of your games and confirm cancellation. You need the Inhouse role. Once teams are posted, use the game controls to change players or finish the game.',
      },
    ],
  },
  {
    title: '🏟️ Division Commands',
    entries: [
      {
        usage: '/division add name:<division>',
        description: 'Creates missing roles and channels for a division, or repairs the ones Ratatoskr already manages.',
      },
      {
        usage: '/division status name:<division>',
        description: 'Shows which division roles and channels exist and which ones are missing.',
      },
      {
        usage: '/division archive name:<division>',
        description: "Hides a division's channels from members without deleting its history. This can be reversed.",
      },
      {
        usage: '/division delete name:<division> confirm:true',
        description: "Permanently deletes an archived division's channels and roles. This cannot be undone.",
      },
    ],
  },
  {
    title: '🎖️ Division Captain Access',
    entries: [
      {
        usage: 'Give both `Captain` + the division role',
        description:
          "Give the player both `Captain` and their division role, such as `Vanaheim`. Rat then adds `Vanaheim Captain`. Do not give the division Captain role by hand: Rat removes it if the player does not have both required roles.",
      },
    ],
  },
  {
    title: 'League Operations',
    entries: [
      {
        usage: '/transaction trade | drop | self-drop | pickup | rename | departure',
        description:
          'Allfather, Aesir and Valkyrie staff: run once to see the changes, then run the same command with confirm:true to approve. Rename changes the Discord server nickname and league records, keeping old names. Drop, self-drop and departure can include a replacement from the same division. Self-drop suspends the player for this season and the next; it does not make them a Free Agent. Rat checks Discord and both roster sheets, records who approved it, then posts the completed move in transactions.',
      },
    ],
  },
  {
    title: '🛡️ Admin Setup Commands',
    entries: [
      {
        usage: '/season create number:<n> [name:<custom name>]',
        description:
          'Creates the channels for a new season and makes it active. It stops safely if another season is already active.',
      },
      {
        usage: '/season status [number:<n>]',
        description:
          'Checks the active or selected season category and channels without changing, creating, or repairing anything.',
      },
      {
        usage: '/season close [number:<n>] [confirm:true]',
        description:
          'Previews the active season. Re-run with the season number and confirm:true to archive it. Discord channels stay unchanged.',
      },
      {
        usage: '/scout config [operations_channel:<#scout-ops>] [timezone:<time zone>] [bind_emoji:true]',
        description: 'Choose the scout-ops channel, extra staff who can manage all divisions, the time zone and signup emojis for each role. Fill is optional.',
      },
      {
        usage: '/server bootstrap plan',
        description: 'Shows which standard server roles and channels would be created, repaired, or removed without changing anything.',
      },
      {
        usage: '/server bootstrap apply [delete_obsolete:true]',
        description:
          'Creates or repairs the standard server roles and channels. Use delete_obsolete only after reviewing the plan.',
      },
    ],
  },
];

// Only sections that actually have something in them render -- an empty
// section (e.g. a future permission tier with no shipped commands yet)
// would otherwise show up as a confusing blank heading.
export function formatHelpSections(sections: readonly HelpSection[]): { name: string; value: string }[] {
  return sections
    .filter((section) => section.entries.length > 0)
    .map((section) => ({
      name: section.title,
      value: section.entries.map((entry) => `\`${entry.usage}\`\n${entry.description}`).join('\n\n'),
    }));
}
