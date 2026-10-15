import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { resolveDataDir, type ResolveDataDirOptions } from "./config.js";

// Roles describe responsibility in a room. They never grant write authority:
// only the stick does.
export const ROLE_PALETTE: Record<string, string> = {
  architect: "architecture, drafting, and large-context synthesis",
  implementer: "precise implementation",
  reviewer: "independent review and cross-checks",
  tester: "tests and verification",
  scribe: "notes, docs, and handoff summaries"
};

// Bundled defaults per harness, matching the long-standing instruction text.
export const BUNDLED_ROLE_DEFAULTS: Record<string, string[]> = {
  claude: ["architect"],
  codex: ["implementer"],
  grok: ["implementer", "reviewer"]
};

/** A room assignment: an exact agent wins over its harness. */
export type RoleSubject = `agent:${string}` | `harness:${string}`;

export interface RoomRoleAssignment {
  subject: RoleSubject;
  /** An empty list is a deliberate "no role", not "unset". */
  roles: string[];
}

export function harnessOf(agentId: string): string {
  return agentId.split(":", 1)[0];
}

export function normalizeRole(role: string): string | null {
  const name = role.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,31}$/.test(name) ? name : null;
}

export function describeRole(role: string): string {
  return ROLE_PALETTE[role] ?? role;
}

export function userRoleDefaultsPath(options: ResolveDataDirOptions = {}): string {
  return path.join(resolveDataDir(options), "roles.json");
}

// Missing or unreadable defaults fall back to the bundled ones; a role file
// must never stop a join or an instructions read.
export function readUserRoleDefaults(options: ResolveDataDirOptions = {}): Record<string, string[]> {
  try {
    const parsed = JSON.parse(fs.readFileSync(userRoleDefaultsPath(options), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string[]> = {};
    for (const [harness, roles] of Object.entries(parsed)) {
      if (Array.isArray(roles)) {
        result[harness] = roles.map((role) => normalizeRole(String(role))).filter((role): role is string => role !== null);
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** `roles: null` removes the override so the bundled default applies again. */
export function writeUserRoleDefault(harness: string, roles: string[] | null, options: ResolveDataDirOptions = {}): void {
  // Reads fail open, but a save must never replace a file it could not parse:
  // that would silently drop the operator's other defaults.
  const file0 = userRoleDefaultsPath(options);
  if (fs.existsSync(file0)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file0, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    } catch (error) {
      throw new Error(`Refusing to overwrite ${file0}: ${error instanceof Error ? error.message : String(error)}. Fix or remove it first.`);
    }
  }
  const current = readUserRoleDefaults(options);
  if (roles === null) delete current[harness];
  else current[harness] = roles;
  const file = userRoleDefaultsPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
}

// Precedence: exact agent row > harness row in the room > user default >
// bundled default. An explicit empty assignment stops the fallthrough.
export function effectiveRoles(
  agentId: string,
  assignments: readonly RoomRoleAssignment[],
  userDefaults: Record<string, string[]>
): { roles: string[]; source: "agent" | "room" | "user" | "bundled" | "none" } {
  const harness = harnessOf(agentId);
  const exact = assignments.find((entry) => entry.subject === `agent:${agentId}`);
  if (exact) return { roles: exact.roles, source: "agent" };
  const byHarness = assignments.find((entry) => entry.subject === `harness:${harness}`);
  if (byHarness) return { roles: byHarness.roles, source: "room" };
  if (userDefaults[harness]) return { roles: userDefaults[harness], source: "user" };
  if (BUNDLED_ROLE_DEFAULTS[harness]) return { roles: BUNDLED_ROLE_DEFAULTS[harness], source: "bundled" };
  return { roles: [], source: "none" };
}

// The compact block an agent reads in `tt instructions show` and in the
// message sent when roles change. Same generator for both, so they never differ.
export function renderRoleBlock(input: {
  self: string | null;
  agents: readonly string[];
  assignments: readonly RoomRoleAssignment[];
  userDefaults: Record<string, string[]>;
  version: number;
}): string {
  const describe = (roles: string[]) => roles.length === 0 ? "no assigned role" : roles.map((role) => `${role} (${describeRole(role)})`).join("; ");
  const lines = [`Roles in this room (version ${input.version}). Roles describe responsibility only; only the stick grants write authority.`];
  if (input.self) {
    lines.push(`- You (${input.self}): ${describe(effectiveRoles(input.self, input.assignments, input.userDefaults).roles)}`);
  }
  for (const agent of input.agents) {
    if (agent === input.self) continue;
    lines.push(`- ${agent}: ${describe(effectiveRoles(agent, input.assignments, input.userDefaults).roles)}`);
  }
  return lines.join("\n");
}
