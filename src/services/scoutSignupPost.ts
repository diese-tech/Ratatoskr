import { scoutGameName } from './scoutGamePresentation.js';
export type ScoutSignupPostInput = {
  workflow?: 'scout' | 'inhouse';
  divisionDisplayName: string;
  startAt: number;
  roleLimit: number;
  note?: string | null;
  divisionRoleId?: string | null;
  eligibilityRoleId?: string | null;
};

function roleLimitPhrase(limit: number): string {
  return limit === 1 ? '1 role' : `${limit} roles`;
}

export function renderScoutSignupPost(input: ScoutSignupPostInput): string {
  const lines: string[] = [];
  if (input.divisionRoleId) lines.push(`<@&${input.divisionRoleId}>`);
  lines.push(`**${scoutGameName(input)} Games at <t:${input.startAt}:t> <t:${input.startAt}:R>**`);
  lines.push('');
  lines.push('React with the role(s) you want to play.');
  lines.push(`You may select **${roleLimitPhrase(input.roleLimit)}**.`);
  if (input.workflow === 'inhouse') lines.push('Anyone can join. Rat tries to balance teams by division; the host can change them.');
  if (input.eligibilityRoleId) lines.push(`Role needed to join: <@&${input.eligibilityRoleId}>`);
  if (input.note?.trim()) {
    lines.push('');
    lines.push(input.note.trim());
  }
  return lines.join('\n');
}
