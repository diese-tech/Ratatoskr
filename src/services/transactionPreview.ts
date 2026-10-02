export async function persistPreviewAfterDelivery(
  deliver: () => Promise<unknown>,
  persist: () => void,
): Promise<void> {
  await deliver();
  persist();
}
