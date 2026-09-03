import { assertNoDuplicateKeys } from '../services/divisionScaffold.js';
import { assertNoDuplicateServerLogicalKeys } from '../services/serverBootstrap.js';

export type GuildRoleSpec = {
  // Stable identity, authored once and never derived from `name`. Renaming
  // `name` must never change `key` -- that's what lets a config-side
  // display-name rename resolve to the same Discord resource instead of
  // creating a duplicate. See src/services/serverBootstrap.ts's key
  // builders and the Ratatoskr Hardening Master Plan (#31 Defect 2).
  key: string;
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  utility?: boolean;
};

export type GuildChannelSpec = {
  key: string;
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
  key: string;
  name: string;
  access?: string[];
  channels: GuildChannelSpec[];
};

export type DivisionSpec = {
  // Stable identity, authored once and never derived from `name` -- see #31
  // Defect 1/Defect 2. Renaming `name` must never change `key`, the same
  // contract GuildRoleSpec/GuildCategorySpec/GuildChannelSpec keys hold.
  key: string;
  name: string;
};

// Renamed from the original Crown/Canopy/Ironbranch/Heartwood/Deep Root to
// Norse realm names, matching the rest of the server's Yggdrasil theme, in
// hierarchy order (top tier first). Jotunheim/Muspelheim are templates for
// a possible 4th/5th division -- listed here so they're available as
// /division choices, not because they're provisioned yet; per staff
// discussion, Svartalfheim stays the floor and Niflheim is a reluctant
// last-resort 7th realm, not added here.
export const divisions: readonly DivisionSpec[] = [
  { key: 'vanaheim', name: 'Vanaheim' },
  { key: 'alfheim', name: 'Alfheim' },
  { key: 'jotunheim', name: 'Jotunheim' },
  { key: 'muspelheim', name: 'Muspelheim' },
  { key: 'svartalfheim', name: 'Svartalfheim' },
];
export type DivisionKey = (typeof divisions)[number]['key'];

assertNoDuplicateKeys('division', divisions);

// Hex role colors set only when a division role is first created -- an
// existing/reused role's color is never overwritten, matching how
// ensureRole treats every other role property. Jotunheim/Muspelheim have no
// assigned color yet, so their roles get created with Discord's default
// color until staff pick one. Keyed by the stable division key (not the
// display name) so a config-side rename doesn't silently drop a division's
// assigned color.
export const DIVISION_ROLE_COLORS: Partial<Record<DivisionKey, number>> = {
  vanaheim: 0x11734b,
  alfheim: 0xffe5a0,
  svartalfheim: 0x5a3286,
};

export const yslGuildStructure = {
  roles: [
    { key: 'allfather', name: 'Allfather', hoist: true },
    { key: 'aesir', name: 'Aesir', hoist: true },
    { key: 'valkyries', name: 'Valkyries', hoist: true },
    { key: 'production', name: 'Production', hoist: true },
    { key: 'org_owner', name: 'Org Owner', hoist: true },
    { key: 'franchise_representative', name: 'Franchise Representative', hoist: true },
    { key: 'captain', name: 'Captain', hoist: true },
    { key: 'player', name: 'Player', hoist: false },
    { key: 'free_agent', name: 'Free Agent', hoist: false },
  ] satisfies GuildRoleSpec[],

  categories: [
    {
      key: 'welcome',
      name: 'Welcome',
      channels: [
        { key: 'welcome', name: 'welcome', type: 'text', topic: 'Start here for YSL information and onboarding.', readOnly: true },
        { key: 'rules', name: 'rules', type: 'text', topic: 'League and server rules.', readOnly: true },
        { key: 'announcements', name: 'announcements', type: 'text', topic: 'Official YSL announcements.', readOnly: true },
      ],
    },
    {
      key: 'league_information',
      name: 'League Information',
      channels: [
        {
          key: 'about_ysl',
          name: 'about-ysl',
          type: 'text',
          topic: 'What Yggdrasil Smite League is and how it works.',
          readOnly: true,
        },
        {
          key: 'league_rules',
          name: 'league-rules',
          type: 'text',
          topic: 'Canonical competitive YSL rulebook.',
          readOnly: true,
        },
        { key: 'faq', name: 'faq', type: 'text', topic: 'Frequently asked questions.', readOnly: true },
        {
          key: 'sign_ups',
          name: 'sign-ups',
          type: 'text',
          topic: 'Player, organization, coach, staff, production, and caster sign-up links.',
          readOnly: true,
        },
        { key: 'patch_notes', name: 'patch-notes', type: 'text', topic: 'SMITE 2 patch notes.', readOnly: true },
        { key: 'role_select', name: 'role-select', type: 'text', topic: 'Self-service notification roles.', readOnly: true },
      ],
    },
    {
      key: 'community',
      name: 'Community',
      channels: [
        { key: 'general', name: 'general', type: 'text' },
        { key: 'smite_chat', name: 'smite-chat', type: 'text' },
        { key: 'lfg', name: 'lfg', type: 'text' },
        { key: 'self_promo', name: 'self-promo', type: 'text' },
        { key: 'clips_and_highlights', name: 'clips-and-highlights', type: 'text' },
        { key: 'general_voice', name: 'General', type: 'voice' },
      ],
    },
    {
      key: 'org_owners',
      name: 'Org Owners',
      access: ['Org Owner', 'Aesir', 'Allfather'],
      channels: [
        { key: 'org_owner_lounge', name: 'org-owner-lounge', type: 'text' },
        { key: 'org_admin_discussion', name: 'org-admin-discussion', type: 'text' },
        { key: 'org_owner_meeting', name: 'Org Owner Meeting', type: 'voice' },
      ],
    },
    {
      key: 'production',
      name: 'Production',
      access: ['Production', 'Aesir', 'Allfather'],
      channels: [
        { key: 'production_chat', name: 'production-chat', type: 'text' },
        { key: 'broadcast_planning', name: 'broadcast-planning', type: 'text' },
        { key: 'org_graphics', name: 'org-graphics', type: 'text' },
        { key: 'production_room', name: 'Production Room', type: 'voice' },
      ],
    },
    {
      key: 'admin',
      name: 'Admin',
      access: ['Valkyries', 'Aesir', 'Allfather'],
      channels: [
        { key: 'meeting_of_the_minds', name: 'meeting-of-the-minds', type: 'text' },
        { key: 'staff_ops', name: 'staff-ops', type: 'text' },
        { key: 'audit_log', name: 'audit-log', type: 'text' },
        { key: 'staff_room', name: 'Staff Room', type: 'voice' },
      ],
    },
  ] satisfies GuildCategorySpec[],
};

// Fails fast at process start (not at first reconciliation run) if two
// entries were authored with the same key -- see #31 Defect 2/§8. A
// collision here would otherwise silently corrupt managed-resource
// tracking the same way the old name-derived scheme did before PR #18.
assertNoDuplicateServerLogicalKeys(yslGuildStructure);
