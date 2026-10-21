import net from "node:net";

export interface PaneScroll {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

/**
 * Maps Herdr's scroll snapshots onto the transcript rows chat committed to
 * native scrollback, so a pending message the operator scrolled past does not
 * pin. Herdr reports S (scrollback lines), k (offset from bottom) and V
 * (viewport rows): the operator sees buffer lines [S - k, S - k + V), and only
 * lines below S are scrollback; the rest is our live repaint, never a read.
 *
 * While pins are shown, chat writes nothing to scrollback except these
 * commits (one LF each; the repaint is ED0 from home), so committed row i sits
 * at line S - (N - i). Anything that breaks that alignment marks nothing:
 * the cost of doubt is a pin, never a hidden message.
 */
export class NativeScrollLedger {
  private rows: (number | null)[] = [];
  // Scrollback lines that are not ours, fixed while the ledger is valid.
  private base: number | null = null;
  private previous: { start: number; end: number; committed: number } | null = null;

  commit(seqs: readonly (number | null)[]): void {
    this.rows.push(...seqs);
  }

  // Our rows may have been rewrapped or followed by output we did not count.
  reset(): void {
    this.rows = [];
    this.base = null;
    this.previous = null;
  }

  /** Returns the message seqs whose rows the operator scrolled across. */
  observe(scroll: PaneScroll): number[] {
    const count = this.rows.length;
    const base = scroll.max_offset_from_bottom - count;
    if (this.base === null || base > this.base) {
      // First snapshot, or lines we did not write: older rows can no longer
      // be placed, so start over from here.
      if (this.base !== null) this.rows = [];
      this.base = scroll.max_offset_from_bottom - this.rows.length;
      this.previous = this.view(scroll);
      return [];
    }
    // A snapshot older than our latest commits (or trimmed scrollback).
    if (base < this.base) return [];
    const view = this.view(scroll);
    const previous = this.previous;
    this.previous = view;
    // Only movement with no new commits in between is the operator's own.
    if (!previous || previous.committed !== view.committed) return [];
    if (previous.start === view.start && previous.end === view.end) return [];
    const start = Math.min(previous.start, view.start);
    const end = Math.max(previous.end, view.end);
    const seqs = new Set<number>();
    for (let index = start; index < end; index++) {
      const seq = this.rows[index];
      if (seq !== null && seq !== undefined) seqs.add(seq);
    }
    return [...seqs];
  }

  // Ledger indices visible at this snapshot; at the live bottom that is the
  // empty range just past the newest commit.
  private view(scroll: PaneScroll): { start: number; end: number; committed: number } {
    const count = this.rows.length;
    const offset = Math.max(0, scroll.offset_from_bottom);
    const start = Math.max(0, count - offset);
    const end = Math.min(count, count - offset + Math.max(0, scroll.viewport_rows));
    return { start: Math.min(start, count), end: Math.max(start, end), committed: count };
  }
}

export interface PaneScrollSubscription {
  close(): void;
}

// One long-lived NDJSON subscription on Herdr's socket, scoped to our pane.
export function subscribePaneScroll(input: {
  socketPath: string;
  paneId: string;
  onScroll(scroll: PaneScroll): void;
  onClose?(): void;
}): PaneScrollSubscription {
  const socket = net.connect(input.socketPath);
  let buffered = "";
  let closed = false;
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({
      id: "tt-chat-scroll",
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.scroll_changed", pane_id: input.paneId }] }
    })}\n`);
  });
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const scroll = parseScrollEvent(line, input.paneId);
      if (scroll) input.onScroll(scroll);
    }
    // A single event is small; anything larger is not one we understand.
    if (buffered.length > 64 * 1024) socket.destroy();
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    input.onClose?.();
  };
  socket.on("error", finish);
  socket.on("close", finish);
  return {
    close: () => {
      closed = true;
      socket.destroy();
    }
  };
}

export function parseScrollEvent(line: string, paneId: string): PaneScroll | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  const record = (value: unknown) =>
    typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  const envelope = record(message);
  const data = record(envelope?.data) ?? record(record(envelope?.result)?.data) ?? envelope;
  if (data?.pane_id !== paneId) return null;
  const scroll = record(data.scroll);
  const numbers = ["offset_from_bottom", "max_offset_from_bottom", "viewport_rows"] as const;
  if (!scroll || !numbers.every((key) => Number.isSafeInteger(scroll[key]) && (scroll[key] as number) >= 0)) {
    return null;
  }
  return {
    offset_from_bottom: scroll.offset_from_bottom as number,
    max_offset_from_bottom: scroll.max_offset_from_bottom as number,
    viewport_rows: scroll.viewport_rows as number
  };
}
