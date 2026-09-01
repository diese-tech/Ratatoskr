export type ScoutSignupPostInput = {
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
  lines.push(`**${input.divisionDisplayName} Scout Games at <t:${input.startAt}:t> <t:${input.startAt}:R>**`);
  lines.push('');
  lines.push('React with the role(s) you want to play.');
  lines.push(`You may select **${roleLimitPhrase(input.roleLimit)}**.`);
  if (input.eligibilityRoleId) lines.push(`Eligibility: <@&${input.eligibilityRoleId}>`);
  if (input.note?.trim()) {
    lines.push('');
    lines.push(input.note.trim());
  }
  return lines.join('\n');
}
