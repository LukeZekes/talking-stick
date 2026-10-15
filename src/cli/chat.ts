import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { planChatInterrupts } from "./chat-interrupt.js";
import { interruptCodexThread } from "./codex-interrupt.js";
import { interruptCodexHerdr } from "./codex-herdr-interrupt.js";
import { ChatInputController, type ChatModalKey } from "./chat-input.js";
import { createRolesEditor, renderRolesEditor, rolesEditorKey, type RolesEditorState } from "./roles-editor.js";
import { applyRoleChanges, liveAgents, parseRoleList, parseRoleSubject, roomRoleBlock } from "./role-commands.js";
import { readUserRoleDefaults, writeUserRoleDefault } from "../roles.js";
import { resolveRoomSelector, roomShortName, selectedRoom } from "./room-selector.js";
import { insideNestedRepository, isWithinOrSame, resolveContextPath } from "../path-resolution.js";
import { resolveChatKick } from "./chat-kick.js";
import {
  ChatTranscript,
  renderChatScreen,
  diffChatFrame,
  getChatCompletions,
  formatChatHelp,
  renderInlinePanel,
  inlineCursorRow,
  textWidth,
  truncateStyled,
  wrapStyledLine,
  chatTranscriptHeight,
  chatWheelRegion,
  CHAT_COMMANDS,
  type ChatFrame
} from "./chat-view.js";
import type { Readable, Writable } from "node:stream";

import { ProtocolError, isSqliteBusy } from "../errors.js";
import { hasHookInterrupt, requestHookInterrupt } from "../interrupt-flags.js";
import { deriveHumanCliIdentity, type DerivedIdentity } from "../identity.js";
import {
  HUMAN_CHAT_SESSION_KIND,
  type EventType,
  type MessageDelivery,
  type PathRoom,
  type RoomEvent,
  type RoomMember
} from "../types.js";
import type { ChatRoomCompletion } from "./chat-view.js";
import {
  formatRoomStrip,
  buildNameResolver,
  formatChatEvent,
  chatSectionLabel,
  startsChatConversation,
  isChatConversationActivity,
  formatChatAgent,
  describeMemberState,
  parseChatInput,
  resolveChatRecipients,
  sanitizeChatText,
  EVERYONE_SELECTORS
} from "./chat-format.js";
import {
  getStringOption,
  hasOption,
  parseOptionalInteger,
  type ParsedCommand
} from "./parser.js";
import type { Runtime } from "./runtime.js";

const DEFAULT_HISTORY = 20;
const HISTORY_SCAN_EVENTS = 500;
const DEFAULT_POLL_MS = 250;
const PRESENCE_REFRESH_MS = 30_000;
const STATUS_REFRESH_MS = 10_000;
const STRIP_REFRESH_MS = 2_000;
const RECEIPT_POLL_MS = 1_000;
const RECEIPT_BATCH = 200;
const MAX_AWAITED_RECEIPTS = 1_000;
const STATE_CHANGE_EVENTS = new Set<EventType>([
  "join",
  "leave",
  "kick",
  "session_superseded",
  "claim",
  "release",
  "pass",
  "takeover",
  "reservation_expired"
]);
const OWNERSHIP_EVENTS: EventType[] = ["claim", "takeover"];
const CONVERSATION_EVENTS: EventType[] = [
  "message_sent",
  "join",
  "leave",
  "kick",
  "close"
];

// Shared across room switches within one `tt chat` process.
export interface ChatConsoleState {
  /** Coordination root whose rooms the strip lists. */
  anchor: string;
  /** Rooms this console has joined; it stays a member until chat exits. */
  visited: Set<string>;
  /** Highest event seq viewed per room; unread counts start after it. */
  last_seen: Map<string, number>;
  /** Unread counting for never-viewed rooms starts at the console's start. */
  start_seq: number;
  /** Unsent draft per room, restored on return. */
  drafts: Map<string, string>;
  /**
   * Rooms joined as an observer only because they are listed, so agents there
   * can address the operator. Left again once a room drops off the strip.
   */
  subscribed: Set<string>;
  /** Highest seq of messages addressed to this console already shown inline. */
  directed_seen: Map<string, number>;
}

export type ChatSessionExit = { kind: "quit" } | { kind: "switch"; room: PathRoom };

export interface ChatSessionOptions {
  runtime: Runtime;
  identity: DerivedIdentity;
  context_path: string;
  /** Join exactly this room instead of resolving context_path. */
  room_id?: string;
  /** Multi-room state; without it chat stays in one room. */
  console?: ChatConsoleState;
  input: Readable;
  output: Writable;
  terminal: boolean;
  color: boolean;
  history: number;
  show_turn_events: boolean;
  poll_ms?: number;
  mouse?: boolean;
  // Inline mode prints into the terminal's normal screen instead of taking it
  // over, so the terminal (or multiplexer) keeps scrollback, selection, and
  // copy. The pinned full-screen layout stays available behind --fullscreen.
  inline?: boolean;
}

// Native terminal scrollback owns wheel scrolling and selection. --fullscreen
// retains the alternate-screen viewport and its keyboard scrolling controls.
export function chatInlineEnabled(parsed: ParsedCommand): boolean {
  return !hasOption(parsed, "fullscreen");
}

// A dumb terminal can neither draw the panel's cursor movement nor edit a
// draft: Node's readline swaps in its dumb line writer whenever TERM=dumb, even
// with terminal mode requested, so arrows and Ctrl+A arrive as literal text.
// Plain line mode is the honest experience there.
export function chatTerminalCapable(
  stdin: { isTTY?: boolean },
  stdout: { isTTY?: boolean },
  env: NodeJS.ProcessEnv
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY) && env.TERM !== "dumb";
}

// Labels say what is known, never more. "unreachable" needs a definite
// transport failure; an agent with nothing to wake it yet, such as a Grok that
// will pick the message up at its next tool call, is only "not acknowledged yet".
export function describeChatDelivery(delivery: MessageDelivery): string {
  if (delivery.state === "failed") return "unreachable";
  if (delivery.status === "receiver") return "queued";
  if (delivery.error === "manual_standby") return "waiting for resume";
  if (delivery.state === "queued" && delivery.interrupt_status === "unsupported") return "queued; immediate interrupt unavailable";
  if (delivery.state === "queued" && delivery.interrupt_status === "injected") return "urgent prompt injected";
  if (delivery.state === "ambiguous") return "wake unconfirmed";
  if (delivery.state === "woken") return "turn started";
  if (delivery.state === "queued") return "queued";
  if (delivery.status === "pending" || delivery.status === "endpoint") return "queued";
  return "not acknowledged yet";
}

export async function handleChatCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const agentId = getStringOption(parsed, "agent");
  const identity = createChatIdentity(agentId);
  const terminal = chatTerminalCapable(process.stdin, process.stdout, process.env);

  // `tt chat #api` names a room; a plain positional is still a path.
  const positional = parsed.positionals[0];
  const explicit = positional?.startsWith("#")
    ? resolveRoomSelector(runtime.commands.listRooms({}).rooms, positional)
    : selectedRoom(runtime, parsed);
  await runChatConsole({
    runtime,
    identity,
    // The caller's checkout stays the context even for an explicit room: a
    // room keyed under the main checkout may not exist in this worktree.
    context_path: positional && !positional.startsWith("#") ? positional : process.cwd(),
    room_id: explicit?.room_id,
    input: process.stdin,
    output: process.stdout,
    terminal,
    color: terminal && !process.env.NO_COLOR,
    history: parseOptionalInteger(parsed, "history") ?? DEFAULT_HISTORY,
    show_turn_events: hasOption(parsed, "events"),
    mouse: hasOption(parsed, "mouse") && !hasOption(parsed, "no-mouse"),
    inline: chatInlineEnabled(parsed)
  });
}

