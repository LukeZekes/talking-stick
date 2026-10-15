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
  expect(state.rows.map((row) => row.roles)).toEqual([["architect"], ["implementer", "lint-czar"]]);
  expect(renderRolesEditor(state, { color: false } as never)[0]).toContain("Roles (v2)");
});

test("Space toggles the focused cell and Enter applies only changed rows", () => {
  // Move to codex, reviewer column, toggle on; then toggle claude's architect off.
  const { state, action } = press(editor(), "down", "right", "right", "space", "up", "left", "left", "space", "enter");
  expect(state.rows.map((row) => row.roles)).toEqual([[], ["implementer", "lint-czar", "reviewer"]]);
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

test("a modal swallows keys: nothing is submitted and the draft survives", () => {
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
    expect(keys).toEqual(["space", "enter", "down", "right", "space", "default", "enter", "escape"]);
    controller.setModal(null);
    expect(controller.draft.line).toBe("half typed");
    expect(submitted).toEqual([]);
  } finally {
    controller.close();
  }
});
