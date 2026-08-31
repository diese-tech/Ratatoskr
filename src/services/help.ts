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
    title: '🛡️ Admin Commands',
    entries: [
      {
        usage: '/division add name:<division>',
        description: 'Creates (or repairs) all the roles and channels for a division.',
      },
      {
        usage: '/division status name:<division>',
        description: "Shows what's already set up for a division and what's still missing.",
      },
      {
        usage: '/division archive name:<division>',
        description: "Hides a division's channels from members without deleting anything -- safe and reversible.",
      },
      {
        usage: '/division delete name:<division> confirm:true',
        description: "Permanently deletes an archived division's channels and roles. Cannot be undone.",
      },
      {
        usage: '/season create number:<n> [name:<custom name>]',
        description:
          'Creates and activates the season workspace (schedule, standings, rosters, and more) for a new season. ' +
          'Refuses to run if a season is already active.',
      },
      {
        usage: '/scout config [timezone:<IANA zone>] [bind_emoji:true]',
        description: 'Configures additional scout staff, the scout timezone, and the five role signup emoji.',
      },
      {
        usage: '/server bootstrap plan',
        description: 'Previews the base server scaffold (roles, categories, channels) without changing anything.',
      },
      {
        usage: '/server bootstrap apply [delete_obsolete:true]',
        description:
          'Creates or repairs the base server scaffold for real -- useful if the bot is set up on a fresh server ' +
          "or something was deleted, and you don't have local/repo access to run the setup script yourself.",
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
