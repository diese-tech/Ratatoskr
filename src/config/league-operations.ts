import { z } from 'zod';

const LeagueOperationsEnvironmentSchema = z.object({
  ROLE_FREE_AGENT_ID: z.string().min(1),
  YSL_TRANSACTIONS_CHANNEL_ID: z.string().min(1),
});

export function loadLeagueOperationsConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = LeagueOperationsEnvironmentSchema.parse(environment);
  return {
    freeAgentRoleId: parsed.ROLE_FREE_AGENT_ID,
    transactionsChannelId: parsed.YSL_TRANSACTIONS_CHANNEL_ID,
  };
}
