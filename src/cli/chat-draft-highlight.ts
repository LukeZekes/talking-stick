import { agentStyle, themeStyle, type ChatColorMode } from "./theme.js";

export interface DraftStyleSpan { start: number; end: number; style: string }
export interface DraftHighlightOptions {
  commands: readonly string[];
  mention: (selector: string) => { state: "resolved" | "group" | "partial" | "unknown"; id?: string };
  color_mode?: ChatColorMode;
}

// Offsets stay in the original UTF-16 draft. Geometry and editing never see
// ANSI; only the final display receives these styles.
export function draftStyleSpans(text: string, options: DraftHighlightOptions): DraftStyleSpan[] {
  const mode = options.color_mode;
  const spans: DraftStyleSpan[] = [];
  const command = /^(\s*)(\/(?!\/)\S*)/i.exec(text);
  if (command) {
    const name = command[2].slice(1).toLowerCase();
    const known = options.commands.includes(name);
    const partial = options.commands.some(candidate => candidate.startsWith(name));
    spans.push({ start: command[1].length, end: command[1].length + command[2].length,
      style: known ? `1;${themeStyle("command", mode)}` : partial ? themeStyle("muted", mode) : `4;${themeStyle("error", mode)}` });
  }
  // Match the send parser's closed backtick spans exactly. An unmatched
  // backtick, or a URL path, must not conceal a real recipient selector.
  const token = /(?<code>`[^`]*`)|(?<attachment>\[Image #\d+\])|(?<mention>(?<![\p{L}\p{N}_@.!])!?@[\p{L}\p{N}_:.-]*)|(?<ref>(?<![\p{L}\p{N}_])#\d+\b)/gu;
  for (const match of text.matchAll(token)) {
    let value = match[0];
    let style: string;
    if (match.groups?.mention) {
      const selector = value.replace(/^!?@/, "").replace(/[.:-]+$/, "");
      value = value.slice(0, value.length - (value.replace(/^!?@/, "").length - selector.length));
      const resolution = options.mention(selector.toLowerCase());
      style = resolution.state === "resolved" || resolution.state === "group"
        ? `1;${resolution.id ? agentStyle(resolution.id, mode) : themeStyle("mention", mode)}`
        : resolution.state === "partial" ? themeStyle("muted", mode) : `4;${themeStyle("error", mode)}`;
      if (value.startsWith("!")) spans.push({ start: match.index, end: match.index + 1, style: `1;${themeStyle("warn", mode)}` });
    } else if (match.groups?.code) style = themeStyle("code", mode);
    else style = themeStyle(match.groups?.attachment ? "path" : "ref", mode);
    // More specific interrupt-marker styling precedes the mention span.
    spans.push({ start: match.index, end: match.index + value.length, style });
  }
  return spans;
}
