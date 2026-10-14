export function scoutGameName(setup: { workflow?: 'scout' | 'inhouse'; divisionDisplayName: string }): string {
  return setup.workflow === 'inhouse' ? 'Inhouse' : `${setup.divisionDisplayName} Scout`;
}
