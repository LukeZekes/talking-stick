import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sniffImageMime } from "./attachments.js";

// Reading an image from the OS clipboard. A terminal paste carries only text,
// so harnesses that accept pasted images read the clipboard themselves; tt
// chat does the same on Ctrl+V. Missing tools or an empty clipboard are not
// errors: the result is null and the caller falls back to text.

export interface ClipboardImage {
  data: Buffer;
  /** The file name, when the clipboard held a copied image file. */
  name?: string;
}

export type ClipboardRunner = (file: string, args: readonly string[]) => Promise<Buffer | null>;

export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: ClipboardRunner;
  tmpDir?: string;
}

const TIMEOUT_MS = 5_000;
const MAX_BUFFER = 64 * 1024 * 1024;

const runCommand: ClipboardRunner = (file, args) => new Promise((resolve) => {
  execFile(file, args, { encoding: "buffer", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
    (error, stdout) => resolve(error ? null : stdout));
});

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function image(data: Buffer | null, name?: string): ClipboardImage | null {
  return data && data.length > 0 && sniffImageMime(data) ? { data, ...(name ? { name } : {}) } : null;
}

export async function readClipboardImage(options: ClipboardOptions = {}): Promise<ClipboardImage | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  if (platform === "darwin") return readMacClipboard(run, options.tmpDir ?? os.tmpdir());
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) {
      const types = (await run("wl-paste", ["--list-types"]))?.toString("utf8").split("\n").map((type) => type.trim()) ?? [];
      const type = IMAGE_TYPES.find((candidate) => types.includes(candidate));
      if (type) return image(await run("wl-paste", ["--no-newline", "--type", type]));
    }
    if (env.DISPLAY) {
      const types = (await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]))?.toString("utf8").split("\n").map((type) => type.trim()) ?? [];
      const type = IMAGE_TYPES.find((candidate) => types.includes(candidate));
      if (type) return image(await run("xclip", ["-selection", "clipboard", "-t", type, "-o"]));
    }
  }
  return null;
}

// Clipboard text, for a Cmd+V the terminal forwarded as a key instead of
// pasting itself. Null when there is no text or no clipboard tool.
export async function readClipboardText(options: ClipboardOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  let data: Buffer | null = null;
  if (platform === "darwin") data = await run("pbpaste", []);
  else if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) data = await run("wl-paste", ["--no-newline"]);
    if (!data && env.DISPLAY) data = await run("xclip", ["-selection", "clipboard", "-o"]);
  }
  const text = data?.toString("utf8") ?? "";
  return text.length > 0 ? text : null;
}

// AppleScript writes the clipboard's PNG to a file (binary-safe, unlike its
// hex text form). A copied image file in Finder is a file URL instead.
async function readMacClipboard(run: ClipboardRunner, tmpDir: string): Promise<ClipboardImage | null> {
  const dir = fs.mkdtempSync(path.join(tmpDir, "tt-clipboard-"));
  const file = path.join(dir, "clipboard.png");
  try {
    const wrote = await run("osascript", [
      "-e", "set png to (the clipboard as «class PNGf»)",
      "-e", `set out to open for access POSIX file ${appleScriptString(file)} with write permission`,
      "-e", "write png to out",
      "-e", "close access out"
    ]);
    if (wrote !== null && fs.existsSync(file)) {
      const found = image(fs.readFileSync(file));
      if (found) return found;
    }
    const url = (await run("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]))?.toString("utf8").trim();
    if (url && fs.existsSync(url) && fs.statSync(url).isFile()) return image(fs.readFileSync(url), path.basename(url));
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
