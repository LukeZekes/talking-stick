import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  attachFile,
  attachmentInstruction,
  attachmentsDir,
  describeAttachment,
  sniffImageMime,
  storeAttachment,
  validateAttachments
} from "../src/attachments.js";
import { readClipboardImage, readClipboardText, type ClipboardRunner } from "../src/clipboard.js";
import { formatChatEvent } from "../src/cli/chat-format.js";
import { getStringOptions, parseCommand } from "../src/cli/parser.js";
import { formatNativeEventText, TalkingStickService } from "../src/index.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")]);
const roots: string[] = [];
const services: TalkingStickService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-attachments-"));
  roots.push(root);
  return root;
}

describe("attachment store", () => {
  test("recognises the accepted image types by their bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("<svg/>"))).toBeNull();
  });

  test("stores one copy per content hash under the data directory", () => {
    const dataDir = tempRoot();
    const first = storeAttachment(PNG, { dataDir });
    const second = storeAttachment(PNG, { dataDir, name: "again.png" });
    expect(first.path).toBe(path.join(attachmentsDir(dataDir), `${first.sha256}.png`));
    expect(second.path).toBe(first.path);
    expect(second.name).toBe("again.png");
    expect(fs.readdirSync(attachmentsDir(dataDir))).toEqual([`${first.sha256}.png`]);
    expect(fs.readFileSync(first.path)).toEqual(PNG);
    expect(describeAttachment(first, 0)).toBe(`[Image #1: ${first.path} (image/png, 21 B)]`);
  });

  test("copies a file so the original can go away, and refuses non-images", () => {
    const dataDir = tempRoot();
    const original = path.join(tempRoot(), "shot.png");
    fs.writeFileSync(original, PNG);
    const stored = attachFile(original, { dataDir });
    fs.rmSync(original);
    expect(fs.existsSync(stored.path)).toBe(true);
    expect(stored.name).toBe("shot.png");

    const text = path.join(dataDir, "notes.txt");
    fs.writeFileSync(text, "hello");
    expect(() => attachFile(text, { dataDir })).toThrow(/PNG, JPEG, GIF, and WebP/);
    expect(() => attachFile(path.join(dataDir, "missing.png"), { dataDir })).toThrow(/No such file/);
  });

  test("a message may only name intact stored objects", () => {
    const dataDir = tempRoot();
    const stored = storeAttachment(PNG, { dataDir });
    const phantom = { ...stored, sha256: "0".repeat(64), path: path.join(attachmentsDir(dataDir), `${"0".repeat(64)}.png`) };
    expect(() => validateAttachments([phantom], dataDir)).toThrow(/missing or does not match/);
    expect(() => validateAttachments([{ ...stored, bytes: stored.bytes + 1 }], dataDir)).toThrow(/missing or does not match/);
    expect(() => validateAttachments([{ ...stored, mime: "constructor" }], dataDir)).toThrow(/PNG, JPEG/);
    expect(() => validateAttachments([{ ...stored, mime: "toString" }], dataDir)).toThrow(/PNG, JPEG/);

    // Altered bytes of the same size.
    const altered = Buffer.from(PNG);
    altered[altered.length - 1] ^= 0xff;
    fs.writeFileSync(stored.path, altered);
    expect(() => validateAttachments([stored], dataDir)).toThrow(/missing or does not match/);

    // A link at the object's name, even to identical bytes outside the store.
    const outside = path.join(tempRoot(), "outside.png");
    fs.writeFileSync(outside, PNG);
    fs.rmSync(stored.path);
    fs.symlinkSync(outside, stored.path);
    expect(() => validateAttachments([stored], dataDir)).toThrow(/missing or does not match/);

    // Storing again repairs the object in place, without touching the link target.
    expect(storeAttachment(PNG, { dataDir }).path).toBe(stored.path);
    expect(fs.lstatSync(stored.path).isSymbolicLink()).toBe(false);
    expect(validateAttachments([stored], dataDir)).toEqual([stored]);
    expect(fs.readFileSync(outside)).toEqual(PNG);
  });

  test("a message may only name stored images", () => {
    const dataDir = tempRoot();
    const stored = storeAttachment(PNG, { dataDir });
    expect(validateAttachments([stored], dataDir)).toEqual([stored]);
    expect(() => validateAttachments([{ ...stored, path: "/etc/passwd" }], dataDir)).toThrow(/stored images/);
    expect(() => validateAttachments([{ ...stored, mime: "text/plain" }], dataDir)).toThrow(/PNG, JPEG/);
    expect(() => validateAttachments(Array(9).fill(stored), dataDir)).toThrow(/At most 8/);
    expect(validateAttachments([{ ...stored, name: "a\u001b[2Jb.png" }], dataDir)[0].name).toBe("a[2Jb.png");
  });
});

