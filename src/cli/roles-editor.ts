import { BUNDLED_ROLE_DEFAULTS, ROLE_PALETTE, effectiveRoles, harnessOf, type RoleSubject, type RoomRoleAssignment } from "../roles.js";
import type { RoleDefinition } from "../role-definitions.js";
import type { RoleDraft } from "./role-draft.js";
import type { ChatModalKey } from "./chat-input.js";
import { sanitizeChatText, type ChatFormatContext } from "./chat-format.js";
import { textWidth, truncateStyled, wrapStyledLine } from "./chat-view.js";
import { highlightChatBody } from "./chat-highlight.js";

export interface RolesEditorRow {
  subject: RoleSubject;
  label: string;
  agent_id: string;
  original: string[];
  roles: string[];
  source: string;
  edited: boolean;
  reset: boolean;
}
export interface RolesEditorState {
  rows: RolesEditorRow[];
  defaultRows: RolesEditorRow[];
  columns: string[];
  definitions: RoleDefinition[];
  globalDefinitions: RoleDefinition[];
  originalDefinitions: RoleDefinition[];
  assignments: RoomRoleAssignment[];
  userDefaults: Record<string, string[]>;
  row: number;
  col: number;
  version: number;
  tab: "room" | "defaults";
  view: "grid" | "preview" | "help" | "notifications";
  scroll: number;
  confirmDiscard: boolean;
  notice: string | null;
  draft: RoleDraft;
  notifications: string[];
  preview: string;
  rejectedText?: { key: string; text: string };
}
export type RolesEditorAction =
  | { kind: "none" }
  | { kind: "apply"; changes: NonNullable<RoleDraft["changes"]> }
  | { kind: "cancel" }
  | { kind: "edit_role"; name: string }
  | { kind: "new_role" }
  | { kind: "edit_instructions" }
  | { kind: "preview"; agent: string }
  | { kind: "undo" };

const same = (a: string[], b: string[]) => [...a].sort().join(",") === [...b].sort().join(",");
const clean = (text: string) => sanitizeChatText(text).replace(/\n/g, " ");
const COLORS = [75, 214, 170, 114, 203, 229, 147, 81];

export function createRolesEditor(input: {
  agents: readonly string[];
  assignments: readonly RoomRoleAssignment[];
  userDefaults: Record<string, string[]>;
  version: number;
  definitions?: RoleDefinition[];
  globalDefinitions?: RoleDefinition[];
  nameOf?: (id: string) => string;
}): RolesEditorState {
  const definitions = input.definitions ?? Object.entries(ROLE_PALETTE).map(([name, text]) => ({ name, text, source: "bundled" as const }));
  const rows = input.agents.map((agent): RolesEditorRow => {
    const { roles, source } = effectiveRoles(agent, input.assignments, input.userDefaults);
    const name = input.nameOf?.(agent) ?? agent;
    return { subject: `agent:${agent}`, label: name === agent ? agent : `${name} · ${agent}`, agent_id: agent,
      original: [...roles], roles: [...roles], source, edited: false, reset: false };
  });
  const harnesses = [...new Set(["claude", "codex", "grok", "antigravity", "opencode", ...Object.keys(input.userDefaults)])];
  const defaultRows = harnesses.map((harness): RolesEditorRow => {
    const roles = input.userDefaults[harness] ?? BUNDLED_ROLE_DEFAULTS[harness] ?? [];
    return { subject: `harness:${harness}`, label: harness, agent_id: `${harness}:`, original: [...roles], roles: [...roles],
      source: input.userDefaults[harness] ? "user" : "bundled", edited: false, reset: false };
  });
  const state: RolesEditorState = { rows, defaultRows, definitions, originalDefinitions: definitions,
    globalDefinitions: input.globalDefinitions ?? definitions.filter(d => d.source !== "project"),
    assignments: [...input.assignments], userDefaults: input.userDefaults,
    columns: [], row: 0, col: 0, version: input.version, tab: "room", view: "grid", scroll: 0,
    confirmDiscard: false, notice: null, draft: {}, notifications: [], preview: "" };
  return refreshRolesEditor(state);
}

