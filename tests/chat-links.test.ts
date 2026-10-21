import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACK_LINK_PATTERN,
  ackLinkUrl,
  ensureChatLinkDir,
  osc8,
  parseAckLink,
  sendChatLinkClick,
  startChatLinkServer,
  type ChatLinkServer
} from "../src/cli/chat-links.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

// Unix socket paths are short on Darwin, so these tests use /tmp directly.
const dirs: string[] = [];
const servers: ChatLinkServer[] = [];
function privateDir(): string {
  const dir = fs.mkdtempSync("/tmp/ttl-");
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ack links", () => {
  it("round-trips a token and seq through the URL", () => {
    const url = ackLinkUrl(TOKEN, 27945);
    expect(url).toBe(`https://talking-stick.invalid/ack/${TOKEN}/27945`);
    expect(new RegExp(ACK_LINK_PATTERN).test(url)).toBe(true);
    expect(parseAckLink(url)).toEqual({ token: TOKEN, seq: 27945 });
  });

  it("rejects anything but the exact host, path, token and positive seq", () => {
    for (const url of [
      `http://talking-stick.invalid/ack/${TOKEN}/1`,
      `https://talking-stick.invalid.example/ack/${TOKEN}/1`,
      `https://user@talking-stick.invalid/ack/${TOKEN}/1`,
      `https://talking-stick.invalid/ack/${TOKEN}/0`,
      `https://talking-stick.invalid/ack/${TOKEN}/01`,
      `https://talking-stick.invalid/ack/${TOKEN}/1?x=1`,
      `https://talking-stick.invalid/ack/${TOKEN}/1/`,
      `https://talking-stick.invalid/ack/${TOKEN.toUpperCase()}/1`,
      `https://talking-stick.invalid/ack/${TOKEN.slice(1)}/1`,
      `https://talking-stick.invalid/ack/../${TOKEN}/1`,
      `https://talking-stick.invalid/ack/${TOKEN}/99999999999999999`
    ]) {
      expect(parseAckLink(url), url).toBeNull();
    }
  });

  it("wraps text in an OSC 8 hyperlink", () => {
    expect(osc8("pin", "https://x.invalid/")).toBe("\u001b]8;;https://x.invalid/\u001b\\pin\u001b]8;;\u001b\\");
  });
});

describe("chat link dir", () => {
  it("creates a private directory and refuses a shared one", () => {
    const parent = privateDir();
    const dir = path.join(parent, "links");
    expect(ensureChatLinkDir(dir)).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    expect(() => ensureChatLinkDir(dir)).toThrow(/accessible to other users/);
  });

  it("refuses a symlink planted in its place", () => {
    const parent = privateDir();
    const target = path.join(parent, "elsewhere");
    fs.mkdirSync(target, { mode: 0o700 });
    const dir = path.join(parent, "links");
    fs.symlinkSync(target, dir);
    expect(() => ensureChatLinkDir(dir)).toThrow(/not a directory/);
  });
});

describe("chat link server", () => {
  async function serve(paneId: string, pending: number[]) {
    const dir = privateDir();
    const acked: number[] = [];
    const server = await startChatLinkServer({
      dir,
      paneId,
      onAck: (seq) => {
        if (!pending.includes(seq)) return false;
        acked.push(seq);
        return true;
      }
    });
    servers.push(server);
    return { dir, server, acked };
  }

  it("acknowledges a pending seq clicked in the console's own pane", async () => {
    const { dir, server, acked } = await serve("pane-1", [42]);
    expect(fs.statSync(path.join(dir, `${server.token}.sock`)).mode & 0o777).toBe(0o600);
    await expect(sendChatLinkClick({ url: server.url(42), paneId: "pane-1", dir })).resolves.toBe("acked");
    expect(acked).toEqual([42]);
  });

  it("ignores clicks from another pane and seqs that are not pending", async () => {
    const { dir, server, acked } = await serve("pane-1", [42]);
    await expect(sendChatLinkClick({ url: server.url(42), paneId: "pane-2", dir })).resolves.toBe("ignored");
    await expect(sendChatLinkClick({ url: server.url(7), paneId: "pane-1", dir })).resolves.toBe("ignored");
    expect(acked).toEqual([]);
  });

  it("reports a closed console or unknown token as unreachable", async () => {
    const { dir, server } = await serve("pane-1", [42]);
    const url = server.url(42);
    await expect(sendChatLinkClick({ url: ackLinkUrl(TOKEN, 42), paneId: "pane-1", dir })).resolves.toBe("unreachable");
    server.close();
    expect(fs.existsSync(path.join(dir, `${server.token}.sock`))).toBe(false);
    await expect(sendChatLinkClick({ url, paneId: "pane-1", dir })).resolves.toBe("unreachable");
  });

  it("rejects malformed links and a missing pane without connecting", async () => {
    const { dir, server } = await serve("pane-1", [42]);
    await expect(sendChatLinkClick({ url: "https://example.com/", paneId: "pane-1", dir })).resolves.toBe("invalid");
    await expect(sendChatLinkClick({ url: server.url(42), paneId: "", dir })).resolves.toBe("invalid");
  });

  it("rejects malformed and oversized requests", async () => {
    const { dir, server, acked } = await serve("pane-1", [42]);
    const socketPath = path.join(dir, `${server.token}.sock`);
    const request = (body: string) => new Promise<string>((resolve) => {
      let response = "";
      const socket = net.connect(socketPath, () => socket.write(body));
      socket.on("data", (chunk) => { response += chunk.toString(); });
      socket.on("close", () => resolve(response));
      socket.on("error", () => resolve(response));
    });
    expect(await request("not json\n")).toBe('{"ok":false}\n');
    expect(await request('{"seq":"42","pane_id":"pane-1"}\n')).toBe('{"ok":false}\n');
    expect(await request('{"seq":42.5,"pane_id":"pane-1"}\n')).toBe('{"ok":false}\n');
    expect(await request("x".repeat(2048))).toBe("");
    expect(acked).toEqual([]);
  });

  it("sweeps sockets left behind by a console that died", async () => {
    const dir = privateDir();
    const stale = path.join(dir, `${TOKEN}.sock`);
    // A console killed outright leaves its socket path with nothing listening.
    const child = spawn(process.execPath, ["-e",
      `require("net").createServer().listen(${JSON.stringify(stale)}, () => console.log("ready"))`]);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(fs.existsSync(stale)).toBe(true);
    servers.push(await startChatLinkServer({ dir, paneId: "pane-1", onAck: () => false }));
    expect(fs.existsSync(stale)).toBe(false);
  });
});
