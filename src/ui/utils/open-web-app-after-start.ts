/**
 * Minimal shape of the `bridgeStart` IPC result needed to decide whether the
 * web app should be opened after a start attempt.
 */
export type BridgeStartResultLikeT = { success: boolean; webAppUrl?: string };

/**
 * Opens the web app exactly when the bridge start succeeded and reported a URL.
 *
 * The decision is tied to the start result (not to a later `bridgeStatus`
 * event) because main pushes the initial status before the `bridgeStart`
 * IPC call resolves; a status-driven effect armed after the await would miss
 * it. Errors from `openExternal` are logged and swallowed.
 *
 * @param result Result of the `bridgeStart` IPC call.
 * @param openExternal Opener for external URLs (e.g. `window.electron.openExternal`).
 * @returns `true` when the web app was opened, otherwise `false`.
 */
export async function openWebAppAfterStart(
  result: BridgeStartResultLikeT,
  openExternal: (url: string) => Promise<unknown>,
): Promise<boolean> {
  if (!result.success || !result.webAppUrl) {
    return false;
  }
  try {
    await openExternal(result.webAppUrl);
    return true;
  } catch (error) {
    console.error("Failed to open web app URL after start:", error);
    return false;
  }
}
