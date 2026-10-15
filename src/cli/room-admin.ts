import fs from "node:fs";
import path from "node:path";
import { ROOM_DECLARATION_FILE, insideNestedRepository, isWithinOrSame, resolveContextPath } from "../path-resolution.js";
import { HUMAN_CHAT_SESSION_KIND } from "../types.js";
import type { PathRoom } from "../types.js";
import { printResult } from "./output.js";
import { getStringOption, type ParsedCommand } from "./parser.js";
import { roomShortName, selectedRoom } from "./room-selector.js";
import type { Runtime } from "./runtime.js";

// `tt room create|list|adopt|remove`. Declarations are files in the checkout;
// the database row for a declared room appears on its first join.
export function handleRoomCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const [action, target] = parsed.positionals;
  switch (action) {
    case "create": return createRoom(runtime, parsed, target);
    case "list": return listRooms(runtime, parsed, target);
    case "adopt": return adoptRoom(runtime, parsed, target);
    case "remove": return removeRoom(runtime, parsed, target);
    default:
      throw new Error("Usage: tt room create [path] [--name NAME] | list [path] | adopt [path] | remove [path]");
  }
}

function declarationFile(directory: string): string {
  return path.join(directory, ROOM_DECLARATION_FILE);
}

function writeDeclaration(directory: string, name: string | undefined): string {
  if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`Invalid room name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-'.`);
  }
  const file = declarationFile(directory);
  if (fs.existsSync(file)) throw new Error(`${file} already declares a room.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Talking Stick room boundary. Commit this file to share the layout.\n${name ? `name = "${name}"\n` : ""}`);
  return file;
}

function createRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const directory = resolveContextPath(target ?? process.cwd()).canonical_context_path;
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${directory} is not a directory.`);
  }
  const file = writeDeclaration(directory, getStringOption(parsed, "name"));
  const resolved = resolveContextPath(directory);
  // Open the row now so `--in <name>` and `tt up --in` work before any join.
  let room: PathRoom;
  try {
    room = runtime.commands.openRoom({ context_path: directory });
  } catch (error) {
    fs.rmSync(file, { force: true });
    try { fs.rmdirSync(path.dirname(file)); } catch { /* .talking-stick holds other files */ }
    throw error;
  }
  const result = { status: "created", declaration: file, room_id: room.room_id, room_path: resolved.room_path,
    rel_path: resolved.declaration?.rel_path ?? "", name: resolved.declaration?.name ?? path.basename(directory) };
  printResult(parsed, result, () => [
    `Declared room ${result.name} at ${directory}.`,
    `Agents that join from inside it now use this room; members of a parent room move only when they join again.`,
    `Commit ${path.relative(resolved.checkout_root ?? directory, file)} to share it.`
  ].join("\n"));
}

interface RoomListing {
  name: string;
  room_id: string;
  canonical_path: string;
  state: PathRoom["state"];
  owner: string | null;
  kind: "root" | "declared" | "legacy";
  /** This caller's room for the given path. */
  current: boolean;
  /** Live agents (not chat consoles), so a harness knows who works where. */
  agents: string[];
}

// One compact listing of the repository's rooms and who is in each, for an
// agent to read once on entry or when a task spans rooms.
function listRooms(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const resolved = resolveContextPath(target ?? process.cwd());
  // An explicit --in stays strict; a stale inherited TT_ROOM must not block
  // the discovery an agent uses to recover from it.
  let selected: PathRoom | null = null;
  try {
    selected = selectedRoom(runtime, parsed);
  } catch (error) {
    if (getStringOption(parsed, "in")) throw error;
  }
  // A room selected with --in/TT_ROOM brings its own repository (same rule as
  // chat); a keyed path absent on disk falls back to the caller's repository.
  const anchor = selected && fs.existsSync(selected.canonical_path)
    ? resolveContextPath(selected.canonical_path).workspace_root
    : resolved.workspace_root;
  const currentId = selected?.room_id ??
    runtime.commands.listRooms({ context_path: resolved.canonical_context_path }).rooms[0]?.room_id ?? null;
  const open = runtime.commands.listRooms({}).rooms
    .filter((room) => room.state !== "closed" && isWithinOrSame(room.canonical_path, anchor) &&
      !insideNestedRepository(room.canonical_path, anchor));
  const names = new Map<string, string>();
  for (const room of open) {
    const base = room.canonical_path === anchor ? "root" : roomShortName(room);
    const clash = open.some((other) => other !== room && other.canonical_path !== anchor && roomShortName(other) === base);
    names.set(room.room_id, clash ? path.relative(anchor, room.canonical_path).split(path.sep).join("/") : base);
  }
  const rooms: RoomListing[] = open.map((room) => ({
    name: names.get(room.room_id)!,
    room_id: room.room_id,
    canonical_path: room.canonical_path,
    state: room.state,
    owner: room.owner,
    kind: room.canonical_path === anchor ? "root" as const
      : fs.existsSync(declarationFile(room.canonical_path)) ? "declared" as const : "legacy" as const,
    current: room.room_id === currentId,
    // Read without an agent id so listing never refreshes the caller's presence
    // in other rooms. A parked agent can be inactive by recency yet alive.
    agents: runtime.commands.getRoomState({ room_id: room.room_id }).members
      .filter((member) => member.session_kind !== HUMAN_CHAT_SESSION_KIND && member.process_liveness !== "gone" &&
        (member.status === "active" || member.process_liveness === "alive"))
      .map((member) => member.agent_id)
  }));
  printResult(parsed, { anchor, rooms }, () => rooms.length === 0
    ? `No rooms under ${anchor}.`
    : rooms.map((room) => `${room.current ? "*" : " "} #${room.name}  ${room.kind}  ${room.agents.join(", ") || "no agents"}${room.owner ? `  stick=${room.owner}` : ""}  ${room.canonical_path}  ${room.room_id}`).join("\n"));
}

