import { describe, expect, test } from "vitest";
import { legacyKey } from "../src/cli/terminal-keys.js";

describe("legacyKey", () => {
  test("ignores sequences that are not enhanced key reports", () => {
    expect(legacyKey("\u001b[A")).toBeNull();
    expect(legacyKey("\u001b[5~")).toBeNull();
    expect(legacyKey("x")).toBeNull();
  });

  test("restores the bytes readline and the chat decoder expect", () => {
    expect(legacyKey("\u001b[99;5u")).toBe("\u0003"); // Ctrl+C
    expect(legacyKey("\u001b[100;5u")).toBe("\u0004"); // Ctrl+D
    expect(legacyKey("\u001b[116;5u")).toBe("\u0014"); // Ctrl+T
    expect(legacyKey("\u001b[118;5u")).toBe("\u0016"); // Ctrl+V
    expect(legacyKey("\u001b[27u")).toBe("\u001b"); // Escape
    expect(legacyKey("\u001b[98;3u")).toBe("\u001bb"); // Alt+b
    expect(legacyKey("\u001b[98;4u")).toBe("\u001bB"); // Alt+Shift+b
    expect(legacyKey("\u001b[13;3u")).toBe("\u001b\r"); // Alt+Enter
    expect(legacyKey("\u001b[9;2u")).toBe("\u001b[Z"); // Shift+Tab
    expect(legacyKey("\u001b[127;3u")).toBe("\u001b\u007f"); // Alt+Backspace
    expect(legacyKey("\u001b[119;7u")).toBe("\u001b\u0017"); // Ctrl+Alt+w
    expect(legacyKey("\u001b[32;5u")).toBe("\u0000"); // Ctrl+Space
  });

  test("ignores lock modifiers and drops Super combinations", () => {
    expect(legacyKey("\u001b[99;69u")).toBe("\u0003"); // Ctrl+C with Caps Lock
    expect(legacyKey("\u001b[99;133u")).toBe("\u0003"); // Ctrl+C with Num Lock
    expect(legacyKey("\u001b[99;9u")).toBe(""); // Super+c
  });

  test("decodes xterm modifyOtherKeys reports", () => {
    expect(legacyKey("\u001b[27;5;99~")).toBe("\u0003");
    expect(legacyKey("\u001b[27;3;13~")).toBe("\u001b\r");
  });
});
