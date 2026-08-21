export type GuildRoleSpec = {
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
};

export type GuildChannelSpec = {
  name: string;
  type: 'text' | 'voice';
  access?: string[];
  topic?: string;
};

export type GuildCategorySpec = {
  name: string;
  access?: string[];
  channels: GuildChannelSpec[];
};

export const yslGuildStructure = {
  roles: [
    { name: 'Allfather', hoist: true },
    { name: 'Æsir', hoist: true },
    { name: 'Valkyries', hoist: true },
    { name: 'Production', hoist: true },
    { name: 'Org Owner', hoist: true },
    { name: 'Captain', hoist: true },
    { name: 'Player', hoist: false },
    { name: 'Free Agent', hoist: false },
    { name: 'Crown', hoist: true },
    { name: 'Canopy', hoist: true },
    { name: 'Ironbranch', hoist: true },
    { name: 'Heartwood', hoist: true },
    { name: 'Deep Root', hoist: true },
  ] satisfies GuildRoleSpec[],

  categories: [
    {
      name: 'Welcome',
      channels: [
        { name: 'welcome', type: 'text', topic: 'Start here for YSL information and onboarding.' },
        { name: 'rules', type: 'text', topic: 'League and server rules.' },
        { name: 'announcements', type: 'text', topic: 'Official YSL announcements.' },
      ],
    },
    {
      name: 'Community',
      channels: [
        { name: 'general', type: 'text' },
        { name: 'smite-chat', type: 'text' },
        { name: 'lfg', type: 'text' },
        { name: 'General', type: 'voice' },
      ],
    },
    {
      name: 'League Players',
      access: ['Player', 'Captain', 'Org Owner', 'Valkyries', 'Æsir', 'Allfather'],
      channels: [
        { name: 'player-lounge', type: 'text' },
        { name: 'free-agency', type: 'text' },
        { name: 'league-resources', type: 'text' },
      ],
    },
    ...['Crown', 'Canopy', 'Ironbranch', 'Heartwood', 'Deep Root'].map((division) => ({
      name: division,
      access: [division, 'Valkyries', 'Æsir', 'Allfather'],
      channels: [
        { name: `${division.toLowerCase().replace(/\s+/g, '-')}-announcements`, type: 'text' as const },
        { name: `${division.toLowerCase().replace(/\s+/g, '-')}-general`, type: 'text' as const },
        { name: 'schedule-results', type: 'text' as const },
        {
          name: 'captains',
          type: 'text' as const,
          access: [division, 'Captain', 'Valkyries', 'Æsir', 'Allfather'],
          topic: 'Captain coordination for this division. Bootstrapper will treat this as a tighter-permission exception.',
        },
        { name: `${division} Lobby`, type: 'voice' as const },
      ],
    })),
    {
      name: 'Org Owners',
      access: ['Org Owner', 'Æsir', 'Allfather'],
      channels: [
        { name: 'org-owner-lounge', type: 'text' },
        { name: 'org-admin-discussion', type: 'text' },
        { name: 'Org Owner Meeting', type: 'voice' },
      ],
    },
    {
      name: 'Production',
      access: ['Production', 'Æsir', 'Allfather'],
      channels: [
        { name: 'production-chat', type: 'text' },
        { name: 'broadcast-planning', type: 'text' },
        { name: 'Production Room', type: 'voice' },
      ],
    },
    {
      name: 'Admin',
      access: ['Valkyries', 'Æsir', 'Allfather'],
      channels: [
        { name: 'meeting-of-the-minds', type: 'text' },
        { name: 'staff-ops', type: 'text' },
        { name: 'audit-log', type: 'text' },
        { name: 'Staff Room', type: 'voice' },
      ],
    },
  ] satisfies GuildCategorySpec[],
};