describe("clipboard", () => {
  function runner(outputs: Record<string, Buffer | null>): { run: ClipboardRunner; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      run: async (file, args) => {
        const key = `${file} ${args.join(" ")}`;
        calls.push(key);
        return outputs[key] ?? null;
      }
    };
  }

  test("reads clipboard text for a forwarded Cmd+V", async () => {
    expect(await readClipboardText({ platform: "darwin", run: runner({ "pbpaste ": Buffer.from("hello\n") }).run })).toBe("hello\n");
    expect(await readClipboardText({ platform: "darwin", run: runner({ "pbpaste ": Buffer.from("") }).run })).toBeNull();
    expect(await readClipboardText({ platform: "linux", env: { DISPLAY: ":0" },
      run: runner({ "xclip -selection clipboard -o": Buffer.from("x") }).run })).toBe("x");
  });

  test("reads a Wayland image by the best type the clipboard offers", async () => {
    const { run, calls } = runner({
      "wl-paste --list-types": Buffer.from("text/plain\nimage/png\n"),
      "wl-paste --no-newline --type image/png": PNG
    });
    const image = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, run });
    expect(image?.data).toEqual(PNG);
    expect(calls).toHaveLength(2);
  });

  test("falls back to xclip, and returns null for text or missing tools", async () => {
    const x11 = runner({
      "xclip -selection clipboard -t TARGETS -o": Buffer.from("TARGETS\nimage/png\n"),
      "xclip -selection clipboard -t image/png -o": PNG
    });
    expect((await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" }, run: x11.run }))?.data).toEqual(PNG);

    const text = runner({ "wl-paste --list-types": Buffer.from("text/plain\n") });
    expect(await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "w" }, run: text.run })).toBeNull();
    expect(await readClipboardImage({ platform: "linux", env: {}, run: text.run })).toBeNull();
    expect(await readClipboardImage({ platform: "win32", env: {}, run: text.run })).toBeNull();
  });

  test("on macOS writes the clipboard PNG through a temp file it removes", async () => {
    const tmpDir = tempRoot();
    const run: ClipboardRunner = async (file, args) => {
      const target = /POSIX file "([^"]+)"/.exec(args.join(" "))?.[1];
      if (file === "osascript" && target) {
        fs.writeFileSync(target, PNG);
        return Buffer.alloc(0);
      }
      return null;
    };
    expect((await readClipboardImage({ platform: "darwin", run, tmpDir }))?.data).toEqual(PNG);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  test("on macOS accepts a copied image file", async () => {
    const tmpDir = tempRoot();
    const copied = path.join(tempRoot(), "diagram.png");
    fs.writeFileSync(copied, PNG);
    const run: ClipboardRunner = async (_file, args) =>
      args.join(" ").includes("furl") ? Buffer.from(`${copied}\n`) : null;
    const image = await readClipboardImage({ platform: "darwin", run, tmpDir });
    expect(image?.name).toBe("diagram.png");
  });
});

describe("messages with images", () => {
  function room() {
    const dataDir = tempRoot();
    const project = path.join(dataDir, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    const service = new TalkingStickService({ dataDir });
    services.push(service);
    const join = service.joinPath({ agent_id: "human:op", context_path: fs.realpathSync(project) });
    service.joinPath({ agent_id: "claude:aa", context_path: fs.realpathSync(project) });
    return { service, dataDir, roomId: join.room_id };
  }

  test("carry stored images in the payload, with or without text", () => {
    const { service, dataDir, roomId } = room();
    const image = storeAttachment(PNG, { dataDir, name: "shot.png" });
    service.sendMessage({ agent_id: "human:op", room_id: roomId, body: "", attachments: [image] });
    service.sendMessage({ agent_id: "human:op", room_id: roomId, body: "see this", attachments: [image] });
    const sent = service.getRoomEvents({ room_id: roomId }).filter((event) => event.event_type === "message_sent");
    expect(sent.map((event) => event.payload?.attachments)).toEqual([[image], [image]]);
    expect(() => service.sendMessage({ agent_id: "human:op", room_id: roomId, body: "" })).toThrow(/must not be empty/);
    expect(() => service.sendMessage({ agent_id: "human:op", room_id: roomId, body: "x",
      attachments: [{ ...image, path: "/tmp/elsewhere.png" }] })).toThrow(/stored images/);

    const text = formatNativeEventText({ token: "t", room_id: roomId, path: "/work", recipient: "claude:aa", events: sent })!;
    expect(text.split("\n").slice(1, 6)).toEqual([
      `#${sent[0].event_seq} human:op → room`,
      `  Image #1 attached at ${image.path} (image/png, 21 B). Read that file to see it.`,
      `#${sent[1].event_seq} human:op → room`,
      "  see this",
      `  ${attachmentInstruction(image, 0)}`
    ]);
    const chat = formatChatEvent(sent[1], { self_agent_id: "human:op", name_of: (id) => id, color: false, show_turn_events: false })!;
    expect(chat.split("\n").slice(1)).toEqual(["  see this", `  ${describeAttachment(image, 0)}`]);
  });
});

test("--attach may repeat", () => {
  const parsed = parseCommand(["msg", "send", "room", "hi", "--attach", "a.png", "--attach", "b c.png"]);
  expect(getStringOptions(parsed, "attach")).toEqual(["a.png", "b c.png"]);
  expect(parsed.positionals).toEqual(["send", "room", "hi"]);
});
