import { describe, expect, test } from "vitest";
import { createMemberMenu, memberMenuKey, renderMemberMenu } from "../src/cli/member-menu.js";

describe("member actions", () => {
  test("selects an exact session and requires explicit removal confirmation", () => {
    const menu = createMemberMenu(["codex:first", "codex:second"]);
    memberMenuKey(menu, "down");
    memberMenuKey(menu, "enter");
    expect(menu.target).toBe("codex:second");
    memberMenuKey(menu, "down");
    expect(memberMenuKey(menu, "enter")).toBe("none");
    expect(menu.phase).toBe("confirm");
    expect(memberMenuKey(menu, "enter")).toBe("close");
    memberMenuKey(menu, "down");
    expect(memberMenuKey(menu, "enter")).toBe("kick");
  });
  test("right-click target opens actions and Escape cancels", () => {
    const menu = createMemberMenu(["codex:first"], "codex:first");
    expect(memberMenuKey(menu, "enter")).toBe("message");
    expect(memberMenuKey(menu, "escape")).toBe("close");
    expect(renderMemberMenu(menu, 4)[0]).toBe("codex:first");
  });
  test("member picker scrolls to selected session", () => {
    const menu = createMemberMenu(["one", "two", "three", "four"]);
    memberMenuKey(menu, "up");
    expect(renderMemberMenu(menu, 3)).toEqual(["Room members", "› four", "↑↓ choose · Enter select · Esc cancel"]);
  });
});

test("member choices and selection use the shared palette without changing their text", () => {
  const menu = createMemberMenu(["codex:aa", "claude:bb"]);
  const plain = renderMemberMenu(menu, 5, id => id.split(":")[0]);
  const colored = renderMemberMenu(menu, 5, id => id.split(":")[0], { color: true });
  expect(colored.map(line => line.replace(/\u001b\[[0-9;]*m/g, ""))).toEqual(plain);
  expect(colored[1]).toContain("38;5;78");
  expect(colored[1]).toContain("48;5;237");
  expect(colored[2]).toContain("38;5;209");
});
