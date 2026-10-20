import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TalkingStickService } from "../src/service.js";
import { runCodexInboxHookCommand } from "../src/cli/codex-inbox-hook.js";
import { mergeSessionHooks } from "../src/install.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.unstubAllEnvs(); });
const SESSION = "11111111-2222-3333-4444-555555555555";
function setup(beforeJoin = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-inbox-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const deliver = vi.fn(async () => ({ outcome: "queued" as const }));
  const service = new TalkingStickService({ dataDir: path.join(root, "data"), hostId: "local",
    now: () => new Date(now), processLivenessChecker: () => "alive", nativeWakeTransport: { deliver } });
  cleanup.push(() => service.close());
  const room = service.joinPath({ agent_id: "human:operator", context_path: root });
  const metadata = { harness_name: "codex", harness_session_id: `harness:${SESSION}`,
    harness_host_id: "local", harness_pid: 123, harness_process_started_at: "start", host_id: "local" };
  const join = () => {
    service.joinPath({ agent_id: "codex:test", context_path: root, process_metadata: metadata });
    service.registerNativeWakeEndpoint({ room_id: room.room_id, agent_id: "codex:test", transport: "codex_queue",
      address: SESSION, secret: null, harness_session_id: `harness:${SESSION}`, host_id: "local" });
  };
  if (!beforeJoin) join();
  const hook = (event: "UserPromptSubmit" | "Stop" | "Interrupt", overrides = {}) => service.handleCodexTurnHook({
    sessionId: SESSION, pid: 123, processStartedAt: "start", turnId: "turn-1", event, ...overrides });
  const send = (body: string, urgent = false) => service.sendMessageAndWake({ room_id: room.room_id,
    agent_id: "human:operator", to_agent_id: "codex:test", body, ...(urgent ? { delivery_hint: "interrupt" as const } : {}) });
  const ack = (text: string) => service.acknowledgeNativeDelivery({ agent_id: "codex:test",
    harness_session_id: `harness:${SESSION}`, host_id: "local", token: text.match(/tt ack (\S+)/)![1] });
  return { root, service, room, metadata, deliver, join, hook, send, ack, advance: (ms: number) => { now += ms; } };
}

test("an active turn reads through wait and never gets a stale Stop envelope", async () => {
  const { service, room, hook, send, deliver } = setup();
  hook("UserPromptSubmit");
  const sent = await send("already read");
  expect(deliver).not.toHaveBeenCalled();
  const read = await service.waitForEvents({ room_id: room.room_id, agent_id: "codex:test", after_event_seq: sent.event_seq - 1, max_wait_ms: 0 });
  expect(read.events[0].payload?.body).toBe("already read");
  expect(hook("Stop")).toBeNull();
  await send("now idle");
  expect(deliver).toHaveBeenCalledTimes(1);
});

test("Stop continues with only unread events, and never loops on missing acknowledgement", async () => {
  const { hook, send, deliver, ack } = setup();
  hook("UserPromptSubmit");
  await send("first");
  const first = hook("Stop")!;
  expect(first).toContain("  first");
  // New events in the Stop→continuation gap must stay off codex queue.
  await send("second");
  expect(deliver).not.toHaveBeenCalled();
  hook("UserPromptSubmit", { turnId: "turn-2" });
  const second = hook("Stop", { turnId: "turn-2" })!;
  expect(second).toContain("  second");
  expect(second).not.toContain("  first");
  expect(ack(second).status).toBe("acknowledged");
  expect(hook("Stop", { turnId: "turn-2" })).toBeNull();
  // Another room writer's flush must not queue the unacknowledged first batch.
  await send("third after Stop");
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0]).toEqual([expect.objectContaining({ text: expect.not.stringContaining("  first") })]);
});

test("activity recorded before room enrollment governs the first joined turn", async () => {
  const { hook, join, send, deliver } = setup(true);
  hook("UserPromptSubmit");
  join();
  await send("first joined turn");
  expect(deliver).not.toHaveBeenCalled();
  expect(hook("Stop")).toContain("first joined turn");
});

test("unknown hooks and expired activity use native queue; old queued batches are not redelivered at Stop", async () => {
  const { hook, send, deliver, advance } = setup();
  await send("native before hook trust");
  expect(deliver).toHaveBeenCalledTimes(1);
  hook("UserPromptSubmit");
  expect(hook("Stop")).toBeNull();
  hook("UserPromptSubmit", { turnId: "long-turn" });
  advance(5 * 60_000 + 1);
  await send("after a missed Stop");
  expect(deliver).toHaveBeenCalledTimes(2);
});

test("Interrupt clears active immediately and a late Stop cannot revive the cancelled turn", async () => {
  const { hook, send, deliver } = setup();
  hook("UserPromptSubmit");
  hook("Interrupt");
  await send("after cancel");
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(hook("Stop")).toBeNull();
});

