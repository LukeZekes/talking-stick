import { osc8 } from "./chat-links.js";
import type { RoomEvent } from "../types.js";
import { formatChatEvent, type ChatFormatContext } from "./chat-format.js";
import { themeStyle } from "./theme.js";
import { truncateStyled, textWidth, wrapStyledLine } from "./chat-view.js";

export interface HumanAttention { messages: RoomEvent[]; total: number; acknowledged?: number[] }
export interface AttentionHit { event_seq: number; row: number }

/** Keep authored messages together on one quiet surface for earlier messages. */
export function renderAttention(attention: HumanAttention | undefined, width: number, rows: number,
  context: ChatFormatContext): { lines: string[]; hits: AttentionHit[] } {
  if (!attention?.messages.length || rows < 4) return { lines: [], hits: [] };
  const maximum = Math.max(1, Math.floor(rows / 3));
  const budget = maximum > 2 ? maximum - 2 : maximum > 1 ? maximum - 1 : maximum;
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
    if (lines.length) lines.push(line(""));
    for (const text of message.slice(0, budget - lines.length)) {
      hits.push({ event_seq: event.event_seq, row: lines.length });
      const url = context.pin_link?.(event.event_seq);
      const content = line(text);
      lines.push(url ? osc8(content, url) : content);
    }
  }
  if (maximum > 2 && lines.length) {
    const earlier = context.color ? `\u001b[${themeStyle("muted", context.color_mode)}mEarlier\u001b[0m` : "Earlier";
    lines.unshift(line(earlier));
    for (const hit of hits) hit.row++;
  }
  if (maximum > 1 && lines.length) lines.push(line(""));
  return { lines, hits };
}

/** Only promote messages whose original is outside the visible transcript.
 * Adding pins can push another original out; grow the set until layout settles.
 */
export function resolveAttentionFrame<T>(attention: HumanAttention | undefined,
  render: (pins: HumanAttention | undefined) => { frame: T; visible: Iterable<number> }): T {
  if (!attention?.messages.length) return render(attention).frame;
  const pinned = new Set<number>();
  for (;;) {
    const result = render({ ...attention, messages: attention.messages.filter(event => pinned.has(event.event_seq)) });
    const visible = new Set(result.visible);
    const missing = attention.messages.filter(event => !visible.has(event.event_seq) && !pinned.has(event.event_seq));
    if (!missing.length) return result.frame;
    for (const event of missing) pinned.add(event.event_seq);
  }
}
