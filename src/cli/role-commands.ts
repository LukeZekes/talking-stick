import { definitionMap, loadRoleDefinitions } from "../role-definitions.js";
import type { DerivedIdentity } from "../identity.js";
import {
  BUNDLED_ROLE_DEFAULTS,
  ROLE_PALETTE,
  effectiveRoles,
  harnessOf,
  normalizeRole,
  readUserRoleDefaults,
  renderRoleBlock,
  writeUserRoleDefault,
  type RoleSubject,
  type RoomRoleAssignment
} from "../roles.js";
import { HUMAN_CHAT_SESSION_KIND, type PathRoom } from "../types.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, type ParsedCommand } from "./parser.js";
import { selectedRoom } from "./room-selector.js";
import type { Runtime } from "./runtime.js";
import { pickDeepestRoom } from "./session.js";

/** Live agents in a room (chat consoles and ended processes excluded). */
export function liveAgents(runtime: Runtime, roomId: string): string[] {
  return runtime.commands.getRoomState({ room_id: roomId }).members
    .filter((member) => member.session_kind !== HUMAN_CHAT_SESSION_KIND && member.process_liveness !== "gone" &&
      (member.status === "active" || member.process_liveness === "alive"))
    .map((member) => member.agent_id);
}

/** The block `tt instructions show` and role notices share. */
export function roomRoleBlock(runtime: Runtime, roomId: string, self: string | null): string {
  const { version, assignments } = runtime.commands.getRoomRoles({ room_id: roomId });
  const room = runtime.commands.getRoomState({ room_id: roomId }).room;
  return renderRoleBlock({ self, agents: liveAgents(runtime, roomId), assignments, userDefaults: readUserRoleDefaults(), version,
    definitions: definitionMap(loadRoleDefinitions({ contextPath: room.canonical_path })) });
}

