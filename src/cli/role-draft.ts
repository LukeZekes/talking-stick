import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import type { DerivedIdentity } from "../identity.js";
import { resolveInstructionPaths, type InstructionOptions } from "../instructions.js";
import {
  definitionMap,
  effectiveSharedInstructions,
  loadRoleDefinitions,
  parseRoleDefinitions,
  parseRoleDefinitionsDetailed,
  replaceRolesSection,
  stripRolesSection,
  updateRoleDefinitionMarkdown
} from "../role-definitions.js";
import {
  effectiveRoles,
  harnessOf,
  readUserRoleDefaults,
  readUserRoleDefaultsStrict,
  renderRoleBlock,
  userRoleDefaultsPath,
  type RoleSubject,
  type RoomRoleAssignment
} from "../roles.js";
import { liveAgents } from "./role-commands.js";
import type { Runtime } from "./runtime.js";

// One editing session of the /roles grid: room assignments, harness
// defaults, role definitions, and the project's shared instructions, applied
// together so agents hear about all of it once. Nothing is written until
// applyRoleDraft; previewRoleDraft computes the same recipients first.

export interface RoleDraft {
  /** Room assignments in the draft's room. */
  changes?: Array<{ subject: RoleSubject; roles: string[] | null }>;
  /** Harness → roles in the user's defaults (all rooms); null clears back to bundled. */
  defaults?: Record<string, string[] | null>;
  /** Project role definitions; null removes the project override. */
  definitions?: Record<string, string | null>;
  /** Project instructions text outside "## Roles". */
  sharedInstructions?: string;
}

export interface RoleRecipients {
  room_id: string;
  canonical_path: string;
  expected_version: number;
  /** agent → what changed for it */
  agents: Map<string, string[]>;
}

