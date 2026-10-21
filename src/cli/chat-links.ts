import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Herdr routes Ctrl-clicks on OSC 8 links to plugin actions, but only for
// http(s) URIs, so pins link to a reserved .invalid host that never resolves.
export const CHAT_LINK_HOST = "talking-stick.invalid";
export const ACK_LINK_PATTERN = "^https://talking-stick\\.invalid/ack/[0-9a-f]{32}/[1-9][0-9]{0,15}$";

const ACK_LINK = new RegExp(ACK_LINK_PATTERN);
const MAX_REQUEST_BYTES = 512;
const REQUEST_TIMEOUT_MS = 2_000;
const CLICK_TIMEOUT_MS = 1_000;

export interface AckLink {
  token: string;
  seq: number;
}

export function ackLinkUrl(token: string, seq: number): string {
  return `https://${CHAT_LINK_HOST}/ack/${token}/${seq}`;
}

export function parseAckLink(url: string): AckLink | null {
  if (!ACK_LINK.test(url)) return null;
  const [, , , , token, rawSeq] = url.split("/");
  const seq = Number(rawSeq);
  return Number.isSafeInteger(seq) ? { token, seq } : null;
}

export function osc8(text: string, url: string): string {
  return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
}

// Darwin limits Unix socket paths to 104 bytes and $TMPDIR alone is ~50, so
// the sockets live in a short per-user directory under /tmp.
export function chatLinkDir(uid = process.getuid?.() ?? 0): string {
  return path.join(os.platform() === "win32" ? os.tmpdir() : "/tmp", `tt-chat-${uid}`);
}

// Another local user could pre-create the directory or plant a symlink;
// refuse anything that is not a private directory we own.
export function ensureChatLinkDir(dir = chatLinkDir()): string {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir} is not a directory.`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} is owned by another user.`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${dir} is accessible to other users.`);
  return dir;
}

export interface ChatLinkServer {
  token: string;
  url(seq: number): string;
  close(): void;
}

export interface ChatLinkServerOptions {
  paneId: string;
  // Called only for a click from this chat's own pane; returns whether the
  // seq was pending and is now acknowledged.
  onAck(seq: number): boolean;
  dir?: string;
}

// One console, one socket: the unguessable token names the socket, so a link
// reaches only the live chat that rendered it and dies with that chat.
export async function startChatLinkServer(options: ChatLinkServerOptions): Promise<ChatLinkServer> {
  const dir = ensureChatLinkDir(options.dir);
  await sweepStaleSockets(dir);
  const token = crypto.randomBytes(16).toString("hex");
  const socketPath = path.join(dir, `${token}.sock`);
  const server = net.createServer((connection) => {
    connection.setTimeout(REQUEST_TIMEOUT_MS, () => connection.destroy());
    let buffered = "";
    let handled = false;
    connection.on("data", (chunk) => {
      if (handled) return;
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        if (buffered.length > MAX_REQUEST_BYTES) connection.destroy();
        return;
      }
      handled = true;
      const ok = handleRequest(buffered.slice(0, newline), options);
      connection.end(`${JSON.stringify({ ok })}\n`);
    });
    connection.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  let closed = false;
  return {
    token,
    url: (seq) => ackLinkUrl(token, seq),
    close: () => {
      if (closed) return;
      closed = true;
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  };
}

function handleRequest(line: string, options: ChatLinkServerOptions): boolean {
  if (line.length > MAX_REQUEST_BYTES) return false;
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof request !== "object" || request === null) return false;
  const { seq, pane_id: paneId } = request as Record<string, unknown>;
  if (paneId !== options.paneId || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return false;
  try {
    return options.onAck(seq) === true;
  } catch {
    return false;
  }
}

// A chat that crashed leaves its socket behind; nothing listens on it.
async function sweepStaleSockets(dir: string): Promise<void> {
  const sockets = fs.readdirSync(dir).filter((name) => /^[0-9a-f]{32}\.sock$/.test(name));
  await Promise.all(sockets.map(async (name) => {
    const socketPath = path.join(dir, name);
    if (await probe(socketPath) === "refused") fs.rmSync(socketPath, { force: true });
  }));
}

function probe(socketPath: string): Promise<"live" | "refused" | "unknown"> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.setTimeout(CLICK_TIMEOUT_MS, () => { socket.destroy(); resolve("unknown"); });
    socket.once("connect", () => { socket.destroy(); resolve("live"); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "refused" : "unknown");
    });
  });
}

export type ChatLinkClickResult = "acked" | "ignored" | "unreachable" | "invalid";

export async function sendChatLinkClick(input: {
  url: string;
  paneId: string;
  dir?: string;
  timeoutMs?: number;
}): Promise<ChatLinkClickResult> {
  const link = parseAckLink(input.url);
  if (!link || !input.paneId) return "invalid";
  const socketPath = path.join(input.dir ?? chatLinkDir(), `${link.token}.sock`);
  return new Promise((resolve) => {
    let response = "";
    let settled = false;
    const finish = (result: ChatLinkClickResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect(socketPath);
    socket.setTimeout(input.timeoutMs ?? CLICK_TIMEOUT_MS, () => finish("unreachable"));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ seq: link.seq, pane_id: input.paneId })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > MAX_REQUEST_BYTES) finish("ignored");
    });
    socket.once("end", () => {
      try {
        finish((JSON.parse(response) as { ok?: unknown }).ok === true ? "acked" : "ignored");
      } catch {
        finish("ignored");
      }
    });
    socket.once("error", () => finish("unreachable"));
  });
}

// Herdr runs this as the link handler's action. A stale or foreign link is a
// silent no-op: the handler already ran, so Herdr never opens a browser.
export async function runChatLinkCommand(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const result = await sendChatLinkClick({
    url: env.HERDR_PLUGIN_CLICKED_URL?.trim() ?? "",
    paneId: env.HERDR_PANE_ID?.trim() ?? ""
  });
  process.stdout.write(`${result}\n`);
}