test("wrong session/process/host and an old turn cannot change current activity", async () => {
  const { hook, send, deliver, service, room } = setup();
  hook("UserPromptSubmit");
  for (const overrides of [{ sessionId: "other" }, { pid: 124 }, { processStartedAt: "later" }, { turnId: "old-turn" }]) {
    expect(hook("Stop", overrides)).toBeNull();
  }
  await send("exact session only");
  expect(deliver).not.toHaveBeenCalled();
  service.db.prepare("UPDATE room_members SET harness_host_id = 'remote' WHERE room_id = ? AND agent_id = 'codex:test'").run(room.room_id);
  expect(hook("Stop")).toBeNull();
});

test("explicit urgent delivery remains immediate and is excluded from Stop feedback", async () => {
  const { hook, send, deliver } = setup();
  hook("UserPromptSubmit");
  await send("urgent", true);
  expect(deliver).toHaveBeenCalled();
  expect(deliver.mock.calls[0]).toEqual([expect.objectContaining({ interrupt: true })]);
  expect(hook("Stop")).toBeNull();
});

test("a turn starting between transports returns the reservation for Stop", async () => {
  const { service, room, hook, send, deliver } = setup();
  // First transport starts the turn but definitely fails. The next fallback
  // must recheck activity instead of sending the same batch to the terminal.
  service.registerNativeWakeEndpoint({ room_id: room.room_id, agent_id: "codex:test", transport: "cmux",
    address: JSON.stringify({ workspace_id: "w", surface_id: "s" }), secret: null,
    harness_session_id: `harness:${SESSION}`, host_id: "local" });
  deliver.mockImplementationOnce(async () => { hook("UserPromptSubmit"); return { outcome: "failed" } as never; });
  // An ordinary cmux fallback is eligible only in explicit cmux standby.
  service.db.prepare("UPDATE room_members SET wait_intent = 'parked', standby_transport = 'cmux' WHERE room_id = ? AND agent_id = 'codex:test'").run(room.room_id);
  await send("during handover");
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(hook("Stop")).toContain("during handover");
});

test("the hook emits Codex Stop JSON, fails open on malformed payloads and does not loop", async () => {
  const { service, send } = setup();
  const inspector = { inspect: (pid: number) => pid === 123 ? { pid, ppid: 1, startTime: "start", command: "codex app-server" } : null };
  const run = async (event: string, extra = {}) => {
    let out = "";
    await runCodexInboxHookCommand({ service, inspector, parentPid: 123, stdout: text => { out += text; },
      stdin: JSON.stringify({ hook_event_name: event, session_id: SESSION, turn_id: "turn-1", ...extra }) });
    return out ? JSON.parse(out) : null;
  };
  expect(await run("UserPromptSubmit")).toBeNull();
  await send("hook JSON");
  expect(await run("Stop")).toMatchObject({ decision: "block", reason: expect.stringContaining("hook JSON") });
  expect(await run("Stop", { stop_hook_active: true })).toBeNull();
  for (const stdin of ["not-json", "[]", "null", "{}"] ) {
    await expect(runCodexInboxHookCommand({ service, stdin, stdout: () => { throw new Error("unexpected output"); } })).resolves.toBeUndefined();
  }
  expect(await run("SubagentStop")).toBeNull();
  expect(await run("Stop", { agent_id: "child" })).toBeNull();
});

test("hook installation preserves foreign entries, is idempotent, and uninstalls only owned hooks", () => {
  const foreign = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "moshi codex-hook" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "herdr-hook" }] }] } });
  const merged = mergeSessionHooks(foreign, "codex")!;
  expect(merged).toContain("moshi codex-hook");
  expect(merged).toContain("herdr-hook");
  expect(merged).toContain("codex-inbox-hook");
  expect(mergeSessionHooks(merged, "codex")).toBe(merged);
  const removed = mergeSessionHooks(merged, "codex", true)!;
  expect(JSON.parse(removed)).toEqual(JSON.parse(foreign));
});

test("a failed hook write restores native fallback and missing state never creates a DB", async () => {
  const { service, root, send, deliver } = setup();
  const inspector = { inspect: (pid: number) => pid === 123 ? { pid, ppid: 1, startTime: "start", command: "codex app-server" } : null };
  const input = (event: string) => JSON.stringify({ hook_event_name: event, session_id: SESSION, turn_id: "turn-1" });
  await runCodexInboxHookCommand({ service, inspector, parentPid: 123, stdin: input("UserPromptSubmit") });
  await send("write failed");
  await runCodexInboxHookCommand({ service, inspector, parentPid: 123, stdin: input("Stop"), stdout: () => { throw new Error("pipe closed"); } });
  await send("native fallback");
  expect(deliver).toHaveBeenCalledTimes(1);
  vi.stubEnv("TALKING_STICK_DATA_DIR", path.join(root, "absent-data"));
  await runCodexInboxHookCommand({ inspector, parentPid: 123, stdin: input("UserPromptSubmit") });
  expect(fs.existsSync(path.join(root, "absent-data"))).toBe(false);
});

