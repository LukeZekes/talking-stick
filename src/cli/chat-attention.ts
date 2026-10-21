import type { RoomEvent } from "../types.js";
import { sanitizeChatText, type ChatFormatContext } from "./chat-format.js";
import { agentStyle, paintStyle, themeStyle } from "./theme.js";
import { truncateStyled, textWidth } from "./chat-view.js";

export interface HumanAttention { messages: RoomEvent[]; total: number; acknowledged?: number[] }
export interface AttentionHit { event_seq: number; row: number }

/** A bounded summary; the complete message stays in the normal transcript. */
export function renderAttention(attention: HumanAttention | undefined, width: number, rows: number,
  context: ChatFormatContext, clickable = false): { lines: string[]; hits: AttentionHit[] } {
  const maximum = Math.max(1, Math.floor(rows / 3));
  if (!attention?.total || rows < 4) return { lines: [], hits: [] };
  const background = `\u001b[${themeStyle("attention", context.color_mode, true)}m`;
  const line = (text: string) => {
    const clipped = truncateStyled(text, width);
    return context.color ? background + clipped.replace(/\u001b\[0m/g, `\u001b[0m${background}`) +
      " ".repeat(Math.max(0, width - textWidth(clipped))) + "\u001b[0m" : clipped;
  };
  const paint = (style: string, text: string) => paintStyle(context.color, style, text);
  const capacity = Math.max(1, Math.floor((maximum - 2) / 2));
  const more = Math.max(0, attention.total - Math.min(capacity, attention.messages.length));
  const action = clickable ? "click to dismiss" : "/ack #seq|all";
  const lines = [line(paint(`1;${themeStyle("accent", context.color_mode)}`,
    `For you · ${attention.total} awaiting acknowledgement${more ? ` · +${more} more` : ""} · ${action}`))];
  const hits: AttentionHit[] = [];
  if (maximum < 3) return {
    lines: [line(`For you · ${attention.total} · ${clickable ? "click to dismiss" : "/ack"}`)],
    hits: attention.messages[0] ? [{ event_seq: attention.messages[0].event_seq, row: 0 }] : []
  };
  for (const event of attention.messages.slice(0, capacity)) {
    const row = lines.length;
    const from = event.from_agent_id ?? "?";
    lines.push(line(`${paint(agentStyle(from, context.color_mode), context.name_of(from))} → you · #${event.event_seq}`));
    hits.push({ event_seq: event.event_seq, row });
    if (lines.length < maximum - 1) {
      lines.push(line(`  ${sanitizeChatText(event.payload?.body ?? "").replace(/\s+/g, " ")}`));
      hits.push({ event_seq: event.event_seq, row: row + 1 });
    }
  }
  lines.push("");
  return { lines, hits };
}
