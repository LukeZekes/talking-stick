import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Opening $VISUAL/$EDITOR from tt chat. The text goes through a private
// temporary file and comes back as a string, so nothing the operator edits is
// saved until they apply it. A terminal editor is required: GUI fallbacks such
// as `open -t` return before the edit happens.

export interface SuspendableTerminal {
  suspend(): void;
  resume(): void;
}

export function terminalEditor(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
}

export async function editTextInTerminal(
  text: string,
  terminal: SuspendableTerminal,
  options: { env?: NodeJS.ProcessEnv; name?: string } = {}
): Promise<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tt-edit-"));
  const file = path.join(directory, options.name ?? "instructions.md");
  fs.writeFileSync(file, text, { mode: 0o600 });
  const editor = terminalEditor(options.env);
  terminal.suspend();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(`${editor} '${file.replaceAll("'", "'\\''")}'`, { stdio: "inherit", shell: true, env: options.env ?? process.env });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${editor} exited with code ${code}; nothing was changed.`)));
    });
    return fs.readFileSync(file, "utf8");
  } finally {
    terminal.resume();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
