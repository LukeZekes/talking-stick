import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { applyRoleDraft, previewRoleDraft } from "../src/cli/role-draft.js";
import { roomRoleBlock } from "../src/cli/role-commands.js";
import type { Runtime } from "../src/cli/runtime.js";
import { TalkingStickService } from "../src/service.js";
import type { DerivedIdentity } from "../src/identity.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

// Two rooms in one repository: the root (claude, grok) and a declared api
// room (codex). Both share <repo>/.talking-stick/instructions.md.
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-role-draft-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "api", ".talking-stick"), { recursive: true });
  fs.writeFileSync(path.join(repo, "api", ".talking-stick", "room.toml"), 'name = "api"\n');
  execFileSync("git", ["init", "-q", repo]);
  const data = path.join(root, "data");
  const service = new TalkingStickService({ dbPath: path.join(root, "rooms.sqlite"), policy: { waitForEventsPollMs: 1 } });
  cleanups.push(() => service.close());
  const main = service.joinPath({ agent_id: "claude:a", context_path: repo });
  service.joinPath({ agent_id: "grok:c", context_path: repo });
  const api = service.joinPath({ agent_id: "codex:b", context_path: path.join(repo, "api") });
  let failBatch = false;
  const runtime = { commands: {
    getRoomState: (input: { room_id: string }) => service.getRoomState(input),
    listRooms: () => service.listRooms({}),
    getRoomRoles: (input: { room_id: string }) => service.getRoomRoles(input),
    setRoomRolesBatch: (identity: DerivedIdentity, input: Parameters<TalkingStickService["setRoomRolesBatch"]>[0]) => {
      if (failBatch) throw new Error("database is locked");
      return service.setRoomRolesBatch({ ...input, agent_id: identity.agent_id });
    },
    flushWakes: async () => {}
  } } as unknown as Runtime;
  const options = { env: { ...process.env, TALKING_STICK_DATA_DIR: data } };
  const operator = { agent_id: "human:op", process_metadata: {} } as unknown as DerivedIdentity;
  const notices = (agent: string, roomId: string) => service.getRecentRoomEvents({ room_id: roomId, limit: 50, event_types: ["message_sent"] })
    .filter((event) => event.to_agent_id === agent || ((event.payload as { recipients?: string[] }).recipients ?? []).includes(agent))
    .map((event) => (event.payload as { body: string }).body);
  return { repo, data, service, runtime, options, operator, main, api, notices, setFail: (value: boolean) => { failBatch = value; } };
}

test("a definition change reaches only that role's holders, with the new text", async () => {
  const f = fixture();
  const draft = { definitions: { architect: "Owns the plan and the final call on structure." } };
  const preview = previewRoleDraft(f.runtime, f.main.room_id, draft, f.options);
  expect(preview.rooms.flatMap((room) => [...room.agents])).toEqual([["claude:a", ["architect redefined"]]]);
  await applyRoleDraft(f.runtime, f.operator, f.main.room_id, draft, f.options);
  expect(f.notices("claude:a", f.main.room_id).at(-1)).toContain("### architect\nOwns the plan and the final call on structure.");
  expect(roomRoleBlock(f.runtime, f.main.room_id, "claude:a")).toContain("Owns the plan and the final call on structure.");
  expect(f.notices("grok:c", f.main.room_id)).toEqual([]);
  expect(f.notices("codex:b", f.api.room_id)).toEqual([]);
  expect(fs.readFileSync(path.join(f.repo, ".talking-stick", "instructions.md"), "utf8")).toContain("### architect");
});

test("shared instruction changes reach every room that reads the same file", async () => {
  const f = fixture();
  const preview = previewRoleDraft(f.runtime, f.main.room_id, { sharedInstructions: "# Local\n\nAlways run the linter.\n" }, f.options);
  const reached = preview.rooms.flatMap((room) => [...room.agents.keys()]).sort();
  expect(reached).toEqual(["claude:a", "codex:b", "grok:c"]);
  expect(preview.summary).toMatch(/in 2 rooms/);
});

test("a harness default reaches inheriting agents in other rooms, not overridden ones", async () => {
  const f = fixture();
  // codex in api is explicitly assigned, so a codex default must not touch it.
  await applyRoleDraft(f.runtime, f.operator, f.api.room_id, { changes: [{ subject: "agent:codex:b", roles: ["tester"] }] }, f.options);
  const preview = previewRoleDraft(f.runtime, f.main.room_id, { defaults: { grok: ["scribe"], codex: ["reviewer"] } }, f.options);
  expect(preview.rooms.flatMap((room) => [...room.agents])).toEqual([["grok:c", ["+scribe", "−implementer", "−reviewer"]]]);
  await applyRoleDraft(f.runtime, f.operator, f.main.room_id, { defaults: { grok: ["scribe"] } }, f.options);
  expect(JSON.parse(fs.readFileSync(path.join(f.data, "roles.json"), "utf8"))).toEqual({ grok: ["scribe"] });
  expect(f.notices("grok:c", f.main.room_id).at(-1)).toContain("[roles v");
});

test("a failed database write puts the files back; a stale base is refused before writing", async () => {
  const f = fixture();
  const file = path.join(f.repo, ".talking-stick", "instructions.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Local\n");
  f.setFail(true);
  await expect(applyRoleDraft(f.runtime, f.operator, f.main.room_id, { definitions: { architect: "New." }, defaults: { grok: [] } }, f.options))
    .rejects.toThrow(/database is locked/);
  expect(fs.readFileSync(file, "utf8")).toBe("# Local\n");
  expect(fs.existsSync(path.join(f.data, "roles.json"))).toBe(false);
  f.setFail(false);
  await expect(applyRoleDraft(f.runtime, f.operator, f.main.room_id, { definitions: { architect: "New." } },
    { ...f.options, base: { projectText: "# Something else\n" } })).rejects.toThrow(/changed since the editor opened/);
  expect(fs.readFileSync(file, "utf8")).toBe("# Local\n");
});

test("malformed defaults are never overwritten by a draft", async () => {
  const f = fixture();
  const file = path.join(f.data, "roles.json");
  fs.mkdirSync(f.data, { recursive: true });
  fs.writeFileSync(file, "{ broken");
  await expect(applyRoleDraft(f.runtime, f.operator, f.main.room_id, { defaults: { grok: [] } }, f.options)).rejects.toThrow(/Refusing to overwrite/);
  expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
});

test("a newer assignment rejects an old draft and restores instruction files", async () => {
  const f = fixture();
  const original = f.service.getRoomRoles({ room_id: f.main.room_id }).version;
  await applyRoleDraft(f.runtime, f.operator, f.main.room_id, { changes: [{ subject: "agent:claude:a", roles: ["architect", "reviewer"] }] }, f.options);
  const count = f.notices("claude:a", f.main.room_id).length;
  await expect(applyRoleDraft(f.runtime, f.operator, f.main.room_id,
    { definitions: { architect: "stale definition" }, defaults: { grok: [] } },
    { ...f.options, base: { versions: { [f.main.room_id]: original } } })).rejects.toThrow(/changed since the editor opened/);
  expect(fs.existsSync(path.join(f.repo, ".talking-stick", "instructions.md"))).toBe(false);
  expect(fs.existsSync(path.join(f.data, "roles.json"))).toBe(false);
  expect(f.notices("claude:a", f.main.room_id)).toHaveLength(count);
});
