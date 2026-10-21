import type { RoomEvent } from "../types.js";
import { formatChatEvent, type ChatFormatContext } from "./chat-format.js";
import { themeStyle } from "./theme.js";
import { truncateStyled, textWidth, wrapStyledLine } from "./chat-view.js";

export interface HumanAttention { messages: RoomEvent[]; total: number; acknowledged?: number[] }
export interface AttentionHit { event_seq: number; row: number }

/** Pin the ordinary message rendering, without status chrome or rewritten text. */
export function renderAttention(attention: HumanAttention | undefined, width: number, rows: number,
  context: ChatFormatContext): { lines: string[]; hits: AttentionHit[] } {
  if (!attention?.messages.length || rows < 4) return { lines: [], hits: [] };
  const maximum = Math.max(1, Math.floor(rows / 3));
  const budget = maximum > 1 ? maximum - 1 : maximum;
  const background = `\u001b[${themeStyle("attention", context.color_mode, true)}m`;
  const line = (text: string) => {
    const clipped = truncateStyled(text, width);
    return context.color ? background + clipped.replace(/\u001b\[0m/g, `\u001b[0m${background}`) +
      " ".repeat(Math.max(0, width - textWidth(clipped))) + "\u001b[0m" : clipped;
  };
  const lines: string[] = [];
  const hits: AttentionHit[] = [];
  for (const event of attention.messages) {
    if (lines.length >= budget) break;
    const rendered = formatChatEvent(event, { ...context, dim_history: false });
    if (!rendered) continue;
    const message = rendered.split("\n").flatMap(text => wrapStyledLine(text, width));
    // Keep normal spacing between messages, but never leave a header stranded.
    if (lines.length && budget - lines.length < 3) break;
    if (lines.length) lines.push("");
    for (const text of message.slice(0, budget - lines.length)) {
      hits.push({ event_seq: event.event_seq, row: lines.length });
      lines.push(line(text));
    }
  }
  if (maximum > 1 && lines.length) lines.push("");
  return { lines, hits };
}
