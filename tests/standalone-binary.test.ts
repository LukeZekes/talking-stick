import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Builds the real `bun build --compile` binary, installs it with
// scripts/install.sh, and drives a full turn through it. Skipped where Bun
// is not installed; the release workflow always has it.
const hasBun = spawnSync("bun", ["--version"]).status === 0;
const supported = (process.platform === "darwin" || process.platform === "linux") &&
  (process.arch === "x64" || process.arch === "arm64");

describe.skipIf(!hasBun || !supported)("standalone binary", () => {
  let root = "";
  let bin = "";
  let install = "";
  let tt = "";
  // An isolated HOME keeps startup maintenance away from real skill and
  // instruction installs.
  const env = () => ({ ...process.env, HOME: path.join(root, "home"), TALKING_STICK_DATA_DIR: path.join(root, "data"),
    TT_ROOM: "", XDG_CONFIG_HOME: path.join(root, "home", ".config"),
    TT_HARNESS_AGENT_ID: "claude:standalone", TALKING_STICK_DISABLE_SKILL_SYNC: "1", TALKING_STICK_DISABLE_SKILLER: "1" });
  const run = (args: string[], cwd: string) =>
    JSON.parse(execFileSync(tt, [...args, "--json"], { cwd, env: env(), encoding: "utf8" }));

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-standalone-"));
    const assets = path.join(root, "assets");
    execFileSync("node", ["scripts/build-standalone.mjs", `bun-${process.platform}-${process.arch}`],
      { env: { ...process.env, TT_RELEASE_DIR: assets }, stdio: "pipe" });
    const sums = fs.readdirSync(assets).filter((name) => name.endsWith(".sha256"))
      .map((name) => fs.readFileSync(path.join(assets, name), "utf8")).join("");
    fs.writeFileSync(path.join(assets, "checksums.txt"), sums);
    bin = path.join(root, "bin dir");
    install = path.join(root, "install dir");
    execFileSync("sh", ["scripts/install.sh", "--base-url", assets, "--bin-dir", bin, "--install-dir", install],
      { env: { ...process.env, HOME: path.join(root, "home") }, stdio: "pipe" });
    tt = path.join(bin, "tt");
    fs.mkdirSync(path.join(root, "home"));
  }, 180_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("joins, takes the turn through its own guardian, messages, and releases", () => {
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    execFileSync("git", ["init", "-q", project]);
    expect(run(["join"], project).room_id).toBeTruthy();
    const turn = run(["wait", "--claim", "--timeout", "5"], project);
    expect(turn.status).toBe("your_turn");
    expect(turn.guardian_pid).toBeGreaterThan(0);
    expect(run(["msg", "send", "room", "from the binary"], project).event_seq).toBeGreaterThan(0);
    expect(run(["release", "--status", "done", "--next-action", "none"], project).status).toBe("released");
    expect(run(["state"], project).room.owner).toBeNull();
    const nodeState = JSON.parse(execFileSync(process.execPath, [path.resolve("dist/cli.js"), "state", "--json"],
      { cwd: project, env: env(), encoding: "utf8" }));
    expect(nodeState.room.room_id).toBe(run(["state"], project).room.room_id);
    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "notes", "add", "from Node", "--json"],
      { cwd: project, env: env(), encoding: "utf8" });
    expect(JSON.stringify(run(["notes", "list"], project))).toContain("from Node");
  });

  it("finds its skill beside the executable and self-updates with the installed directories", () => {
    const releaseRoot = path.dirname(fs.realpathSync(tt));
    const bundledSkill = path.join(releaseRoot, "skills", "talking-stick", "SKILL.md");
    expect(fs.existsSync(bundledSkill)).toBe(true);
    fs.mkdirSync(path.join(root, "home", ".codex"), { recursive: true });
    execFileSync(tt, ["install", "codex", "--copy"], { env: env(), encoding: "utf8" });
    expect(fs.readFileSync(path.join(root, "home", ".agents", "skills", "talking-stick", "SKILL.md"), "utf8"))
      .toBe(fs.readFileSync(bundledSkill, "utf8"));
    const plan = execFileSync(tt, ["self-update", "--print"], { env: env(), encoding: "utf8" });
    expect(plan).toContain(path.join(releaseRoot, "scripts", "install.sh"));
    expect(plan).toContain(fs.realpathSync(install));
    expect(plan).toContain(fs.realpathSync(bin));
  });
});
