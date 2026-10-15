import fs from "node:fs";
import path from "node:path";
import { ROOM_DECLARATION_FILE, isWithinOrSame, resolveContextPath } from "../path-resolution.js";
import type { PathRoom } from "../types.js";
import { printResult } from "./output.js";
import { getStringOption, type ParsedCommand } from "./parser.js";
import { roomShortName } from "./room-selector.js";
import type { Runtime } from "./runtime.js";

// `tt room create|list|adopt|remove`. Declarations are files in the checkout;
// the database row for a declared room appears on its first join.
export function handleRoomCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const [action, target] = parsed.positionals;
  switch (action) {
    case "create": return createRoom(parsed, target);
    case "list": return listRooms(runtime, parsed, target);
    case "adopt": return adoptRoom(runtime, parsed, target);
    case "remove": return removeRoom(parsed, target);
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

function createRoom(parsed: ParsedCommand, target: string | undefined): void {
  const directory = resolveContextPath(target ?? process.cwd()).canonical_context_path;
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${directory} is not a directory.`);
  }
  const file = writeDeclaration(directory, getStringOption(parsed, "name"));
  const resolved = resolveContextPath(directory);
  const result = { status: "created", declaration: file, room_path: resolved.room_path,
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
}

function listRooms(runtime: Runtime, parsed: ParsedCommand, target: string | undefined): void {
  const resolved = resolveContextPath(target ?? process.cwd());
  const anchor = resolved.workspace_root;
  const rooms: RoomListing[] = runtime.commands.listRooms({}).rooms
    .filter((room) => room.state !== "closed" && isWithinOrSame(room.canonical_path, anchor))
    .map((room) => ({
      name: roomShortName(room),
      room_id: room.room_id,
      canonical_path: room.canonical_path,
      state: room.state,
      owner: room.owner,
      kind: room.canonical_path === anchor ? "root" as const
        : fs.existsSync(declarationFile(room.canonical_path)) ? "declared" as const : "legacy" as const
    }));
  printResult(parsed, { anchor, rooms }, () => rooms.length === 0
    ? `No rooms under ${anchor}.`
    : rooms.map((room) => `#${room.name}  ${room.kind}  ${room.state}${room.owner ? ` owner=${room.owner}` : ""}  ${room.canonical_path}  ${room.room_id}`).join("\n"));
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

// Removes only the declaration. The room keeps serving its current members and
// idles out normally; new joins resolve to the parent room.
function removeRoom(parsed: ParsedCommand, target: string | undefined): void {
  const resolved = resolveContextPath(target ?? process.cwd());
  const declaration = resolved.declaration;
  if (!declaration) throw new Error(`No room declaration covers ${resolved.canonical_context_path}.`);
  const file = declarationFile(declaration.directory);
  fs.rmSync(file);
  try { fs.rmdirSync(path.dirname(file)); } catch { /* .talking-stick holds other files */ }
  printResult(parsed, { status: "removed", declaration: file },
    () => `Removed ${file}. Current members stay until they rejoin; new joins use the parent room.`);
}
