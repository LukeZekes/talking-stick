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

test("pins keep normal authored message content without a status preamble", async () => {
  const { renderAttention } = await import("../src/cli/chat-attention.js");
  const context = { self_agent_id: "human:op", name_of: (id: string) => id === "human:op" ? "you" : "codex", color: false, show_turn_events: false };
  const event: RoomEvent = { event_seq: 42, event_id: "e42", room_id: "r", turn_id: 0, event_type: "message_sent", from_agent_id: "codex:aa", to_agent_id: "human:op", created_at: new Date().toISOString(), handoff: null, reason: null, payload: { delivery_hint: "normal", body: "Keep this message.\nAnd its second line." } };
  const normal = formatChatEvent(event, context)!;
  const panel = renderAttention({ messages: [event], total: 99 }, 100, 28, context);
  expect(panel.lines[0]).toBe(""); // Separate a promoted pin from the transcript above it.
  expect(panel.lines.at(-1)).toBe("");
  expect(panel.lines.slice(1, -1).join("\n")).toBe(normal);
  expect(panel.hits[0]).toEqual({ event_seq: 42, row: 1 });
  expect(panel.lines.join("\n")).not.toMatch(/For you|awaiting|dismiss|acknowledge|#42/);
  expect(panel.hits.every(hit => hit.event_seq === 42)).toBe(true);
  for (const rows of [4, 5, 6, 7, 8]) {
    const short = renderAttention({ messages: [event], total: 1 }, 100, rows, context);
    expect(short.lines[0]).toBe(normal.split("\n")[0]);
    expect(short.hits[0]).toEqual({ event_seq: 42, row: 0 });
  }
});


test("a restored pin keeps its colors rather than adopting historical transcript styling", async () => {
  const { renderAttention } = await import("../src/cli/chat-attention.js");
  const context = { self_agent_id: "human:op", name_of: (id: string) => id, color: true, show_turn_events: false,
    now: new Date("2026-10-21T12:00:00Z"), history_before: "2026-10-21T11:00:00Z" };
  const event: RoomEvent = { event_seq: 42, event_id: "e42", room_id: "r", turn_id: 0, event_type: "message_sent", from_agent_id: "codex:aa", to_agent_id: "human:op", created_at: "2026-10-20T12:00:00Z", handoff: null, reason: null, payload: { delivery_hint: "normal", body: "Still waiting. #42" } };
  const attention = { messages: [event], total: 1 };
  const restored = renderAttention(attention, 100, 28, context);
  const freshView = renderAttention(attention, 100, 28, { ...context, history_before: undefined });
  expect(restored.lines).toEqual(freshView.lines);
  expect(restored.lines.join("\n")).toContain("1;38;5;78");
  expect(formatChatEvent(event, context)).not.toContain("1;38;5;78");
});