test("one Stop can deliver multiple repository rooms without skipping their event sequences", async () => {
  const { service, metadata, hook, send, deliver } = setup();
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-second-"));
  cleanup.unshift(() => fs.rmSync(second, { recursive: true, force: true }));
  const other = service.joinPath({ context_path: second, agent_id: "human:other" });
  service.joinPath({ context_path: second, agent_id: "codex:test", process_metadata: metadata });
  service.registerNativeWakeEndpoint({ room_id: other.room_id, agent_id: "codex:test", transport: "codex_queue",
    address: SESSION, secret: null, harness_session_id: `harness:${SESSION}`, host_id: "local" });
  hook("UserPromptSubmit");
  await send("repo one");
  await service.sendMessageAndWake({ room_id: other.room_id, agent_id: "human:other", to_agent_id: "codex:test", body: "repo two" });
  await send("repo one again");
  const text = hook("Stop")!;
  expect(text).toContain("  repo one");
  expect(text).toContain("  repo two");
  expect(text).toContain("  repo one again");
  expect(text.match(/ · ack: tt ack /g)).toHaveLength(2);
  expect(deliver).not.toHaveBeenCalled();
  expect(hook("Stop")).toBeNull();
});

test("ambiguous room identities receive nothing and lifecycle end removes turn state", async () => {
  const { service, root, metadata, hook, send } = setup();
  hook("UserPromptSubmit");
  service.joinPath({ context_path: root, agent_id: "codex:duplicate", process_metadata: metadata });
  await send("ambiguous");
  expect(hook("Stop")).toBeNull();
  service.recordSessionLifecycle({ harness: "codex", sessionId: SESSION, pid: 123, processStartedAt: "start", event: "SessionEnd" });
  expect(service.db.prepare("SELECT * FROM codex_turn_activity").all()).toEqual([]);
});

test("exact-session CLI calls refresh long turns, but guardians and other observers cannot", async () => {
  const { service, room, metadata, hook, send, deliver, advance } = setup();
  hook("UserPromptSubmit");
  advance(4 * 60_000);
  service.getRoomState({ room_id: room.room_id, agent_id: "codex:test", process_metadata: { ...metadata, session_kind: "harness_cli" } });
  advance(4 * 60_000);
  await send("eight-minute turn");
  expect(deliver).not.toHaveBeenCalled();
  service.getRoomState({ room_id: room.room_id, agent_id: "human:operator" });
  service.getRoomState({ room_id: room.room_id, agent_id: "codex:test", process_metadata: { ...metadata, session_kind: "human_guardian" } });
  advance(2 * 60_000);
  await send("expired without a real CLI call");
  expect(deliver).toHaveBeenCalledTimes(1);
});

test("Stop and hook acknowledgement clear receiptless wake flags without a body-free wake", async () => {
  const { service, room, hook, send, ack, deliver } = setup();
  hook("UserPromptSubmit");
  const sent = await send("read by wait");
  await service.waitForEvents({ room_id: room.room_id, agent_id: "codex:test", after_event_seq: sent.event_seq - 1, max_wait_ms: 0 });
  expect(hook("Stop")).toBeNull();
  await service.flushWakes();
  expect(deliver).not.toHaveBeenCalled();
  hook("UserPromptSubmit", { turnId: "next" });
  await send("read by hook");
  const text = hook("Stop", { turnId: "next" })!;
  ack(text);
  expect(hook("Stop", { turnId: "next" })).toBeNull();
  await service.flushWakes();
  expect(deliver).not.toHaveBeenCalled();
  expect(service.db.prepare("SELECT wake_pending, wake_event_seq, wake_reason FROM member_wake_endpoints WHERE room_id = ?").get(room.room_id))
    .toEqual({ wake_pending: 0, wake_event_seq: null, wake_reason: null });
});

test("a lost Stop continuation becomes eligible for native retry after five minutes", async () => {
  const { service, hook, send, deliver, advance } = setup();
  hook("UserPromptSubmit");
  await send("lost continuation");
  expect(hook("Stop")).toContain("lost continuation");
  expect(hook("Stop")).toBeNull();
  await service.flushWakes();
  expect(deliver).not.toHaveBeenCalled();
  advance(5 * 60_000 + 1);
  await send("retry trigger");
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0]).toEqual([expect.objectContaining({ text: expect.stringContaining("lost continuation") })]);
});
