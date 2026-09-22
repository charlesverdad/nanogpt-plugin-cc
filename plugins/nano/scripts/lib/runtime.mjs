import { binaryAvailable } from "./process.mjs";

/**
 * Resolve whether the local `kimi` CLI is available for the given workspace.
 *
 * Returns the same shape as `binaryAvailable`: `{ available: boolean, detail: string }`.
 * This is the single source of truth for the companion and the stop-time review gate hook.
 *
 * @param {string} [cwd] Working directory to probe from.
 * @returns {{ available: boolean, detail: string }}
 */
export function getKimiAvailability(cwd) {
  return binaryAvailable("kimi", ["--version"], { cwd });
}
