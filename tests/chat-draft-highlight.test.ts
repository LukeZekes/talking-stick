import { describe, expect, test } from "vitest";
import { draftStyleSpans } from "../src/cli/chat-draft-highlight.js";
import { ChatTranscript, getChatCompletions, layoutComposer, renderChatScreen, renderInlinePanel, textWidth } from "../src/cli/chat-view.js";
import { agentStyle, terminalColorMode, themeStyle, type ChatColorMode } from "../src/cli/theme.js";
import type { RoomMember } from "../src/types.js";

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const options = {
  commands: ["go", "roles", "rooms", "to"],
  mention: (name: string) => name === "codex" || name === "codex:aa"
    ? { state: "resolved" as const, id: "codex:aa" }
    : "codex".startsWith(name) ? { state: "partial" as const } : { state: "unknown" as const }
};

describe("live draft highlighting", () => {
  test("distinguishes a complete command, a prefix, and an unknown command", () => {
    const style = (text: string) => draftStyleSpans(text, options)[0].style;
    expect(new Set([style("/rooms"), style("/roo"), style("/nope")]).size).toBe(3);
    expect(style("/rooms")).toContain(themeStyle("command"));
    expect(style("/nope")).toContain(themeStyle("error"));
    expect(style("/go/")).toContain(themeStyle("error"));
    expect(draftStyleSpans("//rooms", options)).toEqual([]);
  });

  test("recognizes mentions without coloring email or code as recipients", () => {
    const text = "a@codex.dev `@codex` @codex, @co @missing !@codex:aa:";
    const spans = draftStyleSpans(text, options);
    const mention = spans.find(span => text.slice(span.start, span.end) === "@codex")!;
    expect(mention.style).toContain(agentStyle("codex:aa"));
    expect(spans.filter(span => text.slice(span.start, span.end) === "@codex")).toHaveLength(1);
    expect(spans.some(span => span.start > 0 && span.start < text.indexOf("`"))).toBe(false);
    expect(spans.find(span => text.slice(span.start, span.end) === "@missing")!.style).toContain(themeStyle("error"));
    expect(spans.find(span => text.slice(span.start, span.end) === "!")!.style).toContain(themeStyle("warn"));
    expect(spans.some(span => text.slice(span.start, span.end) === "!@codex:aa")).toBe(true);
  });

  test.each(["256", "truecolor"] as const)("painting never changes text, wrapping or cursor geometry (%s)", mode => {
    const line = "/rooms\n@codex 👩🏽‍💻界é !@codex:aa `@missing` #42 [Image #1]";
    for (const width of [5, 9, 20, 80]) for (const cursor of [0, 5, 12, 24, line.length]) {
      const plain = layoutComposer({ line, cursor }, width, 3);
      const painted = layoutComposer({ line, cursor }, width, 3, { ...options, color_mode: mode });
      expect(painted.rows.map(strip)).toEqual(plain.rows);
      expect(painted.cursor_row).toBe(plain.cursor_row);
      expect(painted.cursor_col).toBe(plain.cursor_col);
      expect(painted.rows.every(row => textWidth(row) <= width)).toBe(true);
      expect(painted.rows.every(row => {
        const sgr = [...row.matchAll(/\u001b\[[0-9;]*m/g)];
        return !sgr.length || sgr.at(-1)![0] === "\u001b[0m";
      })).toBe(true);
    }
  });
});

describe("house theme in both chat layouts", () => {
  const member = { agent_id: "codex:aa", display_name: "codex", process_liveness: "alive", status: "active",
    last_seen_at: new Date().toISOString(), session_kind: "harness_cli" } as RoomMember;
  const base = { room_path: "/workspace", transcript: new ChatTranscript(),
    format: { self_agent_id: "human:op", name_of: () => "codex", color: true, show_turn_events: false },
    status: { members: [member], owner: null, owner_since: null, reserved_for: null, now: new Date() },
    draft: { line: "@co", cursor: 3 }, hint: null, columns: 60, rows: 18 };

  test.each([renderInlinePanel, renderChatScreen])("selected completions retain token color, prefix emphasis and a bounded background", render => {
    const input = { ...base, completions: getChatCompletions(base.draft, ["codex"]) };
    const frame = render(input);
    const selected = frame.lines.find(line => strip(line).startsWith("› @codex"))!;
    expect(selected).toContain(themeStyle("selection", "256", true));
    expect(selected).toContain(`1;${agentStyle("codex:aa")}`);
    expect(textWidth(selected)).toBe(59);
    expect(selected).toMatch(/\u001b\[0m$/);
    const plain = render({ ...input, format: { ...input.format, color: false } });
    expect(plain.lines.every(line => !line.includes("\u001b"))).toBe(true);
    expect(plain.cursor).toEqual(frame.cursor);
    // Accepting completion produces an exact, fully styled recipient.
    const filled = render({ ...input, draft: input.completions[0].draft, completions: [] });
    expect(filled.lines.some(line => line.includes(`1;${agentStyle("codex:aa")}m@codex`))).toBe(true);
  });

  test("true color and 256 color share semantic tokens and stable agent identity", () => {
    expect(terminalColorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(terminalColorMode({ COLORTERM: "24bit" })).toBe("truecolor");
    expect(terminalColorMode({ TERM: "xterm-256color" })).toBe("256");
    for (const mode of ["256", "truecolor"] as ChatColorMode[]) {
      expect(agentStyle("codex:aa", mode)).toBe(agentStyle("codex:bb", mode));
      const frame = renderChatScreen({ ...base, format: { ...base.format, color_mode: mode },
        draft: { line: "/roles", cursor: 6 }, completions: [] });
      expect(frame.lines.join("\n")).toContain(themeStyle("command", mode));
      expect(frame.lines.join("\n")).toContain(mode === "truecolor" ? "38;2;" : "38;5;");
    }
  });
});
