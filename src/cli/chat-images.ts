import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachFile, sniffImageMime, storeAttachment, type MessageAttachment } from "../attachments.js";
import { readClipboardImage, type ClipboardImage } from "../clipboard.js";

// Images in the chat composer. Each pasted, dropped, or /attach-ed image is
// stored at once and stands in the draft as an "[Image #N]" marker, the way
// harness composers show them. Deleting the marker drops the image. Numbers
// are per chat, so a recalled prompt still finds its images; on send the
// markers are renumbered from 1 in the order the message lists them.

const MARKER = /\[Image #(\d+)\]/g;

export class ChatImages {
  private next = 1;
  private readonly images = new Map<number, MessageAttachment>();

  constructor(private readonly options: {
    dataDir: string;
    readClipboard?: () => Promise<ClipboardImage | null>;
  }) {}

  private add(attachment: MessageAttachment): string {
    const number = this.next++;
    this.images.set(number, attachment);
    return `[Image #${number}]`;
  }

  /** A marker for the clipboard's image, or null when it holds none. */
  async fromClipboard(): Promise<string | null> {
    const image = await (this.options.readClipboard ?? readClipboardImage)();
    return image ? this.add(storeAttachment(image.data, { dataDir: this.options.dataDir, name: image.name })) : null;
  }

  /** A marker for an image file; throws with a readable reason otherwise. */
  fromFile(file: string): string {
    return this.add(attachFile(expandHome(file), { dataDir: this.options.dataDir }));
  }

  /**
   * Markers for pasted text that is nothing but image file paths, as a
   * terminal pastes a dragged-in file; null leaves the paste as text.
   */
  fromPastedText(text: string): string | null {
    const files = pastedPaths(text);
    if (files.length === 0 || !files.every(isImageFile)) return null;
    return files.map((file) => this.fromFile(file)).join(" ");
  }

  /** The body to send, with its markers renumbered, and their images in that order. */
  take(body: string): { body: string; attachments: MessageAttachment[] } {
    const order: number[] = [];
    const renumbered = body.replace(MARKER, (marker, digits: string) => {
      const number = Number(digits);
      if (!this.images.has(number)) return marker;
      if (!order.includes(number)) order.push(number);
      return `[Image #${order.indexOf(number) + 1}]`;
    });
    return { body: renumbered, attachments: order.map((number) => this.images.get(number)!) };
  }
}

function expandHome(file: string): string {
  return file === "~" || file.startsWith("~/") ? path.join(os.homedir(), file.slice(1)) : file;
}

// Terminals paste a dropped file as its path: backslash-escaped, quoted, or
// as a file:// URL, several separated by spaces or newlines.
function pastedPaths(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  const trimmed = text.trim();
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "\\" && index + 1 < trimmed.length) current += trimmed[++index];
    else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (quote) return [];
  if (current) tokens.push(current);
  return tokens.map((token) => {
    if (!token.startsWith("file://")) return expandHome(token);
    try { return fileURLToPath(token); } catch { return ""; }
  });
}

function isImageFile(file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      return sniffImageMime(head) !== null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
