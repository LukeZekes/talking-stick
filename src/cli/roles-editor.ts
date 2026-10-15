import { ROLE_PALETTE, effectiveRoles, harnessOf, type RoleSubject, type RoomRoleAssignment } from "../roles.js";
import type { ChatModalKey } from "./chat-input.js";
import { sanitizeChatText, type ChatFormatContext } from "./chat-format.js";

export interface RolesEditorRow {
  agent_id: string;
  original: string[];
  roles: string[];
}

export interface RolesEditorState {
  rows: RolesEditorRow[];
  columns: string[];
  row: number;
  col: number;
  version: number;
  /** One transient line, e.g. "codex defaults saved". */
  notice: string | null;
}

export type RolesEditorAction =
  | { kind: "none" }
  | { kind: "apply"; changes: Array<{ subject: RoleSubject; roles: string[] }> }
  | { kind: "cancel" }
  | { kind: "save_default"; harness: string; roles: string[] };

// Rows are the room's live agents with their effective roles; columns are the
// palette plus any custom role already in use.
export function createRolesEditor(input: {
  agents: readonly string[];
  assignments: readonly RoomRoleAssignment[];
  userDefaults: Record<string, string[]>;
  version: number;
}): RolesEditorState {
  const rows = input.agents.map((agent) => {
    const roles = effectiveRoles(agent, input.assignments, input.userDefaults).roles;
    return { agent_id: agent, original: [...roles], roles: [...roles] };
  });
  const extra = [...new Set(rows.flatMap((row) => row.roles))].filter((role) => !(role in ROLE_PALETTE)).sort();
  return { rows, columns: [...Object.keys(ROLE_PALETTE), ...extra], row: 0, col: 0, version: input.version, notice: null };
}

function changed(row: RolesEditorRow): boolean {
  return [...row.roles].sort().join(",") !== [...row.original].sort().join(",");
}

export function rolesEditorChanges(state: RolesEditorState): Array<{ subject: RoleSubject; roles: string[] }> {
  return state.rows.filter(changed).map((row) => ({
    subject: `agent:${row.agent_id}` as RoleSubject,
    // Keep palette order so the stored list is stable.
    roles: state.columns.filter((column) => row.roles.includes(column))
  }));
}

export function rolesEditorKey(state: RolesEditorState, key: ChatModalKey): { state: RolesEditorState; action: RolesEditorAction } {
  const rowCount = state.rows.length;
  const next = { ...state, notice: null as string | null };
  switch (key) {
    case "up": return { state: { ...next, row: rowCount ? (state.row - 1 + rowCount) % rowCount : 0 }, action: { kind: "none" } };
    case "down": return { state: { ...next, row: rowCount ? (state.row + 1) % rowCount : 0 }, action: { kind: "none" } };
    case "left": return { state: { ...next, col: (state.col - 1 + state.columns.length) % state.columns.length }, action: { kind: "none" } };
    case "right": return { state: { ...next, col: (state.col + 1) % state.columns.length }, action: { kind: "none" } };
    case "space": {
      const target = state.rows[state.row];
      if (!target) return { state: next, action: { kind: "none" } };
      const role = state.columns[state.col];
      const roles = target.roles.includes(role) ? target.roles.filter((entry) => entry !== role) : [...target.roles, role];
      const rows = state.rows.map((row, index) => index === state.row ? { ...row, roles } : row);
      return { state: { ...next, rows }, action: { kind: "none" } };
    }
    case "default": {
      const target = state.rows[state.row];
      if (!target) return { state: next, action: { kind: "none" } };
      const harness = harnessOf(target.agent_id);
      const roles = state.columns.filter((column) => target.roles.includes(column));
      return { state: { ...next, notice: `Saved ${roles.join(", ") || "no role"} as the ${harness} default.` },
        action: { kind: "save_default", harness, roles } };
    }
    case "enter": return { state: next, action: { kind: "apply", changes: rolesEditorChanges(state) } };
    case "escape": return { state: next, action: { kind: "cancel" } };
  }
}

export function renderRolesEditor(state: RolesEditorState, context: ChatFormatContext): string[] {
  const paint = (code: string, text: string) => context.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const nameWidth = Math.min(28, Math.max(6, ...state.rows.map((row) => row.agent_id.length)));
  const cell = (on: boolean) => on ? "[x]" : "[ ]";
  const header = " ".repeat(nameWidth + 4) + state.columns.map((column) => column.padEnd(Math.max(column.length, 3) + 2)).join("");
  const lines = [
    paint("1", `Roles (v${state.version})`) + paint("2", "  ↑↓ member · ←→ role · Space toggle · d save as harness default · Enter apply · Esc cancel"),
    paint("2", header)
  ];
  if (state.rows.length === 0) lines.push(paint("2", "  No live agents in this room."));
  state.rows.forEach((row, rowIndex) => {
    const name = sanitizeChatText(row.agent_id).slice(0, nameWidth).padEnd(nameWidth);
    const cells = state.columns.map((column, colIndex) => {
      const text = cell(row.roles.includes(column)).padEnd(Math.max(column.length, 3) + 2);
      return rowIndex === state.row && colIndex === state.col ? paint("7", text.trimEnd()) + text.slice(text.trimEnd().length) : text;
    }).join("");
    lines.push(`${rowIndex === state.row ? "›" : " "} ${name}${changed(row) ? "*" : " "} ${cells}`);
  });
  if (state.notice) lines.push(paint("2", state.notice));
  return lines;
}
