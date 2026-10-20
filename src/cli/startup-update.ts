import { autoUpdate } from "../auto-update.js";
import { isStandalone, standaloneRoot } from "../standalone-mode.js";
import { resolveCliIdentity } from "./identity.js";
import { hasOption, type ParsedCommand } from "./parser.js";
import { shouldUseJson } from "./output.js";
import { getCommand } from "./registry.js";

// Coordination commands and hooks must remain fast, including for human callers.
const INTERACTIVE_COMMANDS = new Set(["chat", "up", "install", "uninstall", "instructions", "roles", "room", "state", "status", "health", "list", "whoami"]);

export async function runStartupUpdate(parsed: ParsedCommand): Promise<boolean> {
  if (!isStandalone() || process.env.TT_NO_AUTO_UPDATE === "1" ||
      !process.stdin.isTTY || !process.stdout.isTTY || shouldUseJson(parsed) ||
      hasOption(parsed, "print") || !INTERACTIVE_COMMANDS.has(parsed.name) ||
      getCommand(parsed.name)?.internal || resolveCliIdentity(parsed).source !== "human_cli_default") return false;
  return autoUpdate({ releaseRoot: standaloneRoot() });
}