export function rolesEditorRows(state: RolesEditorState): RolesEditorRow[] {
  return state.tab === "room" ? state.rows : state.defaultRows;
}

/** Refresh inherited rows without turning a defaults change into a session override. */
export function refreshRolesEditor(state: RolesEditorState): RolesEditorState {
  const defaults = { ...state.userDefaults };
  for (const row of state.defaultRows) {
    if (!row.edited) continue;
    if (row.reset) delete defaults[harnessOf(row.agent_id)];
    else defaults[harnessOf(row.agent_id)] = row.roles;
  }
  const rows = state.rows.map(row => {
    if (row.edited && !row.reset) return row;
    const assignments = row.reset ? state.assignments.filter(a => a.subject !== row.subject) : state.assignments;
    const effective = effectiveRoles(row.agent_id, assignments, defaults);
    return { ...row, roles: [...effective.roles], source: effective.source };
  });
  const definitions = state.tab === "room" ? state.definitions : state.globalDefinitions;
  const visibleRows = state.tab === "room" ? rows : state.defaultRows;
  const names = definitions.map(d => d.name);
  const extra = [...new Set(visibleRows.flatMap(row => row.roles))].filter(name => !names.includes(name)).sort();
  const columns = [...names, ...extra];
  return { ...state, rows, columns, row: Math.min(state.row, Math.max(0, visibleRows.length - 1)),
    col: Math.min(state.col, Math.max(0, columns.length - 1)) };
}

export function rolesEditorChanges(state: RolesEditorState): NonNullable<RoleDraft["changes"]> {
  return state.rows.filter(row => row.edited && ((row.reset ? state.assignments.some(a => a.subject === row.subject) : !same(row.roles, row.original))))
    .map(row => ({ subject: row.subject, roles: row.reset ? null : [...row.roles] }));
}
export function rolesEditorDraft(state: RolesEditorState): RoleDraft {
  const defaults: NonNullable<RoleDraft["defaults"]> = {};
  for (const row of state.defaultRows) if (row.edited && ((row.reset ? state.userDefaults[harnessOf(row.agent_id)] !== undefined : !same(row.roles, row.original)))) {
    defaults[harnessOf(row.agent_id)] = row.reset ? null : [...row.roles];
  }
  const draft = { ...state.draft };
  if (!Object.keys(draft.definitions ?? {}).length) delete draft.definitions;
  return { ...draft, changes: rolesEditorChanges(state), ...(Object.keys(defaults).length ? { defaults } : {}) };
}
export function rolesEditorDirty(state: RolesEditorState): boolean {
  const draft = rolesEditorDraft(state);
  return Boolean(state.rejectedText || draft.changes?.length || Object.keys(draft.defaults ?? {}).length ||
    Object.keys(draft.definitions ?? {}).length || draft.sharedInstructions !== undefined);
}

