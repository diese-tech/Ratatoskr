export async function runIsolatedStartupRecovery(
  name: string,
  recover: () => Promise<void>,
  reportError: (error: unknown) => Promise<void>,
): Promise<boolean> {
  try {
    await recover();
    return true;
  } catch (error) {
    console.error(`${name} failed:`, error);
    try {
      await reportError(error);
    } catch (reportError) {
      console.error(`${name} failure could not be reported:`, reportError);
    }
    return false;
  }
}
