import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { ChatInputController } from "../src/cli/chat-input.js";
import { editTextInTerminal } from "../src/cli/external-editor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("edits text through a private temp file and hands the terminal back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-editor-"));
  roots.push(root);
  const editor = path.join(root, "fake-editor.sh");
  fs.writeFileSync(editor, "#!/bin/sh\nprintf 'added line\\n' >> \"$1\"\n", { mode: 0o755 });
  const calls: string[] = [];
  const terminal = { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") };
  const text = await editTextInTerminal("# Local\n", terminal, { env: { ...process.env, VISUAL: editor } });
  expect(text).toBe("# Local\nadded line\n");
  expect(calls).toEqual(["suspend", "resume"]);

  const failing = path.join(root, "failing-editor.sh");
  fs.writeFileSync(failing, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  await expect(editTextInTerminal("x", terminal, { env: { ...process.env, VISUAL: failing } })).rejects.toThrow(/exited with code 3/);
  expect(calls.at(-1)).toBe("resume");
});

test("a suspended chat input ignores keys until it resumes", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; } });
  const submitted: string[] = [];
  const controller = new ChatInputController({
    input, columns: 80, onChange: () => {}, onSubmit: (line) => submitted.push(line), onScroll: () => {},
    onBottom: () => {}, onQuit: () => {}, onClear: () => {}, complete: () => null
  });
  controller.suspend();
  expect(input.isRaw).toBe(false);
  input.write("ignored\r");
  controller.resume();
  expect(input.isRaw).toBe(true);
  input.write("kept\r");
  await new Promise((resolve) => setImmediate(resolve));
  expect(submitted).toEqual(["kept"]);
  controller.close();
});
