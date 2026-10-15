import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { ChatInputController, type ChatModalKey } from "../src/cli/chat-input.js";
import { createRolesEditor, renderRolesEditor, rolesEditorKey, type RolesEditorState } from "../src/cli/roles-editor.js";

function editor(): RolesEditorState {
  return createRolesEditor({
    agents: ["claude:a", "codex:b"],
    assignments: [{ subject: "agent:codex:b", roles: ["implementer", "lint-czar"] }],
    userDefaults: {},
    version: 2
  });
}

function press(state: RolesEditorState, ...keys: ChatModalKey[]) {
  let current = state;
  let action;
  for (const key of keys) ({ state: current, action } = rolesEditorKey(current, key));
  return { state: current, action };
}

test("the editor starts from effective roles and includes custom roles in use", () => {
  const state = editor();
  expect(state.columns).toEqual(["architect", "implementer", "reviewer", "tester", "scribe", "lint-czar"]);
  expect(state.rows.map((row) => [row.label, row.roles])).toEqual([
    ["claude:a", ["architect"]], ["codex:b", ["implementer", "lint-czar"]], ["grok (no agent here)", ["implementer", "reviewer"]]
  ]);
  expect(renderRolesEditor(state, { color: false } as never)[0]).toContain("Roles (v2)");
});

test("Space toggles the focused cell and Enter applies only changed rows", () => {
  // Move to codex, reviewer column, toggle on; then toggle claude's architect off.
  const { state, action } = press(editor(), "down", "right", "right", "space", "up", "left", "left", "space", "enter");
  expect(state.rows.map((row) => row.roles).slice(0, 2)).toEqual([[], ["implementer", "lint-czar", "reviewer"]]);
  expect(action).toEqual({ kind: "apply", changes: [
    { subject: "agent:claude:a", roles: [] },
    { subject: "agent:codex:b", roles: ["implementer", "reviewer", "lint-czar"] }
  ] });
  expect(renderRolesEditor(state, { color: false } as never).filter((line) => line.includes("*"))).toHaveLength(2);
});

test("toggling back to the original is not a change; d saves the row as the harness default; Esc cancels", () => {
  expect(press(editor(), "space", "space", "enter").action).toEqual({ kind: "apply", changes: [] });
  expect(press(editor(), "down", "default").action).toEqual({ kind: "save_default", harness: "codex", roles: ["implementer", "lint-czar"] });
  expect(press(editor(), "space", "escape").action).toEqual({ kind: "cancel" });
});

test("a modal swallows keys: nothing is submitted and the draft survives", async () => {
  const input = new PassThrough();
  const submitted: string[] = [];
  const keys: ChatModalKey[] = [];
  const controller = new ChatInputController({
    input, columns: 80, onChange: () => {}, onSubmit: (line) => submitted.push(line), onScroll: () => {},
    onBottom: () => {}, onQuit: () => {}, onClear: () => {}, complete: () => null
  });
  try {
    input.write("half typed");
    controller.setModal((key) => keys.push(key));
    input.write(" \r\u001b[B\u001b[C dq\r");
    input.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(keys).toEqual(["space", "enter", "down", "right", "space", "default", "enter", "escape"]);
    controller.setModal(null);
    expect(controller.draft.line).toBe("half typed");
    expect(submitted).toEqual([]);
  } finally {
    controller.close();
  }
});

test("modal keys survive split escape sequences and pasted text is never a command", async () => {
  const input = new PassThrough();
  const keys: ChatModalKey[] = [];
  const controller = new ChatInputController({
    input, columns: 80, onChange: () => {}, onSubmit: () => {}, onScroll: () => {},
    onBottom: () => {}, onQuit: () => {}, onClear: () => {}, complete: () => null
  });
  try {
    controller.setModal((key) => keys.push(key));
    input.write("\u001b");
    input.write("[A");
    input.write("\u001b[200~d \rsecret");
    input.write(" more\r\u001b[2");
    input.write("01~");
    input.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(keys).toEqual(["up", "escape"]);
  } finally {
    controller.close();
  }
});

test("a harness row with no agent applies a room harness assignment, and the viewport follows selection", () => {
  const { state, action } = press(editor(), "down", "down", "space", "enter");
  expect(action).toEqual({ kind: "apply", changes: [{ subject: "harness:grok", roles: ["architect", "implementer", "reviewer"] }] });
  const many = createRolesEditor({ agents: Array.from({ length: 12 }, (_, i) => `codex:${i}`), assignments: [], userDefaults: {}, version: 0 });
  const last = press(many, "up").state;
  const lines = renderRolesEditor(last, { color: false } as never, 6);
  expect(lines.length).toBeLessThanOrEqual(6);
  expect(lines.some((line) => line.startsWith("›"))).toBe(true);
  void state;
});