// One console across room switches: `/go` or Alt+←/→ ends the current room's
// session and opens the next with the same identity, drafts, and unread state.
export async function runChatConsole(options: Omit<ChatSessionOptions, "console">): Promise<void> {
  const consoleState: ChatConsoleState = {
    anchor: "",
    visited: new Set(),
    last_seen: new Map(),
    start_seq: options.runtime.commands.globalEventSeq(),
    drafts: new Map(),
    subscribed: new Set(),
    directed_seen: new Map()
  };
  let target: { context_path: string; room_id?: string } = { context_path: options.context_path, room_id: options.room_id };
  try {
    for (;;) {
      const exit = await runChatSession({ ...options, ...target, console: consoleState });
      if (exit.kind !== "switch") break;
      target = { context_path: options.context_path, room_id: exit.room.room_id };
    }
  } finally {
    // Switching keeps memberships so agents can still reply; leave them now.
    for (const roomId of new Set([...consoleState.visited, ...consoleState.subscribed])) {
      try { options.runtime.commands.leaveRoom(options.identity, { room_id: roomId }); } catch { /* already gone */ }
    }
  }
}

export function createChatIdentity(agentId?: string): DerivedIdentity {
  const identity = deriveHumanCliIdentity({
    agentId,
    displayName: agentId?.replace(/^[^:]+:/, ""),
    sessionKind: HUMAN_CHAT_SESSION_KIND
  });
  return {
    ...identity,
    agent_id: `${identity.agent_id}:chat:${randomUUID().slice(0, 8)}`
  };
}

