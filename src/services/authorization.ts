import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from 'discord.js';
import { z } from 'zod';

// Validated separately from src/config/env.ts (rather than added to its
// shared schema) so that only code paths which actually depend on the
// authorization layer -- the running bot -- require these to be set.
// scripts/bootstrap-guild.ts imports config/env.ts to create the Allfather
// and Æsir roles by name on a fresh server, before their IDs can possibly
// exist yet; it never imports this module, so that flow stays unblocked.
const AuthorizationEnvSchema = z.object({
  ROLE_ALLFATHER_ID: z.string().min(1),
  ROLE_AESIR_ID: z.string().min(1),
});

const authorizationEnv = AuthorizationEnvSchema.parse(process.env);

// Semantic access policies, each backed by one or more Discord role IDs from
// environment configuration. Role IDs are deployment-specific identifiers;
// policy names are the stable, code-level security boundary. Add new keys
// here (STAFF, ORG_OWNER, CAPTAIN, PLAYER, ...) once their backing roles
// exist -- do not pre-declare policies for roles that aren't configured yet.
export type AccessPolicy = 'ADMIN';

const POLICY_ROLE_IDS: Record<AccessPolicy, readonly string[]> = {
  ADMIN: [authorizationEnv.ROLE_ALLFATHER_ID, authorizationEnv.ROLE_AESIR_ID],
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
