import { paintStyle, themeStyle, type ChatColorMode } from "./theme.js";

export type ChatNoticeKind = "info" | "ok" | "error";

/** Console results have a shared gutter, separate from authored chat messages. */
export function formatChatNotice(text: string, color: boolean, mode?: ChatColorMode, kind?: ChatNoticeKind): string {
  const status = kind ?? (text.startsWith("!") ? "error" : /^(Removed |Roles applied|Theme:)/.test(text) ? "ok" : "info");
  const token = status === "error" ? "error" : status === "ok" ? "ok" : "ref";
  const label = status === "error" ? "error" : status === "ok" ? "done" : "info";
  const gutter = paintStyle(color, themeStyle(token, mode), "│");
  const content = text.replace(/^!\s*/, "").split("\n");
  return ["", ...content.map((line, index) => `${gutter} ${index === 0 ? paintStyle(color, `1;${themeStyle(token, mode)}`, `${label} · `) : ""}${line}`)].join("\n");
}