// Declare an existing legacy room's directory and key the room to it, keeping
// its id, members, lease, and history.
function adoptRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const directory = resolveContextPath(target ?? process.cwd()).canonical_context_path;
  const room = runtime.commands.listRooms({}).rooms.find((candidate) =>
    candidate.state !== "closed" && candidate.canonical_path === directory);
  if (!room) throw new Error(`No room exists at ${directory}. Use \`tt room list\` to find legacy rooms, or \`tt room create\`.`);
  const before = resolveContextPath(directory);
  if (before.declaration && before.declaration.directory === directory) {
    throw new Error(`${directory} is already declared.`);
  }
  const file = writeDeclaration(directory, getStringOption(parsed, "name"));
  let rekeyed: PathRoom;
  try {
    rekeyed = runtime.commands.rekeyRoomPath({ room_id: room.room_id, canonical_path: resolveContextPath(directory).room_path });
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
  printResult(parsed, { status: "adopted", room_id: room.room_id, declaration: file, canonical_path: rekeyed.canonical_path },
    () => `Adopted room ${room.room_id} at ${directory}${rekeyed.canonical_path !== directory ? ` (keyed as ${rekeyed.canonical_path})` : ""}. Commit ${file} to share it.`);
}

// Removes the declaration and deletes the room it keyed, with its events and
// notes, so later joins really do resolve to the parent. That matches the
// existing lifecycle, where the last agent leaving deletes a room. Refuses
// while any agent is still in the room.
function removeRoom(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const resolved = resolveContextPath(target ?? process.cwd());
  const declaration = resolved.declaration;
  if (!declaration) throw new Error(`No room declaration covers ${resolved.canonical_context_path}.`);
  const room = runtime.commands.listRooms({}).rooms.find((candidate) =>
    candidate.canonical_path === resolved.room_path || candidate.canonical_path === declaration.directory);
  const retired = room ? runtime.commands.retireUnoccupiedRoom({ room_id: room.room_id }).retired : false;
  const file = declarationFile(declaration.directory);
  fs.rmSync(file);
  try { fs.rmdirSync(path.dirname(file)); } catch { /* .talking-stick holds other files */ }
  printResult(parsed, { status: "removed", declaration: file, retired_room_id: retired ? room?.room_id ?? null : null },
    () => `Removed ${file}${retired ? ` and deleted room ${room?.room_id} with its events and notes (any chat console on it is detached)` : ""}. New joins use the parent room.`);
}
