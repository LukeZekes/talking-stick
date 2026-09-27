import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./config.js";

// A pending operator interrupt for one exact harness session. The installed
// tool hook checks this directory with a shell glob on every tool call, so a
// flag must be a plain file named `<harness>-<session id>`.
export const HOOK_INTERRUPT_HARNESSES = ["claude"] as const;
export type HookInterruptHarness = (typeof HOOK_INTERRUPT_HARNESSES)[number];

// An interrupt targets the turn running when the operator pressed Esc. A flag
// no tool boundary claimed within this window must not stop a later turn.
export const HOOK_INTERRUPT_TTL_MS = 60_000;

export function interruptFlagDir(dataDir = resolveDataDir()): string {
  return path.join(dataDir, "interrupts");
}

function flagPath(harness: HookInterruptHarness, sessionId: string, dataDir?: string): string | null {
  const id = sessionId.replace(/^harness:/, "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id.startsWith(".")) return null;
  return path.join(interruptFlagDir(dataDir), `${harness}-${id}`);
}

export type HookInterruptRequest = "created" | "pending" | "failed";

export function requestHookInterrupt(harness: HookInterruptHarness, sessionId: string, dataDir?: string): HookInterruptRequest {
  const file = flagPath(harness, sessionId, dataDir);
  if (!file) return "failed";
  try {
    if (isFresh(file, Date.now())) return "pending";
  } catch { /* No existing flag. */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return "created";
  } catch { return "failed"; }
}

function isFresh(file: string, now: number): boolean {
  return now - fs.statSync(file).mtimeMs <= HOOK_INTERRUPT_TTL_MS;
}

// A session that exits before another tool boundary cannot consume its flag.
// The shell guard launches this hook while any flag remains, so remove expired
// flags for other sessions as well or they would launch Node on every tool call.
export function pruneExpiredHookInterrupts(dataDir?: string, now = Date.now()): void {
  const dir = interruptFlagDir(dataDir);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^claude-[A-Za-z0-9._-]{1,128}$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        if (!isFresh(file, now)) fs.unlinkSync(file);
      } catch { /* Another hook may have consumed the flag. */ }
    }
  } catch { /* No flag directory yet. */ }
}

export function hasHookInterrupt(harness: HookInterruptHarness, sessionId: string, dataDir?: string, now = Date.now()): boolean {
  const file = flagPath(harness, sessionId, dataDir);
  try {
    return file !== null && isFresh(file, now);
  } catch {
    return false;
  }
}

/** Removes the flag; true only for the caller that removed a fresh one. */
export function consumeHookInterrupt(harness: HookInterruptHarness, sessionId: string, dataDir?: string, now = Date.now()): boolean {
  const file = flagPath(harness, sessionId, dataDir);
  if (!file) return false;
  try {
    const fresh = isFresh(file, now);
    fs.unlinkSync(file);
    return fresh;
  } catch {
    return false;
  }
}