export function rolesEditorKey(state: RolesEditorState, key: ChatModalKey): { state: RolesEditorState; action: RolesEditorAction } {
  const none = (next: RolesEditorState = state) => ({ state: next, action: { kind: "none" } as RolesEditorAction });
  if (state.confirmDiscard) {
    if (key === "yes") return { state, action: { kind: "cancel" } };
    return none({ ...state, confirmDiscard: false, notice: null });
  }
  if (state.view !== "grid") {
    if (["escape", "preview", "help", "quit", "notifications"].includes(key)) return none({ ...state, view: "grid", scroll: 0 });
    if (key === "up" || key === "page_up") return none({ ...state, scroll: Math.max(0, state.scroll - (key === "up" ? 1 : 5)) });
    if (key === "down" || key === "page_down") return none({ ...state, scroll: state.scroll + (key === "down" ? 1 : 5) });
    return none();
  }
  let next = { ...state, notice: null } as RolesEditorState;
  const rows = rolesEditorRows(state);
  switch (key) {
    case "up": case "down":
      return none({ ...next, row: rows.length ? (state.row + (key === "up" ? -1 : 1) + rows.length) % rows.length : 0 });
    case "left": case "right":
      return none({ ...next, col: state.columns.length ? (state.col + (key === "left" ? -1 : 1) + state.columns.length) % state.columns.length : 0 });
    case "tab": case "default":
      return none(refreshRolesEditor({ ...next, tab: state.tab === "room" ? "defaults" : "room", row: 0, col: 0 }));
    case "space": case "reset": {
      const target = rows[state.row];
      const role = state.columns[state.col];
      if (!target || (key === "space" && !role)) return none();
      // An inherited project-specific role may be displayed in defaults only
      // because it was previously configured. Don't silently remove it.
      const updated = { ...target, edited: true, reset: key === "reset",
        roles: key === "reset" ? [...(BUNDLED_ROLE_DEFAULTS[harnessOf(target.agent_id)] ?? [])]
          : target.roles.includes(role) ? target.roles.filter(r => r !== role) : [...target.roles, role] };
      if (key === "space" && same(updated.roles, target.original)) updated.edited = false;
      const changed = rows.map((row, i) => i === state.row ? updated : row);
      next = state.tab === "room" ? { ...next, rows: changed } : { ...next, defaultRows: changed };
      return none(refreshRolesEditor(next));
    }
    case "enter": return state.rejectedText ? none({ ...next, notice: "Correct the rejected editor text first, or u discards the draft." }) : { state: next, action: { kind: "apply", changes: rolesEditorChanges(state) } };
    case "escape": case "quit":
      return rolesEditorDirty(state) ? none({ ...next, confirmDiscard: true }) : { state: next, action: { kind: "cancel" } };
    case "undo": return { state: next, action: { kind: "undo" } };
    case "notifications": return none({ ...next, view: "notifications", scroll: 0 });
    case "help": return none({ ...next, view: "help", scroll: 0 });
    case "preview": {
      const agent = rows[state.row];
      return agent ? { state: { ...next, view: "preview", scroll: 0 }, action: { kind: "preview", agent: agent.agent_id } } : none();
    }
    case "edit": case "instructions": case "no":
      if (state.tab === "defaults") return none({ ...next, notice: "Definitions are project-scoped. Tab returns to this room; user definitions: tt instructions edit --user." });
      if (key === "instructions") return { state: next, action: { kind: "edit_instructions" } };
      if (key === "no") return { state: next, action: { kind: "new_role" } };
      return state.columns[state.col] ? { state: next, action: { kind: "edit_role", name: state.columns[state.col] } } : none();
    default: return none();
  }
}

const HELP = [
  "Arrow keys select an agent/harness and role. Space toggles membership.",
  "Enter applies the entire draft, including changes in both tabs.",
  "Tab switches This room / Harness defaults (all rooms).",
  "r removes a session override, or restores bundled harness defaults.",
  "e edits the selected role definition; n creates one; i edits project instructions.",
  "The external editor uses $VISUAL, $EDITOR, or vi. Save and exit to return to the draft.",
  "p previews instructions; v lists all notifications; u undoes the whole draft; Esc/q closes (confirms if dirty).",
  "Project definitions override user definitions, which override bundled definitions.",
  "Room/session assignments override harness defaults. Only affected agents are notified.",
  "Roles describe responsibility; assigning one never grants the stick."
];

