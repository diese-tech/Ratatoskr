export type ScoutManagementAccessInput = {
  isAdmin: boolean;
  memberRoleIds: ReadonlySet<string>;
  additionalAuthorizedRoleIds: readonly string[];
  divisionCaptainAccessRoleId: string | null;
};

export function hasScoutManagementAccess(input: ScoutManagementAccessInput): boolean {
  if (input.isAdmin) return true;
  if (input.additionalAuthorizedRoleIds.some((roleId) => input.memberRoleIds.has(roleId))) return true;
  return Boolean(
    input.divisionCaptainAccessRoleId && input.memberRoleIds.has(input.divisionCaptainAccessRoleId),
  );
}
