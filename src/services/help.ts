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
          'Staff or that division\'s captains run this in its scout-signups channel. Choose the time, signup limit, note, and optional eligibility role, then review and post the game. Fill can cover any missing role. A second game at the same time requires confirmation, and twenty eligible players can build two games. Use the private review controls to Shuffle, edit across games, and Publish; published rosters provide Swap and Replace player controls.',
      },
      {
        usage: '/scout cancel',
        description: 'Authorized staff or that division\'s captains cancel an open or roster-ready setup after confirmation. Published rosters use their Replace player control instead.',
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
    title: '🛡️ Admin Setup Commands',
    entries: [
      {
        usage: '/season create number:<n> [name:<custom name>]',
        description:
          'Creates the channels for a new season and makes it active. It stops safely if another season is already active.',
      },
      {
        usage: '/scout config [timezone:<IANA zone>] [bind_emoji:true]',
        description: 'Sets all-division scout staff, the game-time timezone, five required role emojis, and optional Fill.',
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
