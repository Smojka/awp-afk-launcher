/**
 * Electron's default `uncaughtException` handler shows a modal
 * "A JavaScript error occurred in the main process" dialog and leaves the launcher dead.
 * That is the wrong trade for an AFK tool: the exceptions that reach here are almost always
 * late socket failures from a Minecraft connection we already gave up on (`connect ETIMEDOUT`,
 * `read ECONNRESET`, `write EPIPE`), and every bot session that is still online should survive
 * them. Installing our own listener replaces the dialog with a log line.
 */
export function installCrashGuard(scope: string): void {
  process.on('uncaughtException', (error) => {
    console.error(`[${scope}] uncaught exception (kept running):`, error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[${scope}] unhandled rejection (kept running):`, reason);
  });
}
