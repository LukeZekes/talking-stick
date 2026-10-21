import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACK_LINK_PATTERN } from "../src/cli/chat-links.js";
import type { HerdrRunner } from "../src/herdr.js";
import {
  HERDR_PLUGIN_ID,
  chatLinkArgv,
  herdrPluginManifest,
  installHerdrPlugin,
  readHerdrPluginState,
  uninstallHerdrPlugin
} from "../src/herdr-plugin.js";

const dirs: string[] = [];
function dataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-herdr-plugin-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// A fake Herdr that keeps a plugin registry and records every call.
function fakeHerdr(initial: { enabled: boolean } | null = null, listFails = false) {
  let plugin = initial;
  const calls: string[][] = [];
  const runner: HerdrRunner = (args) => {
    calls.push([...args]);
    const [group, verb, target] = args;
    if (group !== "plugin") throw new Error(`unexpected ${args.join(" ")}`);
    if (verb === "list") {
      if (listFails) throw new Error("unknown command");
      const plugins = plugin ? [{ plugin_id: HERDR_PLUGIN_ID, enabled: plugin.enabled }] : [];
      return JSON.stringify({ id: "cli:plugin", result: { type: "plugin_list", plugins } });
    }
    if (verb === "link") { plugin = { enabled: args.includes("--enabled") }; return ""; }
    if (verb === "unlink" && target === HERDR_PLUGIN_ID) { plugin = null; return ""; }
    if (verb === "enable" && target === HERDR_PLUGIN_ID && plugin) { plugin.enabled = true; return ""; }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { runner, calls, state: () => plugin };
}

const ARGV = ["/opt/tt/current/tt", "chat-link"];

describe("herdr plugin manifest", () => {
  it("declares one link handler routed to an absolute chat-link command", () => {
    const manifest = herdrPluginManifest(["/Users/a b/\"tt\"", "chat-link"]);
    expect(manifest).toContain(`id = "${HERDR_PLUGIN_ID}"`);
    expect(manifest).toContain('min_herdr_version = "0.7.0"');
    expect(manifest).toContain('command = ["/Users/a b/\\"tt\\"", "chat-link"]');
    expect(manifest).toContain('action = "ack-pin"');
    // TOML basic strings use the same escapes as JSON, so the regex survives.
    const pattern = /^pattern = (.*)$/m.exec(manifest)?.[1];
    expect(JSON.parse(pattern!)).toBe(ACK_LINK_PATTERN);
  });

  it("runs node on the CLI entry outside a standalone release", () => {
    const argv = chatLinkArgv(new URL("../dist/cli.js", import.meta.url).href);
    expect(argv[0]).toBe(process.execPath);
    expect(path.isAbsolute(argv[1])).toBe(true);
    expect(argv[1].endsWith(path.join("dist", "cli.js"))).toBe(true);
    expect(argv[2]).toBe("chat-link");
  });
});

describe("herdr plugin install", () => {
  it("writes the manifest and links it enabled", () => {
    const dir = dataDir();
    const herdr = fakeHerdr();
    const result = installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: ARGV });
    expect(result.status).toBe("linked");
    expect(fs.readFileSync(path.join(result.dir, "herdr-plugin.toml"), "utf8")).toBe(herdrPluginManifest(ARGV));
    expect(herdr.calls).toContainEqual(["plugin", "link", result.dir, "--enabled"]);
    expect(herdr.state()).toEqual({ enabled: true });
  });

  it("leaves an enabled, current plugin alone", () => {
    const dir = dataDir();
    const herdr = fakeHerdr();
    installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: ARGV });
    herdr.calls.length = 0;
    expect(installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: ARGV }).status).toBe("unchanged");
    expect(herdr.calls).toEqual([["plugin", "list", "--json"]]);
  });

  it("relinks when the command changed", () => {
    const dir = dataDir();
    const herdr = fakeHerdr();
    installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: ARGV });
    herdr.calls.length = 0;
    const next = ["/opt/tt/releases/2/tt", "chat-link"];
    expect(installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: next }).status).toBe("updated");
    expect(herdr.calls.slice(1)).toEqual([
      ["plugin", "unlink", HERDR_PLUGIN_ID],
      ["plugin", "link", path.join(dir, "herdr-plugin"), "--enabled"]
    ]);
    expect(fs.readFileSync(path.join(dir, "herdr-plugin", "herdr-plugin.toml"), "utf8")).toContain("/opt/tt/releases/2/tt");
  });

  it("re-enables a plugin the user disabled when asked to install it", () => {
    const dir = dataDir();
    const herdr = fakeHerdr();
    installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: ARGV });
    herdr.state()!.enabled = false;
    expect(installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: ARGV }).status).toBe("updated");
    expect(herdr.state()).toEqual({ enabled: true });
  });

  it("fails clearly when herdr cannot list plugins", () => {
    const herdr = fakeHerdr(null, true);
    expect(readHerdrPluginState(herdr.runner)).toBe("unavailable");
    expect(() => installHerdrPlugin({ runner: herdr.runner, dataDir: dataDir(), argv: ARGV })).toThrow(/0\.7\.0/);
  });

  it("unlinks and removes the generated plugin", () => {
    const dir = dataDir();
    const herdr = fakeHerdr();
    installHerdrPlugin({ runner: herdr.runner, dataDir: dir, argv: ARGV });
    expect(uninstallHerdrPlugin({ runner: herdr.runner, dataDir: dir })).toBe("removed");
    expect(herdr.state()).toBeNull();
    expect(fs.existsSync(path.join(dir, "herdr-plugin"))).toBe(false);
    expect(uninstallHerdrPlugin({ runner: herdr.runner, dataDir: dir })).toBe("not_installed");
  });
});
