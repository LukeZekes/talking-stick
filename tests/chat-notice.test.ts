import { expect, test } from "vitest";
import { formatChatNotice } from "../src/cli/chat-notice.js";
import { formatChatEvent } from "../src/cli/chat-format.js";
import { isHumanDirected } from "../src/human-attention.js";
import { themeStyle } from "../src/cli/theme.js";
import type { RoomEvent } from "../src/types.js";

test("command results use a common separated gutter with semantic result colors", () => {
  for (const [text, label, token] of [["! Refused", "error", "error"], ["Removed codex", "done", "ok"], ["Theme choices\nsecond line", "info", "ref"]] as const) {
    const plain = formatChatNotice(text, false);
    const colored = formatChatNotice(text, true);
    expect(plain).toContain(`│ ${label} · `);
    expect(plain.startsWith("\n")).toBe(true);
    expect(plain.endsWith("\n")).toBe(false);
    expect(colored).toContain(themeStyle(token));
    expect(colored.replace(/\u001b\[[0-9;]*m/g, "")).toBe(plain);
  }
});

test("human-directed transcript messages have a reset-safe background; broadcasts and visitor replies do not", () => {
  const context = { self_agent_id: "human:op", name_of: (id: string) => id, color: true, show_turn_events: false };
  const event: RoomEvent = { event_seq: 1, event_id: "e1", room_id: "r", turn_id: 0, event_type: "message_sent", from_agent_id: "codex:aa", to_agent_id: "human:op", created_at: new Date().toISOString(), handoff: null, reason: null, payload: { delivery_hint: "normal", body: "hello #42\nnext line" } };
  const bg = themeStyle("attention", undefined, true);
  const direct = formatChatEvent(event, context)!;
  expect(direct.split("\n").every(line => line.includes(bg) && line.endsWith("\u001b[0m"))).toBe(true);
  expect(formatChatEvent(event, { ...context, human_acknowledged: () => true })).not.toContain(bg);
  expect(formatChatEvent({ ...event, to_agent_id: null }, context)).not.toContain(bg);
  expect(isHumanDirected({ ...event, to_agent_id: null, payload: { delivery_hint: "normal", body: "room", sent_to: ["human:op"] } })).toBe(false);
  expect(isHumanDirected({ ...event, to_agent_id: null, payload: { delivery_hint: "normal", body: "multi", recipients: ["human:op", "codex:bb"] } })).toBe(true);
  expect(isHumanDirected(event, "human:other")).toBe(false);
});

test("short attention panels retain a compact acknowledgement hint and do not promise unavailable clicks", async () => {
  const { renderAttention } = await import("../src/cli/chat-attention.js");
  const context = { self_agent_id: "human:op", name_of: (id: string) => id, color: false, show_turn_events: false };
  for (const rows of [4, 5, 6, 7, 8]) {
    const panel = renderAttention({ messages: [], total: 5 }, 40, rows, context);
    expect(panel.lines.join("\n")).toContain("For you · 5 · /ack");
    expect(panel.lines.join("\n")).not.toContain("click");
  }
  expect(renderAttention({ messages: [], total: 5 }, 100, 28, context).lines[0]).not.toContain("click");
  expect(renderAttention({ messages: [], total: 5 }, 100, 28, context, true).lines[0]).toContain("click");
});
