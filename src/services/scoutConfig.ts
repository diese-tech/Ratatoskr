export function isValidScoutTimezone(timezone: string): boolean {
  if (!timezone) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function listScoutTimezones(): readonly string[] {
  return Intl.supportedValuesOf('timeZone');
}