/** A fixed-height panel: navigation and draft changes never move its regions. */
export function renderRolesEditor(state: RolesEditorState, context: ChatFormatContext, maxLines = 22, maxColumns = 80): string[] {
  const height = Math.max(1, maxLines), width = Math.max(1, maxColumns);
  const paint = (code: string, text: string) => context.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const fit = (text: string, size: number) => truncateStyled(text, size) + " ".repeat(Math.max(0, size - textWidth(text)));
  const lines = Array<string>(height).fill("");
  const set = (row: number, text: string) => { if (row >= 0 && row < height) lines[row] = truncateStyled(text, width); };
  const scope = state.tab === "room" ? "This room" : "Harness defaults · all rooms";
  set(0, paint("1", `Roles v${state.version} · ${scope}`) + paint("2", rolesEditorDirty(state) ? " · unsaved" : " · saved"));
  if (height < 13 || width < 48) {
    set(Math.min(1, height - 1), "Enlarge terminal to edit roles. Esc closes; draft preserved.");
    return lines;
  }
  if (state.view !== "grid") {
    const body = (state.view === "help" ? HELP.join("\n\n") : state.view === "notifications" ? "On apply · affected agents\n\n" + (state.notifications.join("\n") || "No agent notifications.") : state.preview || "No instructions to preview.");
    const wrapped = body.split("\n").flatMap(line => wrapStyledLine(highlightChatBody(sanitizeChatText(line), { paint, agent_color: () => 75 }), width));
    const capacity = height - 3;
    const start = Math.min(state.scroll, Math.max(0, wrapped.length - capacity));
    wrapped.slice(start, start + capacity).forEach((line, i) => set(i + 1, line));
    set(height - 1, paint("2", "↑↓ / PgUp/PgDn scroll · Esc / p back"));
    return lines;
  }
  const rows = rolesEditorRows(state);
  const nameWidth = 22, colWidth = 18;
  const count = Math.max(1, Math.floor((width - nameWidth - 1) / colWidth));
  const first = Math.max(0, Math.min(state.col - count + 1, state.columns.length - count));
  const columns = state.columns.slice(first, first + count);
  set(1, fit(first ? "‹ Agents / roles" : state.tab === "room" ? "Agents / roles" : "Harness / roles", nameWidth) + columns.map((name, i) =>
    fit(paint(`38;5;${COLORS[(first + i) % COLORS.length]}${first + i === state.col ? ";1;4" : ""}`, name), colWidth)).join("") + (first + count < state.columns.length ? "›" : ""));
  const gridRows = height - 12;
  const top = Math.max(0, Math.min(state.row - gridRows + 1, rows.length - gridRows));
  rows.slice(top, top + gridRows).forEach((row, i) => {
    const marks = columns.map((role, j) => {
      const on = row.roles.includes(role), before = row.original.includes(role);
      const mark = on === before ? on ? "●" : "·" : on ? "+●" : "−·";
      const code = state.row === top + i && state.col === first + j ? "7" : `38;5;${COLORS[(first + j) % COLORS.length]}`;
      return fit(paint(code, ` ${mark} `), colWidth);
    }).join("");
    const identity = row.agent_id.slice(row.agent_id.indexOf(":") + 1);
    const display = row.label === row.agent_id ? harnessOf(row.agent_id) : row.label.split(" · ")[0];
    const suffix = state.tab === "room" ? ` ${clean(identity).slice(-8)}` : "";
    const name = truncateStyled(clean(display), Math.max(1, nameWidth - 3 - textWidth(suffix))) + paint("2", suffix);
    set(2 + i, fit(`${state.row === top + i ? "›" : " "} ${name}`, nameWidth) + marks);
  });
  if (!rows.length) set(2, paint("2", "No live agents. Tab edits harness defaults."));
  const selected = rows[state.row];
  const role = state.columns[state.col];
  const defs = state.tab === "room" ? state.definitions : state.globalDefinitions;
  const definition = defs.find(d => d.name === role);
  const defTop = height - 10;
  set(defTop, paint("1", clean(role ?? "No roles")) + paint("2", definition ? ` · ${definition.source}` : ""));
  const body = definition?.text || "No definition. In This room, e adds a project definition.";
  body.split("\n").flatMap(line => wrapStyledLine(highlightChatBody(sanitizeChatText(line), { paint, agent_color: () => 75 }), width)).slice(0, 2)
    .forEach((line, i) => set(defTop + 1 + i, line));
  const notesTop = height - 6;
  set(notesTop, paint("2", rolesEditorDirty(state) ? "On apply · affected agents" : selected ? `${clean(selected.label)} · ${selected.reset ? "inherit" : selected.edited ? "override (draft)" : selected.source}` : "No changes"));
  const notes = state.notifications;
  notes.slice(0, notes.length > 2 ? 1 : 2).forEach((line, i) => set(notesTop + 1 + i, clean(line)));
  if (notes.length > 2) set(notesTop + 2, paint("2", `… ${notes.length - 1} more · v lists all notifications`));
  if (rolesEditorDirty(state) && !notes.length) set(notesTop + 1, paint("2", "No agent's effective instructions change."));
  set(height - 2, state.confirmDiscard ? paint("33", "Discard this draft? y/N") : clean(state.notice ?? ""));
  set(height - 1, paint("2", "Space toggle · Enter apply · Tab scope · e edit · p preview · ? help"));
  return lines;
}
