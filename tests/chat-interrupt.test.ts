import os from "node:os";
import { expect, test } from "vitest";
import { planChatInterrupts } from "../src/cli/chat-interrupt.js";
import { HUMAN_CHAT_SESSION_KIND, type RoomMember } from "../src/types.js";

function member(overrides: Partial<RoomMember> & Pick<RoomMember, "agent_id">): RoomMember {
  return {
    room_id: "room",
    ordinal: 1,
    joined_at: "t",
    last_seen_at: "t",
    last_wait_at: null,
    wait_intent: null,
    host_id: "local",
    pid: 1,
    process_started_at: "t",
    session_kind: "harness_cli",
    display_name: null,
    harness_name: null,
    harness_session_id: null,
    harness_host_id: null,
    harness_pid: null,
    harness_process_started_at: null,
    last_park_hint_event_seq: null,
    standby_transport: null,
    standby_workspace_id: null,
    standby_surface_id: null,
    standby_generation: 0,
    standby_wake_pending: false,
    standby_registered_at: null,
    standby_last_error: null,
    standby_delivered_at: null,
    wake_workspace_id: null,
    wake_surface_id: null,
    wake_endpoint_session_id: null,
    wake_endpoint_generation: 0,
    wake_endpoint_recorded_at: null,
    wake_interrupt_delivered_at: null,
    status: "active",
    process_liveness: "alive",
    ...overrides
  };
}

test("peers without a local interrupt path produce a single summary", () => {
  const members = [
    member({ agent_id: "human:op", session_kind: HUMAN_CHAT_SESSION_KIND }),
    member({ agent_id: "claude:remote", harness_name: "claude", harness_host_id: "elsewhere",
      harness_session_id: "harness:69165312-5843-4095-abff-1b5dc5221feb" }),
    member({ agent_id: "claude:gone", harness_name: "claude", harness_host_id: os.hostname(),
      harness_session_id: "harness:4dfd8482-811e-42bf-88c4-5dc50f1c1d8b", process_liveness: "gone" }),
    member({ agent_id: "grok:1", harness_name: "grok" })
  ];
  expect(planChatInterrupts(members, "human:op")).toEqual({ kind: "none" });
});

test("local Claude and Codex sessions are interrupted without a terminal surface", () => {
  const members = [
    member({ agent_id: "claude:1", harness_name: "claude", harness_host_id: os.hostname(),
      harness_session_id: "harness:bfe824e3-4700-4923-aba8-cb3710e41177", wait_intent: "parked" }),
    member({ agent_id: "codex:1", harness_name: "codex",
      harness_host_id: os.hostname(),
      harness_session_id: "harness:01a0e1e6-eaba-7db2-aafc-832187d822a0" }),
    member({ agent_id: "grok:1", harness_name: "grok" })
  ];
  expect(planChatInterrupts(members, "human:op")).toEqual({
    kind: "agents",
    steps: [
      { kind: "claude_hook", agent_id: "claude:1", session_id: "bfe824e3-4700-4923-aba8-cb3710e41177" },
      { kind: "codex", agent_id: "codex:1", thread_id: "01a0e1e6-eaba-7db2-aafc-832187d822a0" },
      { kind: "unsupported", agent_id: "grok:1" }
    ]
  });
});
