import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { runInterruptHookCommand } from "../src/cli/interrupt-hook.js";
import { mergeSessionHooks } from "../src/install.js";
import {
  HOOK_INTERRUPT_TTL_MS,
  consumeHookInterrupt,
  interruptFlagDir,
  requestHookInterrupt
} from "../src/interrupt-flags.js";

const SESSION = "bfe824e3-4700-4923-aba8-cb3710e41177";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function dataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-interrupt-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function hook(dir: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  let out = "";
  await runInterruptHookCommand("claude", { dataDir: dir, stdin: JSON.stringify(input), stdout: (text) => { out += text; } });
  return out ? JSON.parse(out) as Record<string, unknown> : null;
}

test("no flag leaves tool calls alone", async () => {
  const dir = dataDir();
  expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: SESSION })).toBeNull();
});

test("repeated stop requests keep one pending flag until a hook consumes it", async () => {
  const dir = dataDir();
  expect(requestHookInterrupt("claude", SESSION, dir)).toBe("created");
  expect(requestHookInterrupt("claude", SESSION, dir)).toBe("pending");
  expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: SESSION })).toMatchObject({ continue: false });
  expect(requestHookInterrupt("claude", SESSION, dir)).toBe("created");
});

test("a flag denies the pending tool and stops the turn once", async () => {
  const dir = dataDir();
  expect(requestHookInterrupt("claude", `harness:${SESSION}`, dir)).toBe("created");
  expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: "other" })).toBeNull();
  expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: SESSION })).toMatchObject({
    continue: false,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" }
  });
  expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: SESSION })).toBeNull();
});

test("after a tool the turn stops without a permission decision", async () => {
  const dir = dataDir();
  requestHookInterrupt("claude", SESSION, dir);
  const out = await hook(dir, { hook_event_name: "PostToolUse", session_id: SESSION });
  expect(out).toMatchObject({ continue: false });
  expect(out).not.toHaveProperty("hookSpecificOutput");
});

test("a subagent stops but leaves the flag for its parent", async () => {
  const dir = dataDir();
  requestHookInterrupt("claude", SESSION, dir);
  expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: SESSION, agent_id: "sub" }))
    .toMatchObject({ continue: false });
  expect(await hook(dir, { hook_event_name: "PostToolUse", session_id: SESSION }))
    .toMatchObject({ continue: false });
});

test("a turn boundary discards a flag that stopped nothing", async () => {
  const dir = dataDir();
  for (const event of ["Stop", "UserPromptSubmit"]) {
    requestHookInterrupt("claude", SESSION, dir);
    expect(await hook(dir, { hook_event_name: event, session_id: SESSION })).toBeNull();
    expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: SESSION })).toBeNull();
  }
});

test("an expired flag is removed without stopping a later turn", () => {
  const dir = dataDir();
  requestHookInterrupt("claude", SESSION, dir);
  expect(consumeHookInterrupt("claude", SESSION, dir, Date.now() + HOOK_INTERRUPT_TTL_MS + 1_000)).toBe(false);
  expect(fs.readdirSync(interruptFlagDir(dir))).toEqual([]);
});

test("a hook for another session removes an expired orphan flag", async () => {
  const dir = dataDir();
  requestHookInterrupt("claude", SESSION, dir);
  const flag = path.join(interruptFlagDir(dir), `claude-${SESSION}`);
  const stale = new Date(Date.now() - HOOK_INTERRUPT_TTL_MS - 1_000);
  fs.utimesSync(flag, stale, stale);
  expect(await hook(dir, { hook_event_name: "PreToolUse", session_id: "another-session" })).toBeNull();
  expect(fs.readdirSync(interruptFlagDir(dir))).toEqual([]);
});

test("unsafe session ids never become flag paths", () => {
  const dir = dataDir();
  expect(requestHookInterrupt("claude", "../escape", dir)).toBe("failed");
  expect(requestHookInterrupt("claude", "", dir)).toBe("failed");
});

test("malformed input fails open", async () => {
  let out = "";
  await runInterruptHookCommand("claude", { dataDir: dataDir(), stdin: "garbage", stdout: (text) => { out += text; } });
  await runInterruptHookCommand("codex", { dataDir: dataDir(), stdin: "{}", stdout: (text) => { out += text; } });
  expect(out).toBe("");
});

test("Claude settings gain interrupt hooks that uninstall cleanly", () => {
  const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine" }] }] } });
  const installed = JSON.parse(mergeSessionHooks(original, "claude")!);
  for (const event of ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"]) {
    expect(JSON.stringify(installed.hooks[event])).toContain("talking-stick-interrupt-claude");
  }
  expect(installed.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [{ type: "command", command: "mine" }] });
  expect(JSON.parse(mergeSessionHooks(JSON.stringify(installed), "claude", true)!)).toEqual(JSON.parse(original));
  expect(JSON.stringify(JSON.parse(mergeSessionHooks("{}", "codex")!))).not.toContain("interrupt");
});

test("the installed shell guard skips tt unless a Claude flag exists", () => {
  const dir = dataDir();
  const command = JSON.parse(mergeSessionHooks("{}", "claude")!).hooks.PreToolUse[0].hooks[0].command as string;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tt-bin-"));
  cleanup.push(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "tt"), "#!/bin/sh\necho called \"$@\"\n", { mode: 0o755 });
  const run = () => execFileSync("/bin/sh", ["-c", command], {
    encoding: "utf8", input: "{}",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TALKING_STICK_DATA_DIR: dir }
  });
  expect(run()).toBe("");
  requestHookInterrupt("claude", SESSION, dir);
  expect(run()).toBe("called interrupt-hook claude\n");
});
