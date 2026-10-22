import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RoomNavigator, type NavigatorRoom } from "../src/cli/room-navigator.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-nav-")));
  dirs.push(root);
  for (const name of ["one", "two"]) fs.mkdirSync(path.join(root, name, ".git"), { recursive: true });
  const rooms: NavigatorRoom[] = [
    { id: "a", path: path.join(root, "one"), name: "one", agents: 1, consoles: 0, unread: 2, active: true, last_activity_at: "2026-10-20" },
    { id: "b", path: path.join(root, "two"), name: "two", agents: 2, consoles: 1, unread: 0, active: true, last_activity_at: "2026-10-21" },
    { id: "c", path: path.join(root, "gone"), name: "gone", agents: 0, consoles: 0, unread: 0, active: false, last_activity_at: "2026-10-22" }
  ];
  return { root, rooms, nav: new RoomNavigator(rooms[0].path, rooms, rooms[0].path) };
}
test("active host list sorts, filters and keeps selection stable on refresh", () => {
  const { nav, rooms } = fixture();
  expect(nav.view).toBe("folders");
  nav.key("tab");
  expect(nav.render(10, "", false)[0]).toContain("Rooms · Active");
  expect(nav.list().map(room => room.id)).toEqual(["b", "a"]);
  nav.key("all");
  expect(nav.list().map(room => room.id)).toEqual(["c", "b", "a"]);
  nav.key("all");
  expect(nav.selected).toBe(rooms[0].path);
  nav.key("sort");
  expect(nav.list().map(room => room.id)).toEqual(["a", "b"]);
  nav.key("search");
  for (const char of "two") expect(nav.text(char)).toBe(true);
  expect(nav.list().map(room => room.id)).toEqual(["b"]);
  expect(nav.key("enter")).toEqual({ kind: "room", id: "b" });
  nav.rooms = rooms.map(room => ({ ...room, last_activity_at: "2026-10-23" }));
  expect(nav.selected).toBe(rooms[1].path);
  nav.key("search"); nav.text("\u007f");
  expect(nav.query).toBe("tw");
  expect(nav.tree.root).toBe(rooms[0].path);
});
test("folder parent navigation crosses repositories lazily and opens the exact selected path", () => {
  const { nav, root, rooms } = fixture();
  nav.key("parent");
  expect(nav.tree.root).toBe(root);
  expect(nav.tree.children(root)).toContain(rooms[1].path);
  nav.tree.selected = rooms[1].path;
  expect(nav.key("enter")).toEqual({ kind: "go", path: rooms[1].path });
  nav.key("tab");
  expect(nav.view).toBe("rooms");
});
test("arrows and Enter work while filtering; activity ties have deterministic path order", () => {
  const { nav, rooms } = fixture();
  nav.key("tab");
  nav.rooms = rooms.map(room => ({ ...room, last_activity_at: "2026-10-23" }));
  expect(nav.list().map(room => room.id)).toEqual(["a", "b"]);
  nav.key("search");
  nav.key("down");
  expect(nav.searching).toBe(true);
  expect(nav.key("enter")).toEqual({ kind: "room", id: "b" });
});
test("search consumes shortcut letters, empty results are bounded, unavailable live rooms remain visible", () => {
  const { nav, rooms } = fixture();
  nav.key("tab");
  nav.rooms = [...rooms, { ...rooms[2], active: true, agents: 1 }];
  nav.key("search");
  for (const char of "gone") nav.text(char);
  const text = nav.render(7, "", false).join("\n");
  expect(text).toContain("gone");
  expect(text).toContain("unavailable");
  nav.text("z");
  expect(nav.key("down")).toEqual({ kind: "none" });
  nav.key("enter");
  expect(nav.key("enter")).toEqual({ kind: "none" });
  expect(nav.render(3, "", false).length).toBeLessThanOrEqual(3);
  expect(nav.key("escape")).toEqual({ kind: "close" });
});
