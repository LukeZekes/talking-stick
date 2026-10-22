import fs from "node:fs";
import { RoomTree, type TreeRoom, type TreeAction } from "./room-tree.js";
import { sanitizeChatText } from "./chat-format.js";
import { paintStyle, themeStyle } from "./theme.js";
import { formatRelativeTime } from "./output.js";
import type { ChatModalKey } from "./chat-input.js";

export interface NavigatorRoom extends TreeRoom {
  id: string;
  name: string;
  consoles: number;
  active: boolean;
  last_activity_at: string;
}
export type NavigatorAction = TreeAction | { kind: "room"; id: string };
const SORTS = ["activity", "name", "path", "members"] as const;

export class RoomNavigator {
  tree: RoomTree;
  view: "rooms" | "folders" = "folders";
  query = "";
  searching = false;
  allOpen = false;
  sort: typeof SORTS[number] = "activity";
  private selectedPath: string;
  private entries: NavigatorRoom[];

  constructor(root: string, rooms: NavigatorRoom[], readonly current: string) {
    this.entries = rooms;
    this.tree = new RoomTree(root, rooms, current, true);
    this.selectedPath = current;
  }

  get rooms(): NavigatorRoom[] { return this.entries; }
  set rooms(rooms: NavigatorRoom[]) { this.entries = rooms; this.tree.rooms = rooms; }
  get selected(): string { return this.view === "folders" ? this.tree.selected : this.selection()?.path ?? ""; }
  get confirm(): string | null { return this.tree.confirm; }
  set confirm(value: string | null) { this.tree.confirm = value; }
  get notice(): string | null { return this.tree.notice; }
  set notice(value: string | null) { this.tree.notice = value; }

  list(): NavigatorRoom[] {
    const query = this.query.toLocaleLowerCase();
    return this.entries.filter(room => (this.allOpen || room.active || room.path === this.current) &&
      `${room.name}\n${room.path}`.toLocaleLowerCase().includes(query)).sort((a, b) => {
      const primary = this.sort === "activity" ? b.last_activity_at.localeCompare(a.last_activity_at)
        : this.sort === "members" ? (b.agents + b.consoles) - (a.agents + a.consoles)
        : this.sort === "name" ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path);
      return primary || a.path.localeCompare(b.path);
    });
  }

  private selection(): NavigatorRoom | undefined {
    const list = this.list();
    return list.find(room => room.path === this.selectedPath) ?? list[0];
  }

  /** A search consumes literal shortcut letters before the modal key mapping. */
  text(char: string): boolean {
    if (!this.searching) return false;
    if (char === "\u007f" || char === "\b") this.query = [...this.query].slice(0, -1).join("");
    else if (char >= " " && char !== "\u007f") this.query += char;
    else return false;
    return true;
  }

  key(key: ChatModalKey): NavigatorAction {
    if (this.searching) {
      if (key === "escape") { this.searching = false; return { kind: "none" }; }
      if (key === "enter" || key === "tab") this.searching = false;
      else if (!["up", "down", "page_up", "page_down"].includes(key)) return { kind: "none" };
    }
    if (this.confirm) return this.tree.key(key);
    if (key === "tab") {
      if (this.view === "rooms") {
        const selected = this.selection();
        if (selected) this.tree = treeForSelection(this.tree, selected.path, this.rooms, this.current);
      }
      this.view = this.view === "rooms" ? "folders" : "rooms";
      return { kind: "none" };
    }
    if (key === "escape") return { kind: "close" };
    if (this.view === "folders") {
      if (key === "parent") { this.tree.parent(); return { kind: "none" }; }
      return this.tree.key(key);
    }
    if (key === "search") { this.searching = true; return { kind: "none" }; }
    if (key === "sort") this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length];
    if (key === "all") this.allOpen = !this.allOpen;
    const list = this.list();
    const selected = this.selection();
    if (key === "up" || key === "down" || key === "page_up" || key === "page_down") {
      const delta = key === "up" ? -1 : key === "down" ? 1 : key === "page_up" ? -10 : 10;
      const index = list.findIndex(room => room === selected);
      this.selectedPath = list[Math.max(0, Math.min(list.length - 1, index + delta))]?.path ?? "";
    }
    if (key === "enter" && selected) return { kind: "room", id: selected.id };
    return { kind: "none" };
  }

  render(maxLines: number, resolvedRoom: string, color: boolean): string[] {
    const safe = sanitizeChatText;
    const accent = (text: string) => paintStyle(color, themeStyle("accent"), text);
    if (this.view === "folders") {
      const lines = this.tree.render(Math.max(1, maxLines - 1), resolvedRoom, color);
      return [`Folders · Tab rooms · Backspace up · ${safe(this.tree.root)}`, ...lines].slice(0, maxLines);
    }
    const list = this.list();
    const selected = this.selection();
    const capacity = Math.max(1, Math.floor((maxLines - 3) / 2));
    const index = Math.max(0, list.findIndex(room => room === selected));
    const start = Math.max(0, index - capacity + 1);
    const lines = list.slice(start, start + capacity).flatMap(room => [
      `${room === selected ? accent("›") : " "} ${accent(safe(room.name))}${room.path === this.current ? " *" : ""} · ${room.agents} agents · ${room.consoles} consoles${room.unread ? ` · ${room.unread} unread` : ""}`,
      `  ${safe(room.path)}${fs.existsSync(room.path) ? "" : " (unavailable)"}${room.last_activity_at ? ` · ${formatRelativeTime(room.last_activity_at)}` : " · no events"}`
    ]);
    if (!lines.length) lines.push("No matching rooms.");
    return [`Rooms · ${this.allOpen ? "All open" : "Active"} · sort: ${this.sort} · ${list.length} rooms`,
      `${this.searching ? "Filter ›" : "Filter:"} ${safe(this.query) || "—"}`,
      ...lines, this.notice ?? "↑↓ select · Enter open · / filter · s sort · a active/all · Tab folders · Esc close"].slice(0, maxLines);
  }
}

function treeForSelection(tree: RoomTree, selected: string, rooms: NavigatorRoom[], current: string): RoomTree {
  if (tree.selected === selected) return tree;
  return new RoomTree(selected, rooms, current, true);
}
