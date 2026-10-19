import type { ChatModalKey } from "./chat-input.js";
import { sanitizeChatText } from "./chat-format.js";

export interface MemberMenu {
  agents: string[];
  selected: number;
  target: string | null;
  phase: "members" | "actions" | "confirm";
}
export type MemberMenuAction = "none" | "close" | "message" | "kick";

export function createMemberMenu(agents: string[], target?: string): MemberMenu {
  return { agents, selected: 0, target: target ?? null, phase: target ? "actions" : "members" };
}

export function memberMenuKey(state: MemberMenu, key: ChatModalKey): MemberMenuAction {
  if (key === "escape") return "close";
  const count = state.phase === "members" ? state.agents.length : 2;
  if (key === "up" || key === "down") {
    state.selected = count ? (state.selected + (key === "up" ? -1 : 1) + count) % count : 0;
    return "none";
  }
  if (key !== "enter") return "none";
  if (state.phase === "members") {
    state.target = state.agents[state.selected] ?? null;
    if (!state.target) return "close";
    state.phase = "actions";
    state.selected = 0;
    return "none";
  }
  if (state.phase === "actions") {
    if (state.selected === 0) return "message";
    state.phase = "confirm";
    state.selected = 0;
    return "none";
  }
  return state.selected === 1 ? "kick" : "close";
}

export function renderMemberMenu(state: MemberMenu, maxLines: number, nameOf: (id: string) => string = id => id): string[] {
  const label = (id: string) => nameOf(id) === id ? id : `${nameOf(id)} · ${id}`;
  const title = state.phase === "members" ? "Room members" : sanitizeChatText(label(state.target ?? ""));
  const choices = state.phase === "members" ? state.agents.map(label) : state.phase === "actions"
    ? ["Message", "Remove from room…"] : ["Cancel", "Remove from room (harness keeps running)"];
  const capacity = Math.max(1, maxLines - 2);
  const start = Math.max(0, state.selected - capacity + 1);
  return [title, ...choices.slice(start, start + capacity).map((label, i) =>
    `${start + i === state.selected ? "›" : " "} ${sanitizeChatText(label)}`), "↑↓ choose · Enter select · Esc cancel"];
}
