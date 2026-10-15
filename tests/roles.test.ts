import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService } from "../src/service.js";
import {
  BUNDLED_ROLE_DEFAULTS,
  effectiveRoles,
  readUserRoleDefaults,
  renderRoleBlock,
  writeUserRoleDefault,
  type RoomRoleAssignment
} from "../src/roles.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("precedence: exact agent, then harness in the room, then user default, then bundled", () => {
  const user = { codex: ["tester"] };
  expect(effectiveRoles("claude:1", [], {})).toEqual({ roles: ["architect"], source: "bundled" });
  expect(effectiveRoles("codex:1", [], user)).toEqual({ roles: ["tester"], source: "user" });
  expect(effectiveRoles("codex:1", [{ subject: "harness:codex", roles: ["reviewer"] }], user).roles).toEqual(["reviewer"]);
  const both = [{ subject: "harness:codex" as const, roles: ["reviewer"] }, { subject: "agent:codex:1" as const, roles: [] }];
  // An explicit empty assignment is "no role", not a fallthrough.
  expect(effectiveRoles("codex:1", both, user)).toEqual({ roles: [], source: "agent" });
  expect(effectiveRoles("codex:2", both, user).roles).toEqual(["reviewer"]);
  expect(effectiveRoles("opencode:1", [], {})).toEqual({ roles: [], source: "none" });
});

test("user defaults: clear removes the override and a malformed file is never overwritten", () => {
  const dataDir = tempDir("tt-roles-");
  writeUserRoleDefault("codex", ["tester"], { env: { TALKING_STICK_DATA_DIR: dataDir } });
  writeUserRoleDefault("grok", [], { env: { TALKING_STICK_DATA_DIR: dataDir } });
  expect(readUserRoleDefaults({ env: { TALKING_STICK_DATA_DIR: dataDir } })).toEqual({ codex: ["tester"], grok: [] });
  writeUserRoleDefault("codex", null, { env: { TALKING_STICK_DATA_DIR: dataDir } });
  expect(readUserRoleDefaults({ env: { TALKING_STICK_DATA_DIR: dataDir } })).toEqual({ grok: [] });
  fs.writeFileSync(path.join(dataDir, "roles.json"), "{ broken");
  expect(readUserRoleDefaults({ env: { TALKING_STICK_DATA_DIR: dataDir } })).toEqual({});
  expect(() => writeUserRoleDefault("claude", ["scribe"], { env: { TALKING_STICK_DATA_DIR: dataDir } })).toThrow(/Refusing to overwrite/);
  expect(fs.readFileSync(path.join(dataDir, "roles.json"), "utf8")).toBe("{ broken");
  expect(BUNDLED_ROLE_DEFAULTS.claude).toEqual(["architect"]);
});

function roomWithAgents() {
  const root = tempDir("tt-roles-room-");
  const deliveries: string[] = [];
  const service = new TalkingStickService({
    dbPath: path.join(root, ".state", "rooms.sqlite"),
    policy: { waitForEventsPollMs: 1 },
    nativeWakeTransport: { deliver(request) { deliveries.push(request.address); return { outcome: "queued" }; } }
  });
  cleanups.push(() => service.close());
  const room = service.joinPath({ agent_id: "claude:a", context_path: root, process_metadata: { harness_session_id: "claude-a" } });
  service.joinPath({ agent_id: "codex:b", context_path: root, process_metadata: { harness_session_id: "codex-b" } });
  service.joinPath({ agent_id: "grok:c", context_path: root, process_metadata: { harness_session_id: "grok-c" } });
  for (const [agent, session] of [["codex:b", "codex-b"], ["grok:c", "grok-c"]]) {
    service.registerNativeWakeEndpoint({ room_id: room.room_id, agent_id: agent, transport: "claude_inbox",
      address: session, secret: "private", harness_session_id: session, host_id: os.hostname() });
  }
  return { service, room, deliveries };
}

test("only the operator assigns roles; agents can read them", () => {
  const { service, room } = roomWithAgents();
  expect(() => service.setRoomRoles({ agent_id: "codex:b", room_id: room.room_id,
    changes: [{ subject: "harness:claude", roles: [] }], notify: () => ({ body: "x", to_agent_ids: [] }) })).toThrow(/operator/);
  expect(service.getRoomRoles({ room_id: room.room_id })).toEqual({ version: 0, assignments: [] });
});

test("a role change and its notice commit together, reach only affected agents, and wake them", async () => {
  const { service, room, deliveries } = roomWithAgents();
  const result = service.setRoomRoles({
    agent_id: "human:op", room_id: room.room_id,
    changes: [{ subject: "agent:codex:b", roles: ["reviewer"] }],
    notify: ({ version, assignments }) => ({
      to_agent_ids: ["codex:b"],
      body: `[roles v${version}]\n` + renderRoleBlock({ self: null, agents: ["claude:a", "codex:b", "grok:c"], assignments, userDefaults: {}, version })
    })
  });
  expect(result).toMatchObject({ version: 1, recipients: ["codex:b"] });
  expect(service.getRoomRoles({ room_id: room.room_id })).toEqual({ version: 1, assignments: [{ subject: "agent:codex:b", roles: ["reviewer"] }] });

  // The affected agent's ordinary self wait sees exactly one notice.
  const forCodex = await service.waitForEvents({ agent_id: "codex:b", room_id: room.room_id, after_event_seq: room.cursor_event_seq, max_wait_ms: 0 });
  const notices = forCodex.events.filter((event) => (event.payload as { body?: string } | null)?.body?.startsWith("[roles v1]"));
  expect(notices).toHaveLength(1);
  expect((notices[0].payload as { body: string }).body).toContain("- codex:b: reviewer (independent review and cross-checks)");
  const forGrok = await service.waitForEvents({ agent_id: "grok:c", room_id: room.room_id, after_event_seq: room.cursor_event_seq, max_wait_ms: 0 });
  expect(forGrok.events.some((event) => (event.payload as { body?: string } | null)?.body?.startsWith("[roles"))).toBe(false);

  // A parked recipient is woken natively; the unaffected agent is not.
  await service.flushWakes(room.room_id);
  expect(deliveries).toEqual(["codex-b"]);
});

test("no effective change sends nothing but still versions the table", () => {
  const { service, room } = roomWithAgents();
  const result = service.setRoomRoles({ agent_id: "human:op", room_id: room.room_id,
    changes: [{ subject: "harness:claude", roles: ["architect"] }], notify: () => ({ body: "unused", to_agent_ids: [] }) });
  expect(result).toEqual({ version: 1, event_seq: null, recipients: [] });
});

test("role notices compare with the state inside the write transaction", () => {
  const { service, room } = roomWithAgents();
  service.setRoomRoles({ agent_id: "human:op", room_id: room.room_id,
    changes: [{ subject: "agent:codex:b", roles: ["tester"] }],
    notify: () => ({ body: "unused", to_agent_ids: [] }) });
  let observed: { before: RoomRoleAssignment[]; assignments: RoomRoleAssignment[] } | undefined;
  service.setRoomRoles({ agent_id: "human:op", room_id: room.room_id,
    changes: [{ subject: "agent:codex:b", roles: ["reviewer"] }],
    notify: ({ before, assignments }) => {
      observed = { before, assignments };
      return { body: "unused", to_agent_ids: [] };
    } });
  expect(observed).toEqual({
    before: [{ subject: "agent:codex:b", roles: ["tester"] }],
    assignments: [{ subject: "agent:codex:b", roles: ["reviewer"] }]
  });
});
