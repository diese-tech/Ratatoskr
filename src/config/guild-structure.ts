export type GuildRoleSpec = {
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  utility?: boolean;
};

export type GuildChannelSpec = {
  name: string;
  type: 'text' | 'voice';
  access?: string[];
  topic?: string;
  // Visible to everyone who can already view the channel, but only staff
  // (STAFF_ROLES) may post. See resolveChannelOverwrites in
  // scripts/bootstrap-guild.ts.
  readOnly?: boolean;
};

export type GuildCategorySpec = {
  name: string;
  access?: string[];
  channels: GuildChannelSpec[];
};

export const divisions = ['Crown', 'Canopy', 'Ironbranch', 'Heartwood', 'Deep Root'] as const;
export type DivisionName = (typeof divisions)[number];

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
  ] satisfies GuildRoleSpec[],

  categories: [
    {
      name: 'Welcome',
      channels: [
        { name: 'welcome', type: 'text', topic: 'Start here for YSL information and onboarding.', readOnly: true },
        { name: 'rules', type: 'text', topic: 'League and server rules.', readOnly: true },
        { name: 'announcements', type: 'text', topic: 'Official YSL announcements.', readOnly: true },
      ],
    },
    {
      name: 'League Information',
      channels: [
        { name: 'about-ysl', type: 'text', topic: 'What Yggdrasil Smite League is and how it works.', readOnly: true },
        { name: 'league-rules', type: 'text', topic: 'Canonical competitive YSL rulebook.', readOnly: true },
        { name: 'faq', type: 'text', topic: 'Frequently asked questions.', readOnly: true },
        {
          name: 'sign-ups',
          type: 'text',
          topic: 'Player, organization, coach, staff, production, and caster sign-up links.',
          readOnly: true,
        },
        { name: 'patch-notes', type: 'text', topic: 'SMITE 2 patch notes.', readOnly: true },
        { name: 'role-select', type: 'text', topic: 'Self-service notification roles.', readOnly: true },
      ],
    },
    {
      name: 'Community',
      channels: [
        { name: 'general', type: 'text' },
        { name: 'smite-chat', type: 'text' },
        { name: 'lfg', type: 'text' },
        { name: 'self-promo', type: 'text' },
        { name: 'clips-and-highlights', type: 'text' },
        { name: 'General', type: 'voice' },
      ],
    },
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
        { name: 'org-graphics', type: 'text' },
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
