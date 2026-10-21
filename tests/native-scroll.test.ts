import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeScrollLedger, parseScrollEvent, subscribePaneScroll, type PaneScroll } from "../src/cli/native-scroll.js";

const at = (max: number, offset = 0, rows = 10): PaneScroll =>
  ({ max_offset_from_bottom: max, offset_from_bottom: offset, viewport_rows: rows });

// 100 lines of earlier output, then 30 committed rows: message 7 at rows
// 5..7, message 9 at rows 20..21, and other rows in between.
function ledger(): NativeScrollLedger {
  const ledger = new NativeScrollLedger();
  ledger.observe(at(100));
  ledger.commit(Array.from({ length: 30 }, (_, index) =>
    index >= 5 && index <= 7 ? 7 : index >= 20 && index <= 21 ? 9 : null));
  ledger.observe(at(130));
  return ledger;
}

describe("native scroll ledger", () => {
  it("marks a message scrolled across from the live bottom", () => {
    const scroll = ledger();
    // Offset 12 shows committed rows 18..27: message 9 only.
    expect(scroll.observe(at(130, 12))).toEqual([9]);
    // Continuing up to offset 25 sweeps rows 5..17 as well.
    expect(scroll.observe(at(130, 25))).toEqual([7, 9]);
  });

  it("ignores the live bottom and an unchanged view", () => {
    const scroll = ledger();
    expect(scroll.observe(at(130, 0))).toEqual([]);
    scroll.observe(at(130, 5));
    expect(scroll.observe(at(130, 5))).toEqual([]);
  });

  it("never counts our live repaint below the scrollback as reading", () => {
    const scroll = ledger();
    // Offset 3 shows committed rows 27..29 and seven live-screen lines.
    expect(scroll.observe(at(130, 3))).toEqual([]);
  });

  it("does not count view changes caused by new commits", () => {
    const scroll = ledger();
    scroll.observe(at(130, 3));
    // Herdr keeps the view anchored: offset grows with the commits.
    scroll.commit([null, null, null]);
    expect(scroll.observe(at(133, 6))).toEqual([]);
    // An unanchored view shifts without the operator moving: still nothing.
    scroll.commit(Array(12).fill(null));
    expect(scroll.observe(at(145, 6))).toEqual([]);
    // Real movement afterwards counts from the new position.
    expect(scroll.observe(at(145, 30))).toEqual([9]);
  });

  it("skips snapshots that predate our latest commits", () => {
    const scroll = ledger();
    scroll.commit([null, null]);
    expect(scroll.observe(at(130, 25))).toEqual([]);
    scroll.observe(at(132));
    expect(scroll.observe(at(132, 14))).toEqual([9]);
  });

  it("drops rows it can no longer place after foreign output", () => {
    const scroll = ledger();
    // Five lines we did not write: the rows above them are unplaceable.
    expect(scroll.observe(at(135, 20))).toEqual([]);
    expect(scroll.observe(at(135, 34))).toEqual([]);
  });

  it("forgets everything on reset", () => {
    const scroll = ledger();
    scroll.reset();
    expect(scroll.observe(at(130, 25))).toEqual([]);
    expect(scroll.observe(at(130, 0))).toEqual([]);
  });
});

describe("pane.scroll_changed parsing", () => {
  const event = (data: unknown) => JSON.stringify({ event: "pane.scroll_changed", data });

  it("reads Herdr's event envelope for our pane", () => {
    expect(parseScrollEvent(event({ pane_id: "w1:p1", workspace_id: "w1", scroll: at(85, 0, 67) }), "w1:p1"))
      .toEqual(at(85, 0, 67));
  });

  it("ignores other panes, acknowledgements and malformed metrics", () => {
    expect(parseScrollEvent(event({ pane_id: "w1:p2", scroll: at(1) }), "w1:p1")).toBeNull();
    expect(parseScrollEvent('{"id":"tt-chat-scroll","result":{"type":"subscription_started"}}', "w1:p1")).toBeNull();
    expect(parseScrollEvent(event({ pane_id: "w1:p1", scroll: { ...at(1), offset_from_bottom: -1 } }), "w1:p1")).toBeNull();
    expect(parseScrollEvent("not json", "w1:p1")).toBeNull();
  });
});

describe("scroll subscription", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("subscribes for one pane and delivers its scroll events", async () => {
    const dir = fs.mkdtempSync("/tmp/tts-");
    dirs.push(dir);
    const socketPath = path.join(dir, "herdr.sock");
    const requests: unknown[] = [];
    const server = net.createServer((connection) => {
      connection.once("data", (chunk) => {
        requests.push(JSON.parse(chunk.toString()));
        connection.write('{"id":"tt-chat-scroll","result":{"type":"subscription_started"}}\n');
        connection.write(`${JSON.stringify({ event: "pane.scroll_changed", data: { pane_id: "w1:p1", scroll: at(4, 2, 20) } })}`);
        connection.write("\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const received = await new Promise<PaneScroll>((resolve) => {
      const subscription = subscribePaneScroll({ socketPath, paneId: "w1:p1", onScroll: (scroll) => {
        subscription.close();
        resolve(scroll);
      } });
    });
    server.close();
    expect(received).toEqual(at(4, 2, 20));
    expect(requests).toEqual([{ id: "tt-chat-scroll", method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.scroll_changed", pane_id: "w1:p1" }] } }]);
  });

  it("reports a missing Herdr socket as closed", async () => {
    await new Promise<void>((resolve) => {
      subscribePaneScroll({ socketPath: "/tmp/tt-no-such-herdr.sock", paneId: "w1:p1", onScroll: () => {}, onClose: resolve });
    });
  });
});
