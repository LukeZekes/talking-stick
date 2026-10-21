import { expect, test } from "vitest";
import { Terminal } from "@xterm/headless";
import { InlinePinHistory, appendNativeHistory } from "../src/cli/inline-pin-history.js";
import { wrapStyledRows, truncateStyled, wrapStyledLine, type TranscriptRow } from "../src/cli/chat-view.js";

test("OSC8 survives wrapping/truncation without adding cells or leaking to the next row", () => {
  const open = "\u001b]8;;https://talking-stick.invalid/ack/nonce/4\u001b\\";
  const close = "\u001b]8;;\u001b\\";
  expect(wrapStyledLine(open + "one two three" + close, 8)).toEqual([open + "one two" + close, open + "three" + close]);
  expect(truncateStyled(open + "界hello" + close, 4)).toBe(open + "界he" + close);
});

test("history source offsets keep only new text when an evicted line reflows", () => {
  const history = new InlinePinHistory();
  const source = "abcdefghijklmno";
  const rows = (width: number): TranscriptRow[] => wrapStyledRows(source, width).map(row => ({ ...row, block_id: 1, line: 0 }));
  expect(history.evicted(rows(5), 1)).toEqual(["abcde"]);
  expect(history.evicted(rows(8), 1)).toEqual(["fgh"]);
  expect(history.evicted(rows(3), 2)).toEqual([]);
  expect(history.evicted(rows(3), 4)).toEqual(["i", "jkl"]);
});

test("top pins and draft stay fixed while evicted text remains in native history without mouse capture", async () => {
  const vt = new Terminal({ cols: 60, rows: 14, allowProposedApi: true });
  const write = (text: string) => new Promise<void>(resolve => vt.write(text, resolve));
  const screen = () => Array.from({ length: 14 }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const history = new InlinePinHistory();
  const pin = ["codex → you", "Please review the change.", ""];
  const footer = ["", "> draft stays here", "─".repeat(59), "members: codex, claude"];
  const all: TranscriptRow[] = [];
  const draw = () => "\u001b[H\u001b[J" + [...pin, ...all.slice(-7).map(row => row.text), ...footer].join("\r\n");
  try {
    for (let i = 0; i < 7; i++) all.push({ text: `message-${i}`, block_id: i + 1, line: 0, start: 0, end: 9, indent: 0 });
    await write(draw());
    for (let i = 7; i < 27; i++) {
      all.push({ text: `message-${i}`, block_id: i + 1, line: 0, start: 0, end: 9, indent: 0 });
      await write("\u001b[?2026h" + appendNativeHistory(history.evicted(all, all.length - 7), 14) + draw() + "\u001b[?2026l");
      expect(screen().slice(0, 3)).toEqual(pin);
      expect(screen()[11]).toBe(footer[1]);
    }
    expect(Array.from({ length: vt.buffer.active.baseY }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true)))
      .toEqual(Array.from({ length: 20 }, (_, i) => `message-${i}`));
    expect(vt.modes.mouseTrackingMode).toBe("none");
    expect(vt.buffer.active.type).toBe("normal");
  } finally { vt.dispose(); }
});

test("top-pin layout stays bounded on small terminals with multiline drafts and menus", async () => {
  const { ChatTranscript, renderInlineTopPanel, textWidth } = await import("../src/cli/chat-view.js");
  const event = { event_seq: 1, event_id: "e1", room_id: "room", turn_id: 0, event_type: "message_sent" as const,
    from_agent_id: "codex:test", to_agent_id: "human:op", created_at: new Date().toISOString(),
    handoff: null, reason: null, payload: { body: "Pending message with 界 and 👩🏽‍💻", delivery_hint: "normal" as const } };
  const transcript = new ChatTranscript();
  transcript.appendEvent(event);
  for (const rows of [1, 2, 4, 6, 8, 12, 28]) for (const columns of [4, 12, 100]) {
    const frame = renderInlineTopPanel({ rows, columns, transcript, attention: { messages: [event], total: 1 },
      room_path: "/repo", hint: null, panel: Array.from({ length: 20 }, (_, i) => `choice ${i}`),
      format: { self_agent_id: "human:op", name_of: id => id, color: false, show_turn_events: false },
      status: { members: [], owner: null, reserved_for: null, owner_since: null, now: new Date() }, draft: { line: "one\ntwo\nthree\nfour\nfive", cursor: 0 } });
    expect(frame.lines.length).toBeLessThanOrEqual(rows);
    expect(frame.cursor.row).toBeGreaterThanOrEqual(0);
    expect(frame.cursor.row).toBeLessThan(rows);
    expect(frame.lines.every(line => textWidth(line) <= columns - 1)).toBe(true);
  }
});
