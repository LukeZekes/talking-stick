import { createSystemHerdrRunner, readHerdrContext, type HerdrContext, type HerdrRunner } from "./herdr.js";
import { createTmuxHerdrRunner, readTmuxContext } from "./tmux.js";
import type { RoomMember } from "./types.js";

// The pane manager tt up drives: Herdr when this process runs in a Herdr pane,
// otherwise tmux when it runs in a tmux pane. Herdr wins inside tmux-in-Herdr.
export type PaneBackend = "herdr" | "tmux";

export interface PaneSession {
  backend: PaneBackend | null;
  runner: HerdrRunner;
  context: HerdrContext | null;
}

export function detectPaneBackend(env: NodeJS.ProcessEnv): PaneBackend | null {
  if (readHerdrContext(env)) return "herdr";
  if (env.TMUX && env.TMUX_PANE?.trim()) return "tmux";
  return null;
}

export function openPaneSession(
  env: NodeJS.ProcessEnv,
  options: { runner?: HerdrRunner; readMembers?: () => readonly RoomMember[] } = {}
): PaneSession {
  const backend = detectPaneBackend(env);
  if (backend === "tmux") {
    const runner = options.runner ?? createTmuxHerdrRunner({ env, readMembers: options.readMembers });
    return { backend, runner, context: readTmuxContext(env, runner) };
  }
  return { backend, runner: options.runner ?? createSystemHerdrRunner(env), context: readHerdrContext(env) };
}
