import { openSqlite, type SqliteDatabase } from "../sqlite.js";
import { resolveDatabasePath } from "../db.js";
import { TalkingStickService } from "../service.js";
import { findHarnessRootInAncestry } from "../identity.js";
import { createSystemProcessInspector, type ProcessInspector } from "../process-utils.js";

export async function runCodexInboxHookCommand(options: {
  stdin?: string; service?: TalkingStickService; inspector?: ProcessInspector;
  parentPid?: number; stdout?: (text: string) => void;
} = {}): Promise<void> {
  let db: SqliteDatabase | undefined;
  let service: TalkingStickService | undefined;
  let identity: { sessionId: string; pid: number; processStartedAt: string; turnId: string } | undefined;
  try {
    let raw = options.stdin;
    if (raw === undefined) {
      raw = "";
      for await (const chunk of process.stdin) raw += chunk.toString();
    }
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        input.subagent_type || input.subagentType || input.agent_id || input.agentId) return;
    const event = input.hook_event_name;
    if (event !== "UserPromptSubmit" && event !== "Stop" && event !== "Interrupt") return;
    if (typeof input.session_id !== "string" || !input.session_id.trim() ||
        typeof input.turn_id !== "string" || !input.turn_id.trim()) return;
    const inspector = options.inspector ?? createSystemProcessInspector();
    const parent = options.parentPid ?? process.ppid;
    const root = findHarnessRootInAncestry("codex", parent, inspector.inspect(parent), inspector, 20);
    if (!root?.startTime) return;
    identity = { sessionId: input.session_id.trim(), turnId: input.turn_id.trim(),
      pid: root.pid, processStartedAt: root.startTime };
    if (!options.service) {
      // No enrollment, DB creation, or migrations from a harness hook.
      db = openSqlite(resolveDatabasePath(), { fileMustExist: true, timeout: 1_000 });
      db.pragma("foreign_keys = ON");
    }
    service = options.service ?? new TalkingStickService({ db });
    const text = service.handleCodexTurnHook({ ...identity, event });
    if (text) (options.stdout ?? (value => process.stdout.write(value)))(JSON.stringify({ decision: "block", reason: text }) + "\n");
  } catch {
    // If stdout failed after reserving a continuation, restore native fallback.
    if (identity && service) {
      try { service.handleCodexTurnHook({ ...identity, event: "Interrupt" }); } catch { /* fail open */ }
    }
  } finally {
    try { db?.close(); } catch { /* fail open */ }
  }
}
