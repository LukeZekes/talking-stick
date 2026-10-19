import fs from "node:fs";
import path from "node:path";

// Set by src/standalone.ts, the entry of the compiled `tt` binary. In that
// mode release assets (package.json, skills/, scripts/) sit beside the real
// executable rather than in an npm package directory.
let standalone = false;

export function markStandalone(): void {
  standalone = true;
}

export function isStandalone(): boolean {
  return standalone;
}

/** The release directory holding the real `tt` executable (symlinks resolved). */
export function standaloneRoot(): string {
  return path.dirname(fs.realpathSync(process.execPath));
}
