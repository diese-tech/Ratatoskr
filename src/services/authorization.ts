import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from 'discord.js';
import { env } from '../config/env.js';

// Semantic access policies, each backed by one or more Discord role IDs from
// environment configuration. Role IDs are deployment-specific identifiers;
// policy names are the stable, code-level security boundary. Add new keys
// here (STAFF, ORG_OWNER, CAPTAIN, PLAYER, ...) once their backing roles
// exist -- do not pre-declare policies for roles that aren't configured yet.
export type AccessPolicy = 'ADMIN';

const POLICY_ROLE_IDS: Record<AccessPolicy, readonly string[]> = {
  ADMIN: [env.ROLE_ALLFATHER_ID, env.ROLE_AESIR_ID],
};

export function hasAccess(member: GuildMember, policy: AccessPolicy): boolean {
  return POLICY_ROLE_IDS[policy].some((roleId) => member.roles.cache.has(roleId));
}

// Checks the policy and, on denial, sends the private denial response itself.
// Callers must await this and return before any mutation logic when it
// resolves false.
export async function requireAccess(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
  policy: AccessPolicy,
): Promise<boolean> {
  if (hasAccess(member, policy)) return true;

  await interaction.reply({
    content: 'You do not have permission to use this command.',
    flags: MessageFlags.Ephemeral,
  });
  return false;
}