// Parse `architect,reviewer`, `none` ([] = deliberately no role), or `clear`
// (null = remove the assignment and fall back).
export function parseRoleList(text: string): string[] | null {
  const value = text.trim().toLowerCase();
  if (value === "clear" || value === "default") return null;
  if (value === "none" || value === "") return [];
  const roles: string[] = [];
  for (const raw of value.split(/[\s,]+/).filter(Boolean)) {
    const role = normalizeRole(raw);
    if (!role) throw new Error(`Invalid role ${JSON.stringify(raw)}: use letters, digits, and '-'.`);
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}

// `claude` → harness:claude; `claude:abc` (a member id) → agent:claude:abc.
export function parseRoleSubject(target: string): RoleSubject {
  const value = target.trim().replace(/^@/, "");
  if (!value) throw new Error("Name an agent id or a harness (claude, codex, grok).");
  return value.includes(":") ? `agent:${value}` : `harness:${value}`;
}

/**
 * Apply role changes and tell exactly the agents whose effective roles
 * changed, in one transaction. Unaffected agents get nothing.
 */
export async function applyRoleChanges(runtime: Runtime, identity: DerivedIdentity, roomId: string,
  changes: Array<{ subject: RoleSubject; roles: string[] | null }>) {
  const agents = liveAgents(runtime, roomId);
  const defaults = readUserRoleDefaults();
  const definitions = definitionMap(loadRoleDefinitions({ contextPath: runtime.commands.getRoomState({ room_id: roomId }).room.canonical_path }));
  const key = (agent: string, assignments: readonly RoomRoleAssignment[]) =>
    JSON.stringify(effectiveRoles(agent, assignments, defaults).roles);
  const result = runtime.commands.setRoomRoles(identity, {
    room_id: roomId,
    changes,
    notify: ({ version, assignments, before }) => {
      const changed = agents.filter((agent) => key(agent, before) !== key(agent, assignments));
      return {
        to_agent_ids: changed,
        body: `[roles v${version}] Your role in this room changed. It applies from your next turn; it never changes who holds the stick.\n` +
          renderRoleBlock({ self: null, agents, assignments, userDefaults: defaults, version, definitions }) +
          [...new Set(changed.flatMap(agent => effectiveRoles(agent, assignments, defaults).roles))]
            .map(role => `\n\n### ${role}\n${definitions.get(role) ?? role}`).join("")
      };
    }
  });
  // Committed: wake parked recipients now rather than at some later flush.
  try { await runtime.commands.flushWakes(roomId); } catch { /* wakes stay durable */ }
  const summary = result.recipients.length
    ? `Roles v${result.version} applied; told ${result.recipients.join(", ")}.`
    : `Roles v${result.version} applied; no agent's roles changed.`;
  return { ...result, summary };
}

function targetRoom(runtime: Runtime, parsed: ParsedCommand): PathRoom {
  const room = selectedRoom(runtime, parsed) ??
    pickDeepestRoom(runtime.commands.listRooms({ context_path: getStringOption(parsed, "path") ?? process.cwd() }).rooms);
  if (!room) throw new Error("No room found for this path. Run `tt join` first, or pass --in <room>.");
  return room;
}

// `tt roles` (show), `tt roles set <agent|harness> <roles|none|clear>`,
// `tt roles default <harness> <roles|clear>`.
export async function handleRolesCommand(runtime: Runtime, parsed: ParsedCommand): Promise<void> {
  const [action = "show", target, ...rest] = parsed.positionals;
  if (action === "default") {
    if (!target || target.includes(":")) throw new Error("Usage: tt roles default <harness> <roles|none|clear>");
    const roles = parseRoleList(rest.join(" "));
    const open = runtime.commands.listRooms({}).rooms.find(room => room.state !== "closed");
    if (open) {
      const { applyRoleDraft } = await import("./role-draft.js");
      const result = await applyRoleDraft(runtime, deriveCliIdentity(parsed), open.room_id, { defaults: { [target]: roles } });
      printResult(parsed, { status: roles === null ? "cleared" : "saved", harness: target, roles: roles ?? BUNDLED_ROLE_DEFAULTS[target] ?? [], ...result }, () => result.summary);
      return;
    }
    writeUserRoleDefault(target, roles);
    const effective = roles ?? BUNDLED_ROLE_DEFAULTS[target] ?? [];
    printResult(parsed, { status: roles === null ? "cleared" : "saved", harness: target, roles: effective },
      () => `Default roles for ${target}: ${effective.join(", ") || "none"}${roles === null ? " (bundled)" : ""}.`);
    return;
  }
  const room = targetRoom(runtime, parsed);
  if (action === "set") {
    if (!target) throw new Error("Usage: tt roles set <agent|harness> <roles|none|clear>");
    const identity = deriveCliIdentity(parsed);
    const result = await applyRoleChanges(runtime, identity, room.room_id, [{ subject: parseRoleSubject(target), roles: parseRoleList(rest.join(" ")) }]);
    printResult(parsed, { status: "applied", room_id: room.room_id, ...result },
      () => `Roles v${result.version} applied; told ${result.recipients.join(", ") || "nobody (no effective change)"}.`);
    return;
  }
  if (action !== "show") throw new Error("Usage: tt roles [show] | set <agent|harness> <roles|none|clear> | default <harness> <roles|none|clear>");
  const identity = deriveCliIdentity(parsed);
  const { version, assignments } = runtime.commands.getRoomRoles({ room_id: room.room_id });
  const defaults = readUserRoleDefaults();
  const agents = liveAgents(runtime, room.room_id).map((agent) => ({ agent_id: agent, harness: harnessOf(agent), ...effectiveRoles(agent, assignments, defaults) }));
  printResult(parsed, { room_id: room.room_id, version, assignments, agents, palette: Object.fromEntries(definitionMap(loadRoleDefinitions({ contextPath: room.canonical_path }))) },
    () => renderRoleBlock({ self: agents.some((agent) => agent.agent_id === identity.agent_id) ? identity.agent_id : null,
      agents: agents.map((agent) => agent.agent_id), assignments, userDefaults: defaults, version, definitions: definitionMap(loadRoleDefinitions({ contextPath: room.canonical_path })) }));
}
