import {
  BUNDLED_DEFAULT_ROLE_LINES,
  editInstructions,
  parseInstructionScope,
  resetInstructions,
  showInstructions,
  updateInstructions,
  type EditableInstructionScope
} from "../instructions.js";
import { deriveCliIdentity } from "./identity.js";
import {
  getStringOption,
  hasOption,
  type ParsedCommand
} from "./parser.js";
import { printResult } from "./output.js";
import { roomRoleBlock } from "./role-commands.js";
import { selectedRoom } from "./room-selector.js";
import type { Runtime } from "./runtime.js";
import { pickDeepestRoom } from "./session.js";

export async function handleInstructionsCommand(
  parsed: ParsedCommand,
  runtime?: Runtime
): Promise<void> {
  const [subcommand = "show", ...rest] = parsed.positionals;
  const subParsed: ParsedCommand = {
    name: `instructions ${subcommand}`,
    positionals: rest,
    options: parsed.options
  };

  switch (subcommand) {
    case "show":
      handleInstructionsShowCommand(subParsed, runtime);
      return;
    case "edit":
      await handleInstructionsEditCommand(subParsed);
      return;
    case "reset":
      handleInstructionsResetCommand(subParsed);
      return;
    case "update":
      handleInstructionsUpdateCommand(subParsed);
      return;
    default:
      throw new Error(`Unknown instructions subcommand: ${subcommand}`);
  }
}

function handleInstructionsUpdateCommand(parsed: ParsedCommand): void {
  const contextPath = resolveContextPathArg(parsed);
  const wantsUser = hasOption(parsed, "user");
  const wantsProject = hasOption(parsed, "project");
  if (wantsUser && wantsProject) {
    throw new Error("Pass only one of --user or --project.");
  }
  const scopes = wantsUser ? ["user" as const] : wantsProject ? ["project" as const] : undefined;
  const results = updateInstructions({
    scopes,
    replaceEdited: hasOption(parsed, "replace"),
    options: { contextPath }
  });

  printResult(parsed, { results }, () =>
    results.map((result) => `[${result.scope}] ${result.status}: ${result.message} (${result.path})`).join("\n")
  );
}

function handleInstructionsShowCommand(parsed: ParsedCommand, runtime?: Runtime): void {
  const contextPath = resolveContextPathArg(parsed);
  const scope = parseInstructionScope(getStringOption(parsed, "scope"));
  const identity = deriveCliIdentity(parsed);
  const updates = scope === "bundled"
    ? []
    : updateInstructions({
        scopes:
          scope === "user" || scope === "project"
            ? [scope]
            : undefined,
        options: { contextPath }
      });
  const shown = showInstructions({
    harness: getStringOption(parsed, "harness"),
    scope,
    options: {
      contextPath,
      identity
    }
  });
  // In a room, the live role table replaces the bundled default-role line, so
  // instructions and the /roles editor can never disagree.
  const roles = scope === "effective" && runtime ? currentRoleBlock(runtime, parsed, contextPath, identity.agent_id) : null;
  const result = {
    ...shown,
    text: roles ? `${stripDefaultRoleLines(shown.text)}\n\n## Roles\n\n${roles}` : shown.text,
    updates
  };

  printResult(parsed, result, () => {
    const pending = updates.filter(
      (update) => update.status === "update_available"
    );
    if (result.text.trim().length > 0) {
      return [
        result.text,
        ...pending.map((update) => `Update available: ${update.message}`)
      ].join("\n\n");
    }
    return `No ${result.scope} instructions found for ${result.harness}.`;
  });
}

async function handleInstructionsEditCommand(
  parsed: ParsedCommand
): Promise<void> {
  const contextPath = resolveContextPathArg(parsed);
  const scope = resolveEditableScope(parsed, false);
  const result = await editInstructions({
    scope,
    options: { contextPath }
  });

  printResult(parsed, result, () => {
    if (result.opened) {
      return `Opened ${result.scope} instructions: ${result.path}`;
    }
    return [
      `Instructions file ready: ${result.path}`,
      "Set $VISUAL or $EDITOR to edit it from this command."
    ].join("\n");
  });
}

function handleInstructionsResetCommand(parsed: ParsedCommand): void {
  const contextPath = resolveContextPathArg(parsed);
  const scope = resolveEditableScope(parsed, true);
  const result = resetInstructions({
    scope,
    options: { contextPath }
  });

  printResult(parsed, result, () => {
    if (result.removed) {
      return `Removed ${result.scope} instructions: ${result.path}`;
    }
    return `No ${result.scope} instructions file at ${result.path}`;
  });
}

function resolveEditableScope(
  parsed: ParsedCommand,
  requireExplicit: boolean
): EditableInstructionScope {
  const wantsUser = hasOption(parsed, "user");
  const wantsProject = hasOption(parsed, "project");
  if (wantsUser && wantsProject) {
    throw new Error("Pass only one of --user or --project.");
  }
  if (wantsProject) {
    return "project";
  }
  if (wantsUser || !requireExplicit) {
    return "user";
  }
  throw new Error("Pass --user or --project to choose which instructions to reset.");
}

function resolveContextPathArg(parsed: ParsedCommand): string {
  const pathOption = parsed.options.get("path");
  if (pathOption === true) {
    throw new Error("--path requires a value.");
  }
  return pathOption ?? parsed.positionals[0] ?? process.cwd();
}

function currentRoleBlock(runtime: Runtime, parsed: ParsedCommand, contextPath: string, agentId: string): string | null {
  try {
    const room = selectedRoom(runtime, parsed) ??
      pickDeepestRoom(runtime.commands.listRooms({ context_path: contextPath }).rooms);
    return room ? roomRoleBlock(runtime, room.room_id, agentId) : null;
  } catch {
    return null;
  }
}

function stripDefaultRoleLines(text: string): string {
  return text.split("\n").filter((line) => !BUNDLED_DEFAULT_ROLE_LINES.has(line)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