export interface RoleDraftPreview {
  rooms: RoleRecipients[];
  summary: string;
  /** The project instructions file the draft writes, and its new text. */
  project: { path: string; before: string; after: string } | null;
  /** The user defaults after the draft. */
  defaults: { path: string; before: Record<string, string[]>; after: Record<string, string[]> } | null;
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function applyAssignmentChanges(assignments: readonly RoomRoleAssignment[], changes: RoleDraft["changes"]): RoomRoleAssignment[] {
  const next = new Map(assignments.map((entry) => [entry.subject, entry.roles]));
  for (const change of changes ?? []) {
    if (change.roles === null) next.delete(change.subject);
    else next.set(change.subject, change.roles);
  }
  return [...next].map(([subject, roles]) => ({ subject, roles }));
}

/** What a draft would change, room by room, without writing anything. */
export function previewRoleDraft(runtime: Runtime, roomId: string, draft: RoleDraft, options: InstructionOptions = {}): RoleDraftPreview {
  const room = runtime.commands.getRoomState({ room_id: roomId }).room;
  const projectPath = resolveInstructionPaths({ ...options, contextPath: room.canonical_path }).project;

  let project: RoleDraftPreview["project"] = null;
  if (draft.definitions || draft.sharedInstructions !== undefined) {
    const before = readFile(projectPath);
    const parsed = parseRoleDefinitionsDetailed(before);
    if (parsed.problems.length) throw new Error(`Fix the "## Roles" section of ${projectPath} first: ${parsed.problems.join("; ")}.`);
    // The file's definitions with the draft's edits, under the draft's (or
    // the file's) shared text.
    let withRoles = before;
    for (const [name, text] of Object.entries(draft.definitions ?? {})) withRoles = updateRoleDefinitionMarkdown(withRoles, name, text);
    const shared = draft.sharedInstructions !== undefined ? stripRolesSection(draft.sharedInstructions) : stripRolesSection(before);
    project = { path: projectPath, before, after: replaceRolesSection(shared, parseRoleDefinitions(withRoles)) };
  }

  const defaultsBefore = draft.defaults ? readUserRoleDefaultsStrict(options) : readUserRoleDefaults(options);
  let defaults: RoleDraftPreview["defaults"] = null;
  if (draft.defaults) {
    const after = { ...defaultsBefore };
    for (const [harness, roles] of Object.entries(draft.defaults)) {
      if (roles === null) delete after[harness];
      else after[harness] = roles;
    }
    defaults = { path: userRoleDefaultsPath(options), before: defaultsBefore, after };
  }

  const rooms: RoleRecipients[] = [];
  for (const candidate of runtime.commands.listRooms({}).rooms.filter((entry) => entry.state !== "closed")) {
    const isDraftRoom = candidate.room_id === roomId;
    const sharesProject = project !== null &&
      resolveInstructionPaths({ ...options, contextPath: candidate.canonical_path }).project === projectPath;
    if (!isDraftRoom && !sharesProject && !defaults) continue;
    const context = { ...options, contextPath: candidate.canonical_path };
    const { assignments, version } = runtime.commands.getRoomRoles({ room_id: candidate.room_id });
    const assignmentsAfter = isDraftRoom ? applyAssignmentChanges(assignments, draft.changes) : assignments;
    const defsBefore = definitionMap(loadRoleDefinitions(context));
    const defsAfter = sharesProject ? definitionMap(loadRoleDefinitions(context, { projectText: project!.after })) : defsBefore;
    const agents = new Map<string, string[]>();
    for (const agent of liveAgents(runtime, candidate.room_id)) {
      const reasons: string[] = [];
      const rolesBefore = effectiveRoles(agent, assignments, defaultsBefore).roles;
      const rolesAfter = effectiveRoles(agent, assignmentsAfter, defaults?.after ?? defaultsBefore).roles;
      for (const role of rolesAfter) if (!rolesBefore.includes(role)) reasons.push(`+${role}`);
      for (const role of rolesBefore) if (!rolesAfter.includes(role)) reasons.push(`−${role}`);
      for (const role of rolesAfter) {
        if (rolesBefore.includes(role) && defsBefore.get(role) !== defsAfter.get(role)) reasons.push(`${role} redefined`);
      }
      if (sharesProject && draft.sharedInstructions !== undefined) {
        const harness = harnessOf(agent);
        if (effectiveSharedInstructions(harness, context) !== effectiveSharedInstructions(harness, context, { projectText: project!.after })) {
          reasons.push("instructions changed");
        }
      }
      if (reasons.length) agents.set(agent, reasons);
    }
    if (agents.size || (isDraftRoom && (draft.changes?.length ?? 0) > 0)) {
      rooms.push({ room_id: candidate.room_id, canonical_path: candidate.canonical_path, expected_version: version, agents });
    }
  }

  const told = rooms.reduce((total, entry) => total + entry.agents.size, 0);
  const parts: string[] = [];
  for (const entry of rooms) for (const [agent, reasons] of entry.agents) parts.push(`${agent} ${reasons.join(", ")}`);
  const summary = told === 0
    ? "Roles saved; no agent's roles or instructions changed."
    : `Roles applied; told ${told} agent${told === 1 ? "" : "s"}${rooms.length > 1 ? ` in ${rooms.length} rooms` : ""}: ${parts.join("; ")}.`;
  return { rooms, summary, project, defaults };
}

export interface RoleDraftResult {
  /** The draft room's new roles version. */
  version: number;
  rooms: Array<{ room_id: string; version: number; event_seq: number | null; recipients: string[] }>;
  summary: string;
}

/**
 * Writes the draft. Files first, after checking nobody changed them since
 * `base`; then every affected room in one database transaction with its
 * notice. If that transaction fails, the files are put back; once it commits,
 * the files stay and wake delivery is retried later from the durable events.
 */
export async function applyRoleDraft(
  runtime: Runtime,
  identity: DerivedIdentity,
  roomId: string,
  draft: RoleDraft,
  options: InstructionOptions & { base?: { projectText?: string; defaults?: Record<string, string[]>; versions?: Record<string, number> } } = {}
): Promise<RoleDraftResult> {
  const preview = previewRoleDraft(runtime, roomId, draft, options);
  if (preview.project && options.base?.projectText !== undefined && preview.project.before !== options.base.projectText) {
    throw new Error(`${preview.project.path} changed since the editor opened; reopen /roles to start from the current file.`);
  }
  if (preview.defaults && options.base?.defaults !== undefined &&
      JSON.stringify(preview.defaults.before) !== JSON.stringify(options.base.defaults)) {
    throw new Error("Harness defaults changed since the editor opened; reopen /roles to start from the current defaults.");
  }

  let committed = false;
  const restores: Array<() => void> = [];
  const write = (file: string, text: string) => {
    const existed = fs.existsSync(file);
    const previous = existed ? fs.readFileSync(file, "utf8") : "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, text);
    restores.push(() => existed ? writeFileAtomic(file, previous) : fs.rmSync(file, { force: true }));
  };

  try {
    if (preview.project && preview.project.after !== preview.project.before) write(preview.project.path, preview.project.after);
    if (preview.defaults) write(preview.defaults.path, `${JSON.stringify(preview.defaults.after, null, 2)}\n`);

    const results = runtime.commands.setRoomRolesBatch(identity, {
      rooms: preview.rooms.map((entry) => ({
        room_id: entry.room_id,
        expected_version: options.base?.versions?.[entry.room_id] ?? entry.expected_version,
        changes: entry.room_id === roomId ? draft.changes ?? [] : [],
        notify: ({ version, assignments }) => ({
          to_agent_ids: [...entry.agents.keys()],
          body: roleNotice({ runtime, room: entry, version, assignments, defaults: preview.defaults?.after, options })
        })
      }))
    });
    committed = true;
    // Committed: wake parked recipients now rather than at a later flush.
    for (const entry of results) {
      try { await runtime.commands.flushWakes(entry.room_id); } catch { /* wakes stay durable */ }
    }
    const draftRoom = results.find((entry) => entry.room_id === roomId);
    return {
      version: draftRoom?.version ?? runtime.commands.getRoomRoles({ room_id: roomId }).version,
      rooms: results,
      summary: preview.summary
    };
  } catch (error) {
    for (const restore of committed ? [] : restores.reverse()) {
      try { restore(); } catch { /* report the original failure */ }
    }
    throw error;
  }
}

function roleNotice(input: {
  runtime: Runtime;
  room: RoleRecipients;
  version: number;
  assignments: RoomRoleAssignment[];
  defaults?: Record<string, string[]>;
  options: InstructionOptions;
}): string {
  const defaults = input.defaults ?? readUserRoleDefaults(input.options);
  const definitions = definitionMap(loadRoleDefinitions({ ...input.options, contextPath: input.room.canonical_path }));
  const agents = liveAgents(input.runtime, input.room.room_id);
  const lines = [
    `[roles v${input.version}] Your roles or their definitions changed. This applies from your next turn; it never changes who holds the stick.`,
    renderRoleBlock({ self: null, agents, assignments: input.assignments, userDefaults: defaults, version: input.version, definitions })
  ];
  // The full text of every role a recipient now holds whose meaning is new to it.
  const changed = new Set<string>();
  let instructions = false;
  for (const reasons of input.room.agents.values()) {
    for (const reason of reasons) {
      if (reason.startsWith("+")) changed.add(reason.slice(1));
      else if (reason.endsWith(" redefined")) changed.add(reason.slice(0, -" redefined".length));
      else if (reason === "instructions changed") instructions = true;
    }
  }
  const full = [...changed].filter((role) => definitions.has(role));
  if (full.length) lines.push("", "Role definitions:", ...full.flatMap((role) => [`### ${role}`, definitions.get(role)!]));
  if (instructions) lines.push("", "The shared instructions changed; run `tt instructions show --json` to read them.");
  return lines.join("\n");
}

