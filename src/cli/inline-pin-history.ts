import { skipStyledText, type TranscriptRow } from "./chat-view.js";

type Position = Pick<TranscriptRow, "block_id" | "line" | "end">;
const compare = (a: Position, b: Position) => a.block_id - b.block_id || a.line - b.line || a.end - b.end;

/** The normal-screen rows already committed to native scrollback. Source
 * offsets survive width changes; a repaint never commits a row twice.
 */
export class InlinePinHistory {
  private frontier?: Position;

  reset(): void { this.frontier = undefined; }

  observe(rows: TranscriptRow[], top: number): void {
    const last = rows[top - 1];
    if (last && (!this.frontier || compare(last, this.frontier) > 0)) {
      this.frontier = { block_id: last.block_id, line: last.line, end: last.end };
    }
  }

  visible(row: TranscriptRow): string {
    if (this.frontier && compare(row, this.frontier) <= 0) return "";
    const overlap = this.frontier && row.block_id === this.frontier.block_id && row.line === this.frontier.line
      ? Math.max(0, this.frontier.end - row.start) : 0;
    return overlap ? skipStyledText(row.text, overlap + Math.max(0, row.indent)) : row.text;
  }

  evicted(rows: TranscriptRow[], top: number): string[] {
    return this.evict(rows, top).map(entry => entry.text);
  }

  /** Like evicted, keeping each committed line's source row. */
  evict(rows: TranscriptRow[], top: number): { text: string; row: TranscriptRow }[] {
    const output: { text: string; row: TranscriptRow }[] = [];
    for (const row of rows.slice(0, top)) {
      if (this.frontier && compare(row, this.frontier) <= 0) continue;
      output.push({ text: this.visible(row), row });
    }
    this.observe(rows, top);
    return output;
  }
}

/** A bottom-row LF preserves history in xterm and Ghostty; CSI S does not
 * consistently do so. Only transcript text is committed, never pin chrome.
 */
export function appendNativeHistory(lines: string[], rows: number): string {
  if (!lines.length) return "";
  return "\u001b[r" + lines.map(line => `\u001b[H\u001b[2K${line}\u001b[${rows};1H\n`).join("");
}
