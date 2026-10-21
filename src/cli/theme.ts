// Lantern: warm signals on the terminal's own surface. Semantic tokens keep
// typing, completions and the transcript speaking the same visual language.
export type ChatColorMode = "truecolor" | "256";
export const CHAT_THEME = {
  name: "Lantern",
  colors: {
    accent: ["edcb96", 222], command: ["b8a6df", 147], mention: ["87d2df", 81],
    ref: ["92b9d0", 110], code: ["e5bb85", 180], path: ["8dc8c3", 116],
    url: ["86b5dc", 75], muted: ["92949f", 244], ok: ["a2c98c", 114],
    warn: ["d7b577", 179], error: ["e58d90", 203],
    selection: ["343640", 237], selectionText: ["f0e4d0", 223]
  },
  agents: {
    claude: ["e8a180", 209], codex: ["91c9a1", 78], gemini: ["86b5dc", 75],
    antigravity: ["b8a6df", 141], grok: ["d49fc7", 177], opencode: ["83c9c7", 44],
    human: ["e3c578", 220]
  },
  roles: [["86b5dc", 75], ["e5bb85", 214], ["d49fc7", 170], ["a2c98c", 114],
    ["e58d90", 203], ["e3c578", 229], ["b8a6df", 147], ["87d2df", 81]],
  fallback: [81, 214, 170, 114, 39, 203, 229, 147]
} as const;
export type ChatThemeToken = keyof typeof CHAT_THEME.colors;

export function terminalColorMode(env: NodeJS.ProcessEnv = process.env): ChatColorMode {
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") ? "truecolor" : "256";
}

function colorCode(color: readonly [string, number], mode: ChatColorMode, background = false): string {
  const channel = background ? 48 : 38;
  return mode === "truecolor"
    ? `${channel};2;${color[0].match(/../g)!.map(hex => parseInt(hex, 16)).join(";")}`
    : `${channel};5;${color[1]}`;
}

export function themeStyle(token: ChatThemeToken, mode: ChatColorMode = "256", background = false): string {
  return colorCode(CHAT_THEME.colors[token], mode, background);
}

export function agentColorIndex(id: string): number {
  const known = CHAT_THEME.agents[id.split(":")[0].toLowerCase() as keyof typeof CHAT_THEME.agents];
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return known?.[1] ?? CHAT_THEME.fallback[hash % CHAT_THEME.fallback.length];
}

export function agentStyle(id: string, mode: ChatColorMode = "256"): string {
  const known = CHAT_THEME.agents[id.split(":")[0].toLowerCase() as keyof typeof CHAT_THEME.agents];
  return known ? colorCode(known, mode) : `38;5;${agentColorIndex(id)}`;
}

export function roleStyle(index: number, mode: ChatColorMode = "256"): string {
  return colorCode(CHAT_THEME.roles[index % CHAT_THEME.roles.length], mode);
}

export function paintStyle(enabled: boolean, style: string, text: string): string {
  return enabled && text ? `\u001b[${style}m${text}\u001b[0m` : text;
}
