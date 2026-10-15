import os from "node:os";
import { HUMAN_CHAT_SESSION_KIND, type RoomMember } from "../types.js";

export type ChatInterruptStep =
  | { kind: "unsupported"; agent_id: string }
  | { kind: "codex"; agent_id: string; thread_id: string }
  | { kind: "claude_hook"; agent_id: string; session_id: string };

export type ChatInterruptPlan =
  | { kind: "none" }
  | { kind: "agents"; steps: ChatInterruptStep[] };

export function planChatInterrupts(members: readonly RoomMember[], selfId: string): ChatInterruptPlan {
  const peers = members.filter((member) =>
    member.agent_id !== selfId &&
    member.session_kind !== HUMAN_CHAT_SESSION_KIND &&
    member.process_liveness !== "gone"
  );
  if (peers.length === 0) {
    return { kind: "none" };
  }
  const steps: ChatInterruptStep[] = peers.map((member) => {
    if (member.harness_name === "codex" && member.harness_host_id === os.hostname() &&
        member.harness_session_id?.startsWith("harness:")) {
      return { kind: "codex", agent_id: member.agent_id,
        thread_id: member.harness_session_id.slice("harness:".length) };
    }
    // Parked is not proof of idle: a native wake runs a turn without changing
    // wait intent. An idle session discards the flag or lets it expire.
    if (member.harness_name === "claude" && member.harness_host_id === os.hostname() &&
        member.harness_session_id?.startsWith("harness:")) {
      return { kind: "claude_hook", agent_id: member.agent_id,
        session_id: member.harness_session_id.slice("harness:".length) };
    }
    return { kind: "unsupported", agent_id: member.agent_id };
  });
  if (steps.every((step) => step.kind === "unsupported")) return { kind: "none" };
  return {
    kind: "agents",
    steps
  };
}
