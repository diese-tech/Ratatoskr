export const SCOUT_ROLES = ['solo', 'jungle', 'mid', 'support', 'carry'] as const;
export type ScoutRole = (typeof SCOUT_ROLES)[number];

export const SCOUT_ROLE_LABELS: Record<ScoutRole, string> = {
  solo: 'Solo',
  jungle: 'Jungle',
  mid: 'Mid',
  support: 'Support',
  carry: 'Carry',
};