// An operator console for a room: joins as a `human_chat` observer (never
// part of turn scheduling), prints recent conversation, then streams every
// room event as chat lines while reading messages from the input.
export async function runChatSession(
  options: ChatSessionOptions
): Promise<ChatSessionExit> {
  const { runtime, identity, output, terminal } = options;
  const fullscreen = terminal && options.inline !== true;
  const inline = terminal && !fullscreen;
  const selfId = identity.agent_id;
  const joined = runtime.commands.joinPath(identity, {
    context_path: options.context_path,
    room_id: options.room_id
  });
  const roomId = joined.room_id;
  const consoleState = options.console;
  consoleState?.visited.add(roomId);
  consoleState?.subscribed.delete(roomId);
  // The repository of the first room this console opened bounds its strip.
  // A room chosen with --in from another repository brings its own anchor; a
  // keyed path absent on disk falls back to the caller's repository.
  if (consoleState && !consoleState.anchor) {
    consoleState.anchor = fs.existsSync(joined.canonical_path)
      ? resolveContextPath(joined.canonical_path).workspace_root
      : joined.workspace_root;
  }
  let switchTarget: PathRoom | null = null;
  let viewedSeq = 0;
  let roomStrip = "";
  let stripOrder: PathRoom[] = [];
  let roomNames = new Map<string, string>();
  // Every open room in this repository except the current one, for /go completion.
  let goRooms: ChatRoomCompletion[] = [];
  let lastStripRefresh = 0;
  // Other rooms in this repository that have live agents, unread messages, or
  // a past visit. The console joins listed rooms as an observer so agents there
  // can reply to it, and shows messages addressed to it inline. Its own
  // membership never keeps a room listed.
  const refreshStrip = (): boolean => {
    if (!consoleState) return false;
    lastStripRefresh = Date.now();
    const rooms = runtime.commands.listRooms({}).rooms.filter((room) =>
      room.state !== "closed" && room.room_id !== roomId && isWithinOrSame(room.canonical_path, consoleState.anchor) &&
      !insideNestedRepository(room.canonical_path, consoleState.anchor));
    const activity = new Map(runtime.commands.summarizeRoomActivity(selfId, rooms.map((room) => ({
      room_id: room.room_id,
      after_event_seq: consoleState.last_seen.get(room.room_id) ?? consoleState.start_seq
    }))).map((entry) => [entry.room_id, entry]));
    const listed = rooms.filter((room) => {
      const entry = activity.get(room.room_id);
      return (entry?.agent_members ?? 0) > 0 || (entry?.unread_messages ?? 0) > 0 || consoleState.visited.has(room.room_id);
    });
    const listedIds = new Set(listed.map((room) => room.room_id));
    for (const id of [...consoleState.subscribed]) {
      if (listedIds.has(id) || consoleState.visited.has(id)) continue;
      try { runtime.commands.leaveRoom(identity, { room_id: id }); } catch { /* already gone */ }
      consoleState.subscribed.delete(id);
    }
    for (const room of listed) {
      if (consoleState.visited.has(room.room_id) || consoleState.subscribed.has(room.room_id)) continue;
      try {
        runtime.commands.joinPath(identity, { context_path: options.context_path, room_id: room.room_id });
        consoleState.subscribed.add(room.room_id);
      } catch { /* the room closed between list and join */ }
    }
    roomNames = uniqueRoomNames([joined, ...listed], consoleState.anchor);
    const allNames = uniqueRoomNames([joined, ...rooms], consoleState.anchor);
    goRooms = rooms.map((room) => {
      const agents = activity.get(room.room_id)?.agent_members ?? 0;
      const where = path.relative(consoleState.anchor, room.canonical_path) || ".";
      return { name: allNames.get(room.room_id) ?? roomShortName(room), description: `${where} · ${agents} agent${agents === 1 ? "" : "s"}` };
    }).sort((left, right) => left.name.localeCompare(right.name));
    for (const room of listed) {
      // A visit already showed everything up to last_seen; never replay it.
      const after = Math.max(consoleState.directed_seen.get(room.room_id) ?? 0,
        consoleState.last_seen.get(room.room_id) ?? 0, consoleState.start_seq);
      const directed = runtime.commands.getDirectedMessages({ room_id: room.room_id, agent_id: selfId, after_event_seq: after });
      for (const event of directed) {
        const body = (event.payload as { body?: unknown } | null)?.body;
        print(`#${sanitizeChatText(roomNames.get(room.room_id) ?? "room")} › ${sanitizeChatText(nameOf(event.from_agent_id ?? "system"))} → you: ${sanitizeChatText(typeof body === "string" ? body : "")}`);
      }
      if (directed.length) consoleState.directed_seen.set(room.room_id, directed[directed.length - 1].event_seq);
    }
    stripOrder = listed;
    const next = formatRoomStrip(listed.map((room) => ({
      name: roomNames.get(room.room_id) ?? roomShortName(room),
      unread: activity.get(room.room_id)?.unread_messages ?? 0,
      directed: activity.get(room.room_id)?.unread_directed ?? 0
    })), formatContext());
    const changed = next !== roomStrip;
    roomStrip = next;
    return changed;
  };
  const openRoomAtPath = (target: string): PathRoom | null => {
    if (!consoleState) return null;
    // Relative to the caller's checkout when it belongs to this console's
    // repository (a worktree keeps its branch's declarations), else the anchor.
    const caller = resolveContextPath(options.context_path);
    const checkout = caller.workspace_root === consoleState.anchor ? caller.checkout_root ?? consoleState.anchor : consoleState.anchor;
    const directory = path.resolve(checkout, target);
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return null;
    const resolved = resolveContextPath(directory);
    if (!isWithinOrSame(resolved.room_path, consoleState.anchor) ||
        (resolved.checkout_root !== null && resolved.workspace_root !== consoleState.anchor)) {
      throw new Error(`${directory} belongs to another repository.`);
    }
    return runtime.commands.openRoom({ context_path: directory });
  };
  let rolesPanel: RolesEditorState | null = null;
  const rolesPanelLines = () => rolesPanel
    ? renderRolesEditor(rolesPanel, formatContext(), Math.max(4, dimensions().rows - 6), Math.max(20, dimensions().columns - 1))
    : undefined;
  const closeRolesPanel = () => {
    rolesPanel = null;
    editor?.setModal(null);
    redraw();
  };
  const onRolesKey = (key: ChatModalKey) => {
    if (!rolesPanel) return;
    const { state, action } = rolesEditorKey(rolesPanel, key);
    rolesPanel = state;
    if (action.kind === "cancel") { closeRolesPanel(); print("Roles unchanged."); return; }
    if (action.kind === "save_default") {
      try { writeUserRoleDefault(action.harness, action.roles); }
      catch (error) { rolesPanel = { ...state, notice: `! ${error instanceof Error ? error.message : String(error)}` }; }
      redraw();
      return;
    }
    if (action.kind === "apply") {
      closeRolesPanel();
      if (action.changes.length === 0) { print("Roles unchanged."); return; }
      void applyRoleChanges(runtime, identity, roomId, action.changes)
        .then((result) => print(`Roles v${result.version} applied; told ${result.recipients.map((id) => sanitizeChatText(nameOf(id))).join(", ") || "nobody"}.`))
        .catch((error) => print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`));
      return;
    }
    redraw();
  };
  const openRolesPanel = () => {
    const { version, assignments } = runtime.commands.getRoomRoles({ room_id: roomId });
    rolesPanel = createRolesEditor({ agents: liveAgents(runtime, roomId), assignments, userDefaults: readUserRoleDefaults(), version });
    editor?.setModal(onRolesKey);
    redraw();
  };
  const switchTo = (room: PathRoom) => {
    if (room.room_id === roomId) { print(`Already in ${sanitizeChatText(room.canonical_path)}.`); return; }
    switchTarget = room;
    stop();
  };

  // Agents seen leaving, so addressing one explains why it can't be reached.
  const departedAgents = new Set<string>();
  let members: RoomMember[] = [];
  let owner: string | null = null;
  let ownerSince: string | null = null;
  let reservedFor: string | null = null;
  let nameOf = buildNameResolver([selfId], selfId);
  let showTurnEvents = options.show_turn_events;
  let closed = false;
  let lastPresenceRefresh = 0;
  let namesSignature = "";
  let historyBefore: string | undefined;
  let historyCursor = 0;
  let historyExhausted = false;
  let previousConversationEvent: RoomEvent | undefined;
  let printedSection: string | undefined;
  let exitReason: string | null = null;

  const transcript = new ChatTranscript();
  let editor: ChatInputController | null = null;
  let rl: readline.Interface | null = null;
  let previousFrame: ChatFrame | null = null;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let screenActive = false;
  let failure: unknown;
  let hint: string | null = null;
  let interruptHint: { text: string; until: number } | null = null;
  const interruptIndicators = new Map<string,
    { kind: "claude"; session_id: string } | { kind: "timed"; label: string; until: number }>();
  const interruptStatuses = (): ReadonlyMap<string, string> => {
    const now = Date.now();
    const statuses = new Map<string, string>();
    for (const [agentId, indicator] of interruptIndicators) {
      if (indicator.kind === "claude" && hasHookInterrupt("claude", indicator.session_id)) {
        statuses.set(agentId, "stopping");
      } else if (indicator.kind === "timed" && now < indicator.until) {
        statuses.set(agentId, indicator.label);
      } else {
        interruptIndicators.delete(agentId);
      }
    }
    return statuses;
  };
  const currentHint = () => {
    if (interruptHint && Date.now() >= interruptHint.until) interruptHint = null;
    return interruptHint?.text ?? hint;
  };
  const interruptSignature = () => JSON.stringify({
    statuses: [...interruptStatuses()], hint: currentHint()
  });
  let lastInterruptSignature = interruptSignature();
  // One room message can reach several agents, so each event keeps a state per
  // recipient and renders them on a single line under that message.
  const deliveryStates = new Map<number, Map<string, string>>();
  const rememberDelivery = (seq: number, agent: string, state: string) => {
    const states = deliveryStates.get(seq) ?? new Map<string, string>();
    states.set(agent, state);
    deliveryStates.set(seq, states);
    while (deliveryStates.size > 2_000) deliveryStates.delete(deliveryStates.keys().next().value!);
  };
  // Every icon is one terminal cell, so a delivery update never changes how
  // many rows a message header occupies: … pending, ✓ delivered, ! failed.
  const deliveryIcon = (event: RoomEvent, agent: string) => {
    const state = deliveryStates.get(event.event_seq)?.get(agent);
    if (!state || !terminal) return undefined;
    if (state === "delivered") return options.color ? "\u001b[32m✓\u001b[0m" : "✓";
    if (state === "unreachable") return options.color ? "\u001b[31m!\u001b[0m" : "!";
    return options.color ? "\u001b[2m…\u001b[0m" : "…";
  };
  // Events whose header shows delivery icons, kept so a receipt can repaint it.
  const trackedEvents = new Map<number, RoomEvent>();
  let lastStatusDraw = Date.now();
  const dimensions = () => ({
    columns: Math.max(1, (output as { columns?: number }).columns ?? 80),
    rows: Math.max(1, (output as { rows?: number }).rows ?? 24)
  });
  const formatContext = () => ({
    self_agent_id: selfId,
    name_of: nameOf,
    color: options.color,
    show_turn_events: showTurnEvents,
    now: new Date(),
    history_before: historyBefore,
    delivery_icon: deliveryIcon,
    tracks_delivery: (event: RoomEvent) => terminal && (deliveryStates.get(event.event_seq)?.size ?? 0) > 0
  });
  const completionsFor = (draft: { line: string; cursor: number }) => getChatCompletions(draft,
    members.filter((member) => member.agent_id !== selfId && member.process_liveness !== "gone")
      .flatMap((member) => [nameOf(member.agent_id), member.agent_id]),
    members.filter((member) => member.agent_id !== selfId && member.session_kind !== HUMAN_CHAT_SESSION_KIND)
      .sort((a, b) => Number(b.process_liveness === "gone") - Number(a.process_liveness === "gone") || a.agent_id.localeCompare(b.agent_id))
      .map((member) => ({ agent_id: member.agent_id, name: member.display_name || nameOf(member.agent_id),
        status: member.process_liveness === "gone" ? "ended" : describeMemberState(member, {
          members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(),
          columns: dimensions().columns, interrupt_statuses: interruptStatuses()
        }) })), goRooms);
  // Inline drawing: the composer occupies the last rows of the normal screen.
  // Erasing walks back up every row it drew, so a wrapped draft never leaves
  // fragments behind in the scrollback.
  let inlineFrame: ChatFrame | null = null;
  let inlineFrameColumns = { columns: 80, rows: 24 };
  let inlineActive = false;
  let inlineOutputRows = 0;
  let inlineVisibleFloor = 0;
  const inlineReceiptRows = new Map<number, number>();
  // Erase with the geometry the panel was drawn at: after a resize the current
  // width would compute the wrong row count and strand a stale copy.
  const eraseComposer = () => {
    if (!inlineFrame) return;
    const up = Math.min(
      inlineFrameColumns.rows - 1,
      inlineCursorRow(inlineFrame, inlineFrameColumns.columns)
    );
    output.write(`\r${up > 0 ? `\u001b[${up}A` : ""}\u001b[J`);
    inlineFrame = null;
  };
  const drawComposer = () => {
    if (!inline || closed) return;
    const draft = editor?.draft ?? { line: "", cursor: 0 };
    const frame = renderInlinePanel({
      room_path: joined.canonical_path, room_strip: roomStrip, panel: rolesPanelLines(), transcript, format: formatContext(),
      status: { members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(),
        interrupt_statuses: interruptStatuses() },
      draft, hint: currentHint(),
      completions: editor?.completionVisible ? completionsFor(draft) : [],
      completion_index: editor?.completionIndex ?? 0,
      ...dimensions()
    });
    if (inlineFrame && JSON.stringify(inlineFrame) === JSON.stringify(frame)) return;
    output.write("\u001b[?2026h");
    eraseComposer();
    output.write(frame.lines.join("\r\n"));
    inlineFrame = frame;
    inlineFrameColumns = dimensions();
    inlineVisibleFloor = Math.max(inlineVisibleFloor, inlineOutputRows + frame.lines.length - dimensions().rows);
    for (const [seq, row] of inlineReceiptRows) if (row < inlineVisibleFloor) inlineReceiptRows.delete(seq);
    const up = frame.lines.length - 1 - frame.cursor.row;
    output.write(`\r${up > 0 ? `\u001b[${up}A` : ""}${frame.cursor.col > 0 ? `\u001b[${frame.cursor.col}C` : ""}\u001b[?2026l`);
  };
  // Inline output must not land on top of the composer: erase it, print the
  // line, then redraw the draft underneath.
  const writeInline = (text: string) => {
    eraseComposer();
    const lines = text.split(/\r?\n/).flatMap(line => wrapStyledLine(line, Math.max(1, dimensions().columns - 1)));
    output.write(lines.join("\r\n") + "\r\n");
    inlineOutputRows += lines.length;
    drawComposer();
  };
  const redraw = () => {
    if (inline) { drawComposer(); return; }
    if (!fullscreen || closed || frameTimer) return;
    frameTimer = setTimeout(() => {
      frameTimer = null;
      if (closed || !screenActive) return;
      try {
        const frame = renderChatScreen({
          room_path: joined.canonical_path,
          room_strip: roomStrip, panel: rolesPanelLines(),
          transcript,
          format: formatContext(),
          status: {
            members,
            owner,
            owner_since: ownerSince,
            reserved_for: reservedFor,
            now: new Date(),
            interrupt_statuses: interruptStatuses()
          },
          draft: editor?.draft ?? { line: "", cursor: 0 },
          hint: currentHint(),
          completions: editor?.completionVisible ? completionsFor(editor.draft) : [],
          completion_index: editor?.completionIndex ?? 0,
          ...dimensions()
        });
        output.write(diffChatFrame(previousFrame, frame));
        previousFrame = frame;
      } catch (error) {
        failure = error;
        stop();
      }
    }, 16);
  };
  const print = (text: string): number | null => {
    if (inline) {
      transcript.appendNotice(text);
      writeInline(text);
      return null;
    }
    if (fullscreen) {
      const id = transcript.appendNotice(text);
      redraw();
      return id;
    }
    output.write(`${text}\n`);
    return null;
  };
  // Receipts belong to event IDs, never to the latest send or the room footer.
  const awaitingReceipt = new Map<number, Set<string>>();
  let lastReceiptCheck = 0;
  const trackReceipt = (eventSeq: number, agent: string) => {
    awaitingReceipt.set(eventSeq, (awaitingReceipt.get(eventSeq) ?? new Set<string>()).add(agent));
    while (awaitingReceipt.size > MAX_AWAITED_RECEIPTS) {
      awaitingReceipt.delete(awaitingReceipt.keys().next().value!);
    }
  };
  const setDelivery = (seq: number, agent: string, state: string) => {
    rememberDelivery(seq, agent, state);
    transcript.invalidate();
    const row = inlineReceiptRows.get(seq);
    const event = trackedEvents.get(seq);
    const header = event ? render(event)?.split("\n")[0] : undefined;
    if (inline && row !== undefined && row >= inlineVisibleFloor && header !== undefined) {
      // Only repaint rows still on the live terminal screen. Cursor movement
      // cannot rewrite native scrollback. Saved history reads durable receipts.
      // Icons are one cell wide, so the header wraps to the same rows as before.
      const rows = wrapStyledLine(header, Math.max(1, dimensions().columns - 1));
      output.write("\u001b[?2026h");
      eraseComposer();
      const up = inlineOutputRows - row;
      const down = up - rows.length + 1;
      // CSI 0 B still moves one row, so never emit a zero-length move.
      output.write(`\r\u001b[${up}A${rows.map((text) => `\u001b[2K${text}`).join("\r\n")}\r${down > 0 ? `\u001b[${down}B` : ""}`);
      drawComposer();
      output.write("\u001b[?2026l");
    } else redraw();
  };
  const checkReceipts = () => {
    if (awaitingReceipt.size === 0 || Date.now() - lastReceiptCheck < RECEIPT_POLL_MS) return;
    lastReceiptCheck = Date.now();
    const seqs = [...awaitingReceipt.keys()];
    const receipts = [];
    for (let start = 0; start < seqs.length; start += RECEIPT_BATCH) {
      receipts.push(...runtime.commands.getMessageReceipts({ room_id: roomId, event_seqs: seqs.slice(start, start + RECEIPT_BATCH) }));
    }
    for (const receipt of receipts) {
      const pending = awaitingReceipt.get(receipt.event_seq);
      if (!pending?.delete(receipt.agent_id)) continue;
      if (pending.size === 0) awaitingReceipt.delete(receipt.event_seq);
      setDelivery(receipt.event_seq, receipt.agent_id, "delivered");
      if (!terminal) print(`${sanitizeChatText(nameOf(receipt.agent_id))}: delivered`);
    }
  };
  const reportRoomClosed = () => {
    exitReason = "tt chat: the room has closed.";
    if (!fullscreen) print("The room has closed.");
  };
  const restore = () => {
    editor?.close();
    if (inlineActive) {
      eraseComposer();
      output.write("\u001b[?2026l\u001b[?2004l");
      inlineActive = false;
    }
    if (!screenActive) return;
    screenActive = false;
    output.write(
      "\u001b[?2026l\u001b[?1000l\u001b[?1006l\u001b[?2004l\u001b[?1049l\u001b[?25h"
    );
  };
  const stop = () => {
    if (closed && !screenActive && !inlineActive && !rl) return;
    closed = true;
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = null;
    rl?.close();
    rl = null;
    restore();
  };
  const onResize = () => {
    // Reflow invalidates physical row anchors; never overwrite a different
    // message using coordinates recorded at the old width.
    inlineReceiptRows.clear();
    inlineOutputRows = 0;
    inlineVisibleFloor = 0;
    // Reflow can move rows both before and after the editor cursor. Rebuild
    // the visible tail from the model instead of guessing a cursor-up distance.
    // Home + ED0 clears only the active area; ED2 may push it into scrollback
    // in some terminals, and ED3 would erase history.
    if (inline) {
      inlineFrame = null;
      editor?.resize(dimensions().columns - 1);
      const draft = editor?.draft ?? { line: "", cursor: 0 };
      const panel = renderInlinePanel({ room_path: joined.canonical_path, room_strip: roomStrip, panel: rolesPanelLines(), transcript, format: formatContext(),
        status: { members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(),
          interrupt_statuses: interruptStatuses() },
        draft, hint: currentHint(), completions: editor?.completionVisible ? completionsFor(draft) : [],
        completion_index: editor?.completionIndex ?? 0, ...dimensions() });
      const tailHeight = Math.max(0, dimensions().rows - panel.lines.length);
      const tail = transcript.viewport(tailHeight, Math.max(1, dimensions().columns - 1), formatContext());
      output.write("\u001b[?2026h\u001b[H\u001b[J");
      if (tail.length) output.write(tail.join("\r\n") + "\r\n");
      inlineOutputRows = tail.length;
      for (const [seq, row] of transcript.receiptRows(tailHeight, Math.max(1, dimensions().columns - 1), formatContext())) {
        inlineReceiptRows.set(seq, row);
      }
      drawComposer();
      output.write("\u001b[?2026l");
      return;
    }
    editor?.resize(dimensions().columns - 1);
    previousFrame = null;
    redraw();
  };

  // getRoomState is a read RPC that also refreshes this observer's presence,
  // which keeps it addressable by agents replying with `tt msg send`.
  const refreshMembers = () => {
    const state = runtime.commands.getRoomState({
      room_id: roomId,
      agent_id: selfId,
      process_metadata: identity.process_metadata
    });
    members = state.members;
    if ((state.room.owner ?? null) !== owner) {
      ownerSince = null;
    }
    owner = state.room.owner ?? null;
    reservedFor = state.room.reserved_for ?? null;
    nameOf = buildNameResolver(
      [...members.map((member) => member.agent_id), selfId],
      selfId,
      new Map(
        members
          .filter(
            (member) =>
              member.agent_id.startsWith("human:") && member.display_name
          )
          .map((member) => [member.agent_id, member.display_name!])
      )
    );
    const signature = JSON.stringify(
      members
        .map((member) => ({
          id: member.agent_id,
          name: member.agent_id.startsWith("human:")
            ? member.display_name
            : null
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    );
    if (signature !== namesSignature) {
      namesSignature = signature;
      transcript.invalidate();
    }
    lastPresenceRefresh = Date.now();
  };

  const render = (event: RoomEvent) => formatChatEvent(event, formatContext());

  const hydrateReceipts = (events: RoomEvent[]) => {
    const seqs = events.filter(event => event.event_type === "message_sent" && event.from_agent_id?.startsWith("human:"))
      .map(event => event.event_seq);
    for (let start = 0; start < seqs.length; start += RECEIPT_BATCH) {
      for (const receipt of runtime.commands.getMessageReceipts({ room_id: roomId, event_seqs: seqs.slice(start, start + RECEIPT_BATCH) })) {
        rememberDelivery(receipt.event_seq, receipt.agent_id, "delivered");
      }
    }
    if (seqs.length) transcript.invalidate();
  };

  const scrollHistory = (amount: number) => {
    const { columns, rows } = dimensions();
    const draft = editor?.draft ?? { line: "", cursor: 0 };
    const height = chatTranscriptHeight({ draft, columns, rows, room_path: joined.canonical_path });
    if (!height) return;
    if (transcript.following && transcript.oldestEventSeq !== undefined) {
      historyCursor = transcript.oldestEventSeq;
      historyExhausted = false;
    }
    if (amount < 0 && !historyExhausted && transcript.needsEarlier(amount, height, columns - 1, formatContext())) {
      // Skip pages containing only hidden system events, but bound the work
      // per keystroke. A later upward scroll continues from the saved cursor.
      for (let page = 0; page < 10 && !historyExhausted; page++) {
        const earlier = runtime.commands.getRecentRoomEvents({
          room_id: roomId, limit: 100, before_event_seq: historyCursor,
          event_types: showTurnEvents ? undefined : CONVERSATION_EVENTS
        });
        if (earlier.length === 0) { historyExhausted = true; break; }
        historyCursor = earlier[0].event_seq;
        historyExhausted = earlier.length < 100;
        hydrateReceipts(earlier);
        const visible = earlier.filter((event) => render(event) !== null);
        transcript.prependEvents(visible, height, columns - 1, formatContext());
        if (visible.length) break;
      }
    }
    transcript.scrollBy(amount, height, columns - 1, formatContext());
    redraw();
  };

  const coloredName = (agentId: string) =>
    formatChatAgent(
      {
        self_agent_id: selfId,
        name_of: nameOf,
        color: options.color,
        show_turn_events: showTurnEvents
      },
      agentId
    );

  const describeRoom = () => {
    const others = members.filter((member) => member.agent_id !== selfId);
    const present = others.filter((member) => member.process_liveness !== "gone");
    const ended = others.filter((member) => member.process_liveness === "gone");
    const who =
      present.length > 0
        ? present.map((member) => coloredName(member.agent_id)).join(", ")
        : "no agents yet";
    const stick = owner
      ? `${coloredName(owner)} has the stick`
      : "nobody has the stick";
    const endedNote =
      ended.length > 0
        ? ` · ended: ${ended.map((member) => coloredName(member.agent_id)).join(", ")}`
        : "";
    return `In the room: ${who} · ${stick}${endedNote}`;
  };

  const send = (to: string[], body: string, interrupt: boolean) => {
    // No mention, or @everyone, is one room message that reaches every agent.
    // Named mentions narrow it: one name is a directed message, several share
    // a single message listing them. Nothing is ever sent once per agent.
    let route: { to_agent_id?: string; to_agent_ids?: string[] } = {};
    if (to.length > 0 && !to.some((selector) => EVERYONE_SELECTORS.includes(selector))) {
      refreshMembers();
      const resolved = resolveChatRecipients(to, members, selfId);
      if ("error" in resolved) {
        const departed = [...departedAgents].filter((agentId) =>
          resolved.unmatched.some(
            (selector) =>
              agentId.toLowerCase().startsWith(selector) ||
              nameOf(agentId).toLowerCase().startsWith(selector)
          )
        );
        print(
          departed.length > 0
            ? `! ${sanitizeChatText(departed.map((agentId) => nameOf(agentId)).join(", "))} left the room and can't receive messages until it rejoins.`
            : `! ${sanitizeChatText(resolved.error)}`
        );
        return;
      }
      route = resolved.agent_ids.length === 1
        ? { to_agent_id: resolved.agent_ids[0] }
        : { to_agent_ids: resolved.agent_ids };
    }
    redraw();
    void runtime.commands.sendMessageAndWake(identity, {
      room_id: roomId,
      body,
      ...route,
      delivery_hint: interrupt ? "interrupt" : "normal"
    }, (delivery, sent) => {
      if (closed) return;
      const received = runtime.commands.getMessageReceipts({ room_id: roomId, event_seqs: [sent.event_seq] })
        .some((receipt) => receipt.agent_id === delivery.agent_id);
      const state = received ? "delivered" : describeChatDelivery(delivery);
      setDelivery(sent.event_seq, delivery.agent_id, state);
      if (!terminal) print(`${sanitizeChatText(nameOf(delivery.agent_id))}: ${state}`);
      if (!received) trackReceipt(sent.event_seq, delivery.agent_id);
    })
    .catch(() => { if (!closed) print("! Message delivery could not be confirmed."); });
  };

  const runCommand = (name: string, args = "") => {
    switch (name) {
      case "quit":
      case "exit":
      case "q":
        stop();
        return;
      case "bottom":
        if (inline) {
          print("Use your terminal's scroll-to-bottom shortcut to return to live messages.");
          return;
        }
        transcript.scrollToBottom();
        redraw();
        return;
      case "older": {
        if (!inline) { scrollHistory(-100); return; }
        if (historyExhausted) { print("No older saved messages."); return; }
        const entries: RoomEvent[] = [];
        for (let page = 0; page < 10 && !historyExhausted; page++) {
          const earlier = runtime.commands.getRecentRoomEvents({
            room_id: roomId, limit: 100, before_event_seq: historyCursor,
            event_types: showTurnEvents ? undefined : CONVERSATION_EVENTS
          });
          // The service applies all filters before LIMIT; a short page is EOF.
          historyExhausted = earlier.length < 100;
          if (earlier.length) historyCursor = earlier[0].event_seq;
          entries.push(...earlier.filter(event => render(event) !== null));
          if (entries.length) break;
        }
        if (!entries.length) {
          print(historyExhausted ? "No older saved messages." : "No visible messages in this page; use /older to continue.");
          return;
        }
        hydrateReceipts(entries);
        const lines = entries.map(event => render(event)!).join("\n\n");
        print(`── Earlier saved messages ──\n${lines}\n── End of earlier page · /older for more ──`);
        return;
      }
      case "who":
        refreshMembers();
        print(describeRoom());
        return;
      case "roles": {
        const [action, target, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        try {
          if (!action) {
            if (editor) { openRolesPanel(); return; }
            print(roomRoleBlock(runtime, roomId, null));
            return;
          }
          if (action === "default") {
            if (!target) { print("Usage: /roles default <harness> <roles|none|clear>"); return; }
            const roles = parseRoleList(rest.join(" "));
            writeUserRoleDefault(target, roles);
            print(`Default roles for ${sanitizeChatText(target)}: ${roles === null ? "bundled" : roles.join(", ") || "none"}.`);
            return;
          }
          if (action === "set") {
            if (!target) { print("Usage: /roles set <agent|harness> <roles|none|clear>"); return; }
            void applyRoleChanges(runtime, identity, roomId, [{ subject: parseRoleSubject(target), roles: parseRoleList(rest.join(" ")) }])
              .then((result) => print(`Roles v${result.version} applied; told ${result.recipients.map((id) => sanitizeChatText(nameOf(id))).join(", ") || "nobody"}.`))
              .catch((error) => print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`));
            return;
          }
          print("Usage: /roles · /roles set <agent|harness> <roles|none|clear> · /roles default <harness> <roles|none|clear>");
        } catch (error) {
          print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }
      case "rooms": {
        if (!consoleState) { print("This console shows one room."); return; }
        refreshStrip();
        const current = `* ${sanitizeChatText(joined.canonical_path)} (here)`;
        print([current, ...stripOrder.map((room) =>
          `  #${sanitizeChatText(roomNames.get(room.room_id) ?? roomShortName(room))}  ${sanitizeChatText(room.canonical_path)}`),
          stripOrder.length ? "Switch with /go <room> or Alt+←/→." : "No other rooms with agents in this repository."].join("\n"));
        redraw();
        return;
      }
      case "go": {
        if (!consoleState) { print("This console shows one room."); return; }
        if (!args.trim()) { print("Usage: /go <room>, e.g. /go api, /go root"); return; }
        try {
          // /go stays inside this console's repository.
          const local = runtime.commands.listRooms({}).rooms.filter((room) =>
            isWithinOrSame(room.canonical_path, consoleState.anchor) && !insideNestedRepository(room.canonical_path, consoleState.anchor));
          let room: PathRoom;
          try {
            room = resolveRoomSelector(local, args.trim(), consoleState.anchor);
          } catch (error) {
            // A directory (relative to this checkout) opens its room the way a
            // join from there would, e.g. a committed declaration nobody has
            // joined yet on this machine. Only for a plain path-shaped argument
            // with no match at all: `#name` and ambiguous names keep their error.
            const target = args.trim();
            const noMatch = error instanceof Error && error.message.startsWith("No open room matches");
            const opened = noMatch && !target.startsWith("#") ? openRoomAtPath(target) : null;
            if (!opened) throw error;
            room = opened;
          }
          switchTo(room);
        } catch (error) {
          print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }
      case "kick": {
        refreshMembers();
        const { target, force, reason } = resolveChatKick(args, members, selfId);
        let ownershipNote = "";
        try {
          const result = runtime.commands.kickMember(identity, { room_id: roomId, target_agent_id: target.agent_id, force, reason });
          if (result.target_was_owner) ownershipNote = " Its turn was revoked.";
          else if (result.target_was_reserved_for) ownershipNote = " Its next-turn reservation was cleared.";
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "target_active") {
            const state = target.process_liveness === "alive" ? "is still running" :
              target.process_liveness === "gone" ? "has just ended; the liveness grace period has not elapsed" : "is not confirmed ended";
            print(`! ${sanitizeChatText(target.agent_id)} ${state}. Use /kick --force ${sanitizeChatText(target.agent_id)} to remove it from the room.`);
            return;
          }
          throw error;
        }
        refreshMembers();
        print(`Removed ${sanitizeChatText(target.agent_id)} from the room.${ownershipNote} The harness was not stopped.`);
        return;
      }
      case "events":
        showTurnEvents = !showTurnEvents;
        transcript.invalidate();
        print(`Stick events ${showTurnEvents ? "shown" : "hidden"}.`);
        return;
      case "help":
        print(formatChatHelp(dimensions().columns - 1, options.color, args.trim() === "keys", inline));
        return;
      default:
        print(`! Unknown command /${name}. Try /help.`);
    }
  };

  // Messages are separated by a blank line; consecutive stick/membership
  // lines stay compact underneath the message they follow.
  let lastPrinted: "message" | "system" | "info" = "info";
  const printEvent = (event: RoomEvent, historical = false) => {
    if (!historical && event.event_type === "message_sent" && event.from_agent_id?.startsWith("human:")) {
      // Named recipients are known from the event itself; a room message's
      // recipients come from this console's own send result instead.
      // Every recipient gets a pending icon from the first paint, taken from
      // the send-time snapshot on the event itself, so later acks only swap it.
      const payload = event.payload as { recipients?: unknown; sent_to?: unknown } | null;
      const listed = Array.isArray(payload?.recipients) ? payload.recipients : payload?.sent_to;
      const recipients = event.to_agent_id ? [event.to_agent_id]
        : Array.isArray(listed) ? listed.filter((id): id is string => typeof id === "string") : [];
      if (recipients.length > 0) trackedEvents.set(event.event_seq, event);
      while (trackedEvents.size > 2_000) trackedEvents.delete(trackedEvents.keys().next().value!);
      for (const agent of recipients) {
        const states = deliveryStates.get(event.event_seq);
        if (!states?.has(agent)) rememberDelivery(event.event_seq, agent, "sent");
        if (deliveryStates.get(event.event_seq)?.get(agent) !== "delivered") trackReceipt(event.event_seq, agent);
      }
    }
    if (render(event) !== null && isChatConversationActivity(event)) {
      if (startsChatConversation(previousConversationEvent, event) &&
          (!historyBefore || Date.parse(event.created_at) > Date.parse(historyBefore))) {
        historyBefore = event.created_at;
        transcript.invalidate();
      }
      previousConversationEvent = event;
    }
    if (event.event_type === "leave" && event.from_agent_id) {
      departedAgents.add(event.from_agent_id);
    } else if (event.event_type === "kick" && event.to_agent_id) {
      departedAgents.add(event.to_agent_id);
    } else if (event.event_type === "join" && event.from_agent_id) {
      departedAgents.delete(event.from_agent_id);
    }
    if (terminal) transcript.appendEvent(event);
    if (fullscreen) {
      if (
        event.event_type === "message_sent" &&
        event.to_agent_id === selfId &&
        event.from_agent_id !== selfId
      )
        output.write("\u0007");
      redraw();
      return;
    }
    const line = render(event);
    if (line === null) {
      return;
    }
    const section = chatSectionLabel(event, formatContext());
    if (section !== printedSection) {
      if (inline) writeInline(`── ${section} ──`);
      else print(`── ${section} ──`);
      printedSection = section;
    }
    const isMessage = event.event_type === "message_sent";
    if (isMessage || lastPrinted === "message") {
      if (inline) writeInline(""); else print("");
    }
    const forMe =
      isMessage &&
      event.to_agent_id === selfId &&
      event.from_agent_id !== selfId;
    const headerRow = inlineOutputRows;
    if (inline) writeInline(forMe ? `${line}\u0007` : line);
    else print(forMe && terminal ? `${line}\u0007` : line);
    if (inline && deliveryStates.has(event.event_seq)) inlineReceiptRows.set(event.event_seq, headerRow);
    lastPrinted = isMessage ? "message" : "system";
  };

  const handleLine = (line: string) => {
    const parsed = parseChatInput(line);
    switch (parsed.kind) {
      case "empty":
        return;
      case "error":
        print(`! ${parsed.message}`);
        return;
      case "command":
        transcript.scrollToBottom();
        runCommand(parsed.name, parsed.args);
        return;
      case "send":
        transcript.scrollToBottom();
        send(parsed.to, parsed.body, parsed.interrupt);
        return;
    }
  };

  const onCycleRoom = (direction: -1 | 1) => {
    if (!consoleState) return;
    refreshStrip();
    const ring = [joined.canonical_path, ...stripOrder.map((room) => room.canonical_path)].sort();
    if (ring.length < 2) { print("No other rooms with agents in this repository."); return; }
    const next = ring[(ring.indexOf(joined.canonical_path) + direction + ring.length) % ring.length];
    const room = stripOrder.find((candidate) => candidate.canonical_path === next);
    if (room) switchTo(room);
  };
  const onEmptyEscape = () => {
    void (async () => {
      try {
        refreshMembers();
        const plan = planChatInterrupts(members, selfId);
        if (plan.kind === "none") {
          interruptHint = { text: "nothing to interrupt", until: Date.now() + 3_000 };
          lastInterruptSignature = interruptSignature();
          redraw();
          return;
        }
        interruptHint = null;
        await Promise.all(plan.steps.map(async (step) => {
          if (step.kind === "unsupported") return;
          if (step.kind === "codex") {
            const member = members.find((candidate) => candidate.agent_id === step.agent_id);
            const paneResult = member ? interruptCodexHerdr(member) : "unavailable";
            const result = paneResult === "unavailable"
              ? await interruptCodexThread(step.thread_id) : paneResult;
            if (result !== "idle") interruptIndicators.set(step.agent_id, {
              kind: "timed", label: result === "sent" ? "interrupted" : `interrupt ${result}`,
              until: Date.now() + 3_000
            });
            return;
          }
          const result = requestHookInterrupt("claude", step.session_id);
          interruptIndicators.set(step.agent_id, result === "failed"
            ? { kind: "timed", label: "interrupt failed", until: Date.now() + 3_000 }
            : { kind: "claude", session_id: step.session_id });
        }));
        if (!closed) {
          lastInterruptSignature = interruptSignature();
          redraw();
        }
      } catch (error) {
        if (isRoomGone(error)) {
          reportRoomClosed();
          stop();
        } else if (!closed) {
          interruptHint = { text: "interrupt unavailable", until: Date.now() + 3_000 };
          lastInterruptSignature = interruptSignature();
          redraw();
        }
      }
    })();
  };
  const submit = (line: string) => {
    try {
      handleLine(line);
    } catch (error) {
      if (isRoomGone(error)) {
        reportRoomClosed();
        stop();
      } else
        print(
          `! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`
        );
    }
    redraw();
  };
  const onSignal = () => stop();
  const onInterrupt = () => editor?.clear();
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  if (terminal) {
    process.on("SIGINT", onInterrupt);
    process.on("exit", restore);
    process.on("uncaughtExceptionMonitor", restore);
    output.on("resize", onResize);
  }
  try {
    if (fullscreen) {
      screenActive = true;
      output.write(
        "\u001b[?1049h\u001b[?2004h" +
          (options.mouse === true ? "\u001b[?1000h\u001b[?1006h" : "")
      );
      editor = new ChatInputController({
        input: options.input,
        columns: dimensions().columns - 1,
        onChange: () => {
          if (editor?.draft.line) { hint = null; interruptHint = null; }
          redraw();
        },
        onSubmit: submit,
        onClear: () => {
          hint = "type /quit to exit";
        },
        onEmptyEscape,
        onCycleRoom,
        onQuit: stop,
        onBottom: () => {
          transcript.scrollToBottom();
          redraw();
        },
        onScroll: (kind, amount) => {
          const { columns, rows } = dimensions();
          const draft = editor?.draft ?? { line: "", cursor: 0 };
          const height = chatTranscriptHeight({ draft, columns, rows, room_path: joined.canonical_path });
          if (height === 0) return;
          scrollHistory(amount * (kind === "pages" ? Math.max(1, height - 1) : 1));
        },
        onWheel: (row, direction) => {
          const size = dimensions();
          const draft = editor?.draft ?? { line: "", cursor: 0 };
          const layout = { ...size, draft, room_path: joined.canonical_path };
          const region = chatWheelRegion(layout, row);
          if (region === "prompt") editor?.scrollPrompt(direction);
          else if (region === "transcript") {
            scrollHistory(direction * 3);
          }
          redraw();
        },
        completionCount: (draft) => completionsFor(draft).length,
        complete: (draft, index) => {
          const matches = completionsFor(draft);
          return matches[Math.min(index, matches.length - 1)]?.draft ?? null;
        }
      });
    } else if (inline) {
      // The terminal keeps its normal screen and owns scrollback, selection,
      // and the wheel. The same editor as full-screen mode handles bracketed
      // paste, multiline drafts, and completion; only the drawing differs.
      inlineActive = true;
      output.write("\u001b[?2004h");
      editor = new ChatInputController({
        input: options.input,
        columns: dimensions().columns - 1,
        onChange: () => {
          if (editor?.draft.line) interruptHint = null;
          drawComposer();
        },
        onSubmit: (line) => {
          eraseComposer();
          submit(line);
          drawComposer();
        },
        onClear: () => {
          hint = "type /quit to exit";
        },
        onEmptyEscape,
        onCycleRoom,
        onQuit: stop,
        // Scrollback belongs to the terminal in this mode.
        onBottom: () => {},
        onScroll: () => {},
        completionCount: (draft) => completionsFor(draft).length,
        complete: (draft, index) => {
          const matches = completionsFor(draft);
          return matches[Math.min(index, matches.length - 1)]?.draft ?? null;
        }
      });
      drawComposer();
    } else {
      rl = readline.createInterface({ input: options.input, terminal: false });
      rl.on("line", submit);
      rl.on("close", () => {
        closed = true;
      });
    }
    refreshMembers();
    if (owner) {
      const [lastGrant] = runtime.commands.getRecentRoomEvents({
        room_id: roomId,
        limit: 1,
        event_types: OWNERSHIP_EVENTS
      });
      ownerSince =
        lastGrant?.to_agent_id === owner ? lastGrant.created_at : null;
    }
    print(`Talking Stick chat · ${sanitizeChatText(joined.canonical_path)}`);
    if (!fullscreen) {
      print(describeRoom());
    }
    print(
      "Type to message the room, @agent anywhere in the text to message matching agents, /help for commands."
    );

    const head = runtime.commands.getLatestEventSeq({ room_id: roomId });
    const historyEvents =
      options.history === 0
        ? []
        : runtime.commands
            .getRecentRoomEvents({
              room_id: roomId,
              limit: HISTORY_SCAN_EVENTS,
              event_types: showTurnEvents ? undefined : CONVERSATION_EVENTS
            })
            .filter(
              (event) => event.event_seq <= head && render(event) !== null
            )
            .slice(-Math.max(0, options.history));
    historyCursor = historyEvents[0]?.event_seq ?? head + 1;
    // Determine the latest conversation before rendering so its predecessor
    // is dimmed even on the first frame (including non-terminal output).
    const conversationEvents = historyEvents.filter(isChatConversationActivity);
    for (let index = 1; index < conversationEvents.length; index += 1) {
      if (startsChatConversation(conversationEvents[index - 1], conversationEvents[index])) {
        historyBefore = conversationEvents[index].created_at;
      }
    }
    hydrateReceipts(historyEvents);
    for (const event of historyEvents) {
      printEvent(event, true);
    }

    redraw();

    let cursor = head;
    viewedSeq = head;
    const savedDraft = consoleState?.drafts.get(roomId);
    if (savedDraft) editor?.setDraft(savedDraft);
    if (refreshStrip()) redraw();
    let busyAttempts = 0;
    while (!closed) {
      try {
        let result;
        try {
          result = await runtime.commands.waitForEvents({
            agent_id: selfId,
            room_id: roomId,
            after_event_seq: cursor,
            target_agent_id: "any",
            max_wait_ms: options.poll_ms ?? DEFAULT_POLL_MS
          });
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "room_not_found") {
            reportRoomClosed();
            break;
          }
          throw error;
        }

        const stateChanged = result.events.some((event) =>
          STATE_CHANGE_EVENTS.has(event.event_type)
        );
        const statusStale = Date.now() - lastStatusDraw >= STATUS_REFRESH_MS;
        if (
          stateChanged ||
          statusStale ||
          Date.now() - lastPresenceRefresh >= PRESENCE_REFRESH_MS
        ) {
          refreshMembers();
        }
        if (consoleState && Date.now() - lastStripRefresh >= STRIP_REFRESH_MS && refreshStrip()) redraw();
        hydrateReceipts(result.events);
        for (const event of result.events) {
          if (OWNERSHIP_EVENTS.includes(event.event_type)) {
            ownerSince = event.created_at;
          }
          printEvent(event);
          if (event.event_type === "close") {
            reportRoomClosed();
            closed = true;
          }
        }
        cursor = result.cursor_event_seq;
        viewedSeq = cursor;
        if (!closed) checkReceipts();
        const interruptChanged = (interruptIndicators.size > 0 || interruptHint !== null) &&
          interruptSignature() !== lastInterruptSignature;
        if ((stateChanged || statusStale || interruptChanged) && !closed) {
          lastInterruptSignature = interruptSignature();
          redraw();
          lastStatusDraw = Date.now();
        }
        if (busyAttempts) {
          busyAttempts = 0;
          hint = null;
          redraw();
        }
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        // Presence and maintenance writes may contend even during a read
        // cycle. Keep the editor alive and retry from the last rendered event.
        // Never retry a send here: its commit may already have succeeded.
        busyAttempts++;
        hint = "database busy · retrying";
        if (busyAttempts === 1) {
          if (terminal) redraw();
          else print("Database busy; waiting to reconnect.");
        }
        if (!closed) await sleep(Math.min(2_000, 100 * 2 ** Math.min(busyAttempts - 1, 5)));
      }
    }
    if (failure) throw failure;
  } catch (error) {
    if (!isRoomGone(error)) throw error;
    reportRoomClosed();
  } finally {
    output.off("resize", onResize);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("SIGINT", onInterrupt);
    process.off("exit", restore);
    process.off("uncaughtExceptionMonitor", restore);
    stop();
    if (fullscreen && exitReason) output.write(`${exitReason}\n`);
    else if (inline && exitReason) output.write(`\r\u001b[2K${exitReason}\n`);
    try {
      await runtime.commands.flushWakes(roomId);
    } catch {
      // Pending wakes remain durable; cleanup must not replace the real error.
    }
    if (consoleState) {
      consoleState.last_seen.set(roomId, Math.max(viewedSeq, consoleState.last_seen.get(roomId) ?? 0));
      if (editor) consoleState.drafts.set(roomId, editor.draft.line);
    }
    // A switching console stays a member so agents here can still reply to it;
    // the caller leaves every visited room when chat exits.
    if (!switchTarget) {
      try {
        runtime.commands.leaveRoom(identity, { room_id: roomId });
      } catch {
        // The room may already be gone; leaving is best-effort on exit.
      }
    }
  }
  return switchTarget ? { kind: "switch", room: switchTarget } : { kind: "quit" };
}


// Short names for the strip: `root` for the repository room, else the
// declared name or basename, lengthened to the shortest unique path suffix
// when two rooms share it (`web/api`, `svc/api`).
export function uniqueRoomNames(rooms: ReadonlyArray<Pick<PathRoom, "room_id" | "canonical_path">>, anchor: string): Map<string, string> {
  const names = new Map<string, string>();
  const base = (room: Pick<PathRoom, "canonical_path">) => room.canonical_path === anchor ? "root" : roomShortName(room);
  const counts = new Map<string, number>();
  for (const room of rooms) counts.set(base(room), (counts.get(base(room)) ?? 0) + 1);
  for (const room of rooms) {
    let name = base(room);
    if ((counts.get(name) ?? 0) > 1 && name !== "root") {
      const parts = path.relative(anchor, room.canonical_path).split(path.sep);
      for (let take = 2; take <= parts.length; take++) {
        name = parts.slice(-take).join("/");
        const suffix = name;
        if (rooms.filter((other) => other.canonical_path.endsWith(`${path.sep}${suffix.split("/").join(path.sep)}`)).length === 1) break;
      }
    }
    names.set(room.room_id, name);
  }
  return names;
}

function isRoomGone(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === "room_not_found";
}
