import { consumeHookInterrupt, hasHookInterrupt, pruneExpiredHookInterrupts, type HookInterruptHarness } from "../interrupt-flags.js";

export interface InterruptHookOptions {
  stdin?: string;
  dataDir?: string;
  stdout?: (text: string) => void;
}

const STOP_REASON = "Interrupted by the operator from tt chat.";

// Claude Code runs this before and after every tool call. A pending flag for
// this exact session stops the turn with `continue: false`: no prompt reaches
// the model, so the interrupt costs no tokens. Before a tool runs, the call is
// also denied so the interrupted tool never starts. A turn boundary discards a
// flag that arrived too late to stop anything. Fail open on every error.
export async function runInterruptHookCommand(harness: string | undefined, options: InterruptHookOptions = {}): Promise<void> {
  try {
    if (harness !== "claude") return;
    let raw = options.stdin;
    if (raw === undefined) {
      raw = "";
      for await (const chunk of process.stdin) raw += chunk;
    }
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
    if (!sessionId) return;
    const write = options.stdout ?? ((text: string) => process.stdout.write(text));
    const target: HookInterruptHarness = harness;
    pruneExpiredHookInterrupts(options.dataDir);
    if (event === "Stop" || event === "UserPromptSubmit") {
      consumeHookInterrupt(target, sessionId, options.dataDir);
      return;
    }
    if (event !== "PreToolUse" && event !== "PostToolUse") return;
    // A subagent shares its parent's session id. Stop the subagent but leave
    // the flag, so the parent's next tool call ends the whole turn.
    const subagent = Boolean(input.agent_id || input.agent_type);
    const pending = subagent
      ? hasHookInterrupt(target, sessionId, options.dataDir)
      : consumeHookInterrupt(target, sessionId, options.dataDir);
    if (!pending) return;
    write(JSON.stringify({
      continue: false,
      stopReason: STOP_REASON,
      ...(event === "PreToolUse" ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: STOP_REASON
        }
      } : {})
    }) + "\n");
  } catch {
    // An interrupt hook must never break a tool call.
  }
}
