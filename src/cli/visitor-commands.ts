import { HUMAN_CHAT_SESSION_KIND } from "../types.js";
import type { AgentId, PathRoom, RequestRepliesResult } from "../types.js";
import { readAllStdin } from "./handoff.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, hasOption, parseOptionalInteger, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";

// Visitors: anyone on this host can ask a room's agents a question without
// joining it, and read the answers later. Asking never creates a membership.

const MAX_WAIT_SECONDS = 60;
const POLL_MS = 250;

async function messageBody(parsed: ParsedCommand, positional: string[]): Promise<string> {
  const body = positional.length > 0 ? positional.join(" ") : hasOption(parsed, "stdin") ? await readAllStdin() : "";
  if (body.trim().length === 0) {
    throw new Error("Message body is required (pass as a positional or use --stdin to read from stdin).");
  }
  return body;
}

// `room`, or comma-separated members: an exact id, a display name, or a
// harness name such as `codex` that matches exactly one agent. Read without an
// agent id so resolving never refreshes the visitor's presence anywhere.
function resolveAskTargets(runtime: Runtime, room: PathRoom, raw: string): "room" | AgentId[] {
  if (raw === "room") return "room";
  const agents = runtime.commands.getRoomState({ room_id: room.room_id }).members
    .filter((member) => member.session_kind !== HUMAN_CHAT_SESSION_KIND);
  return raw.split(",").map((selector) => selector.trim()).filter(Boolean).map((selector) => {
    const exact = agents.find((member) => member.agent_id === selector);
    if (exact) return exact.agent_id;
    const matches = agents.filter((member) => member.display_name === selector || member.agent_id.startsWith(`${selector}:`));
    if (matches.length === 1) return matches[0].agent_id;
    if (matches.length > 1) {
      throw new Error(`${selector} matches several agents in ${room.canonical_path}: ${matches.map((member) => member.agent_id).join(", ")}.`);
    }
    throw new Error(`No agent named ${selector} is in ${room.canonical_path}. Run \`tt room brief ${room.room_id}\` to see members.`);
  });
}

export async function askRoom(runtime: Runtime, parsed: ParsedCommand, room: PathRoom, rest: string[]): Promise<void> {
  const to = getStringOption(parsed, "to");
  if (!to) throw new Error("Usage: tt room ask <room> --to <agent[,agent]|room> <body...> [--stdin] [--request-key KEY]");
  const body = await messageBody(parsed, rest);
  const identity = deriveCliIdentity(parsed);
  const result = await runtime.commands.askRoom(identity, {
    room_id: room.room_id,
    to: resolveAskTargets(runtime, room, to),
    body,
    ...(getStringOption(parsed, "request-key") ? { request_key: getStringOption(parsed, "request-key") } : {})
  });
  const replies = `tt room replies ${result.request_id} --timeout 30`;
  printResult(parsed, { ...result, replies }, () => [
    `${result.deduplicated ? "Already asked" : "Asked"} ${result.recipients.join(", ")} in ${room.canonical_path} (request ${result.request_id}).`,
    ...(result.deliveries ?? []).map((delivery) => `  ${delivery.agent_id}: ${delivery.status}`),
    `Answers: ${replies}`
  ].join("\n"));
}

export async function readReplies(runtime: Runtime, parsed: ParsedCommand, requestId: string | undefined): Promise<void> {
  if (!requestId) throw new Error("Usage: tt room replies <request-id> [--after SEQ] [--limit N] [--timeout SECONDS]");
  const waitSeconds = parseOptionalInteger(parsed, "timeout") ?? 0;
  if (waitSeconds > MAX_WAIT_SECONDS) throw new Error(`--timeout is at most ${MAX_WAIT_SECONDS} seconds.`);
  const input = { request_id: requestId, after_event_seq: parseOptionalInteger(parsed, "after"),
    limit: parseOptionalInteger(parsed, "limit") };
  // A plain read loop: no receiver registration, no presence, nothing to
  // clean up. A deleted room ends the wait at once with request_not_found.
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result: RequestRepliesResult;
  try {
    const deadline = Date.now() + waitSeconds * 1000;
    result = runtime.commands.getRequestReplies(input);
    while (result.replies.length === 0 && Date.now() < deadline && !stop.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(deadline - Date.now(), 0))));
      result = runtime.commands.getRequestReplies(input);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  // Empty means no answer yet, never that the question is finished.
  const output = { ...result, timed_out: waitSeconds > 0 && result.replies.length === 0 };
  printResult(parsed, output, () => {
    const lines = result.replies.map((reply) =>
      `#${reply.event_seq} ${reply.from_agent_id ?? "unknown"}:\n${(reply.payload?.body ?? "").trimEnd().split("\n").map((line) => `  ${line}`).join("\n")}`);
    if (lines.length === 0) lines.push(`No answers yet to request ${result.request_id}.`);
    if (result.has_more) lines.push(`More: tt room replies ${result.request_id} --after ${result.cursor_event_seq}`);
    else lines.push(`Later answers: tt room replies ${result.request_id} --after ${result.cursor_event_seq} --timeout 30`);
    return lines.join("\n");
  });
}

export async function replyToRequest(runtime: Runtime, parsed: ParsedCommand, requestId: string | undefined, rest: string[]): Promise<void> {
  if (!requestId) throw new Error("Usage: tt msg reply <request-id> <body...> [--stdin]");
  const body = await messageBody(parsed, rest);
  const result = runtime.commands.replyToRequest(deriveCliIdentity(parsed), { request_id: requestId, body });
  printResult(parsed, result, () => `Answered request ${result.request_id} (#${result.event_seq}).`);
}
