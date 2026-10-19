import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { queryCursorRow } from "../src/cli/chat.js";

function fakeTty() {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; } });
  const written: string[] = [];
  const output = Object.assign(new PassThrough(), { write: (chunk: string) => { written.push(chunk); return true; } });
  return { input, output, written };
}

describe("queryCursorRow", () => {
  it("reads the row from a DSR report and restores cooked mode", async () => {
    const { input, output, written } = fakeTty();
    const pending = queryCursorRow(input, output as unknown as NodeJS.WritableStream);
    expect(written).toEqual(["\u001b[6n"]);
    input.write("\u001b[17;1R");
    await expect(pending).resolves.toBe(17);
    expect(input.isRaw).toBe(false);
  });

  it("resolves null without a report or without raw mode", async () => {
    const { input, output } = fakeTty();
    await expect(queryCursorRow(input, output as unknown as NodeJS.WritableStream, 10)).resolves.toBeNull();
    await expect(queryCursorRow(new PassThrough(), output as unknown as NodeJS.WritableStream)).resolves.toBeNull();
  });
});
