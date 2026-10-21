// Enhanced keyboard reporting lets a terminal tell Shift+Enter from Enter.
// Chat asks for the kitty protocol's "disambiguate" level and xterm's
// modifyOtherKeys level 1; a terminal that knows neither ignores both. Under
// the kitty protocol, Escape, Ctrl and Alt combinations also arrive as CSI u
// reports, so they are translated back to the legacy bytes the rest of the
// input path (and readline) already understands.

export const ENHANCED_KEYS_ON = "\u001b[>1u\u001b[>4;1m";
// Pop the kitty stack and reset modifyOtherKeys. Harmless when never pushed.
export const ENHANCED_KEYS_OFF = "\u001b[<u\u001b[>4m";

// CSI code[:alternates] ; modifiers[:event] u   (kitty)
// CSI 27 ; modifiers ; code ~                   (xterm modifyOtherKeys)
const KITTY = /^\u001b\[(\d+)(?::\d*)*(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?u$/;
// Kitty event types: 1 press, 2 repeat, 3 release.
const RELEASE = 3;
const XTERM = /^\u001b\[27;(\d+);(\d+)~$/;

function parse(sequence: string): { code: number; bits: number; release: boolean } | null {
  const kitty = KITTY.exec(sequence);
  const xterm = kitty ? null : XTERM.exec(sequence);
  if (!kitty && !xterm) return null;
  const release = Number(kitty?.[3] ?? 1) === RELEASE;
  // Modifiers are 1 + a bit set; Caps Lock and Num Lock carry no meaning here.
  const bits = (Number((kitty ? kitty[2] : xterm![1]) ?? 1) - 1) & ~(64 | 128);
  return { code: Number(kitty ? kitty[1] : xterm![2]), bits, release };
}

/** Shift+Enter in either report form, whatever the lock keys. */
export function isShiftEnter(sequence: string): boolean {
  const key = parse(sequence);
  return key !== null && !key.release && key.code === 13 && key.bits === 1;
}

/**
 * The legacy bytes for an enhanced key report, "" for a combination chat has
 * no use for (Super/Hyper/Meta), or null when `sequence` is not such a report.
 */
export function legacyKey(sequence: string): string | null {
  const report = parse(sequence);
  if (!report) return null;
  const { code, bits } = report;
  // Chat never asks for release events; ignore any a terminal sends.
  if (report.release || bits & (8 | 16 | 32) || code > 0x10ffff) return "";
  const shift = (bits & 1) !== 0;
  const alt = (bits & 2) !== 0;
  const ctrl = (bits & 4) !== 0;
  let key: string;
  if (code === 9 && shift) key = "\u001b[Z";
  else if (code === 127 || code === 8) key = ctrl ? "\b" : "\u007f";
  else if (code === 13 || code === 9 || code === 27) key = String.fromCharCode(code);
  else if (ctrl) key = controlCharacter(code);
  else {
    const text = String.fromCodePoint(code);
    key = shift ? text.toUpperCase() : text;
  }
  return alt ? `\u001b${key}` : key;
}

function controlCharacter(code: number): string {
  const char = String.fromCodePoint(code).toLowerCase();
  if (char >= "a" && char <= "z") return String.fromCharCode(char.charCodeAt(0) - 96);
  const special: Record<string, string> = {
    " ": "\u0000", "@": "\u0000", "2": "\u0000", "[": "\u001b", "3": "\u001b",
    "\\": "\u001c", "4": "\u001c", "]": "\u001d", "5": "\u001d", "^": "\u001e",
    "6": "\u001e", "_": "\u001f", "/": "\u001f", "7": "\u001f", "?": "\u007f", "8": "\u007f"
  };
  return special[char] ?? String.fromCodePoint(code);
}
