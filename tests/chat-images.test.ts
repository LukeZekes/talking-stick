import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatImages } from "../src/cli/chat-images.js";
import { ChatInputController } from "../src/cli/chat-input.js";
import { completeChatInput } from "../src/cli/chat-view.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-chat-images-"));
  roots.push(root);
  return root;
}

describe("chat images", () => {
  test("markers number per chat and renumber from 1 in the order a message lists them", async () => {
    const dataDir = tempRoot();
    const images = new ChatImages({ dataDir, readClipboard: async () => ({ data: PNG }) });
    expect(await images.fromClipboard()).toBe("[Image #1]");
    const shot = path.join(dataDir, "shot.jpg");
    fs.writeFileSync(shot, JPEG);
    expect(images.fromFile(shot)).toBe("[Image #2]");

    const sent = images.take("compare [Image #2] with [Image #1], again [Image #2], not [Image #9]");
    expect(sent.body).toBe("compare [Image #1] with [Image #2], again [Image #1], not [Image #9]");
    expect(sent.attachments.map((image) => image.mime)).toEqual(["image/jpeg", "image/png"]);
    // A deleted marker drops its image.
    expect(images.take("just [Image #1]").attachments).toHaveLength(1);
    expect(images.take("no images").attachments).toEqual([]);
  });

  test("an empty clipboard gives no marker", async () => {
    const images = new ChatImages({ dataDir: tempRoot(), readClipboard: async () => null });
    expect(await images.fromClipboard()).toBeNull();
  });

  test("a pasted image path in any terminal quoting becomes a marker; other text stays text", () => {
    const dataDir = tempRoot();
    const spaced = path.join(dataDir, "My Shot.png");
    const plain = path.join(dataDir, "plain.png");
    fs.writeFileSync(spaced, PNG);
    fs.writeFileSync(plain, PNG);
    const images = new ChatImages({ dataDir });
    expect(images.fromPastedText(spaced.replace(/ /g, "\\ "))).toBe("[Image #1]");
    expect(images.fromPastedText(`'${spaced}'`)).toBe("[Image #2]");
    expect(images.fromPastedText(`file://${encodeURI(spaced)}\n`)).toBe("[Image #3]");
    expect(images.fromPastedText(`${plain} '${spaced}'`)).toBe("[Image #4] [Image #5]");

    const text = path.join(dataDir, "notes.txt");
    fs.writeFileSync(text, "hello");
    expect(images.fromPastedText(text)).toBeNull();
    expect(images.fromPastedText(`look at ${plain}`)).toBeNull();
    expect(images.fromPastedText("plain.png")).toBeNull();
    expect(images.fromPastedText(`${plain} ${text}`)).toBeNull();
  });
});

describe("composer image keys", () => {
  function setup(transformPaste?: (text: string) => string | null) {
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
    const onImagePaste = vi.fn();
    const editor = new ChatInputController({
      input, columns: 40, onSubmit: vi.fn(), onQuit: vi.fn(), onScroll: vi.fn(), onBottom: vi.fn(),
      onChange: vi.fn(), onClear: vi.fn(), onImagePaste, transformPaste,
      complete: (draft) => completeChatInput(draft, [])
    });
    return { editor, input, onImagePaste };
  }

  test("Ctrl+V and an empty paste ask for the clipboard image without touching the draft", () => {
    const { editor, input, onImagePaste } = setup();
    try {
      input.write("see \u0016");
      expect(onImagePaste).toHaveBeenCalledOnce();
      input.write("\u001b[200~\u001b[201~");
      expect(onImagePaste).toHaveBeenCalledTimes(2);
      expect(editor.draft).toEqual({ line: "see ", cursor: 4 });
      editor.insertText("[Image #1] ");
      input.write("ok");
      expect(editor.draft.line).toBe("see [Image #1] ok");
    } finally {
      editor.close();
    }
  });

  test("a paste may be replaced, and a failing replacement keeps the pasted text", () => {
    const replaced = setup((text) => text === "/tmp/a.png" ? "[Image #1]" : null);
    const failing = setup(() => { throw new Error("unreadable"); });
    try {
      replaced.input.write("\u001b[200~/tmp/a.png\u001b[201~ and \u001b[200~words\u001b[201~");
      expect(replaced.editor.draft.line).toBe("[Image #1] and words");
      failing.input.write("\u001b[200~/tmp/b.png\u001b[201~");
      expect(failing.editor.draft.line).toBe("/tmp/b.png");
    } finally {
      replaced.editor.close();
      failing.editor.close();
    }
  });
});
