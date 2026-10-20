// Finding the "## Roles" section of an instructions file. Shared by the
// instruction reader (which must never show the section as raw text) and the
// role definitions. Headings inside fenced code blocks are examples, not
// structure, and CRLF files behave like LF files.

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

interface Line {
  text: string;
  start: number;
  fenced: boolean;
}

function scanLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  let fence: string | null = null;
  for (const text of markdown.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    const inside = fence !== null;
    if (marker && fence === null) fence = marker[0];
    else if (marker && fence !== null && marker[0] === fence) fence = null;
    lines.push({ text, start: offset, fenced: inside || Boolean(marker) });
    offset += text.length + 1;
  }
  return lines;
}

const ROLES_HEADING = /^##[ \t]+Roles[ \t]*$/;
const SECTION_HEADING = /^##[ \t]+\S/;

/** [start, end) of the "## Roles" section (to the next "## " heading), or null. */
export function findRolesSection(markdown: string): { start: number; end: number; bodyStart: number } | null {
  const lines = scanLines(markdown);
  const index = lines.findIndex((line) => !line.fenced && ROLES_HEADING.test(line.text));
  if (index === -1) return null;
  const next = lines.slice(index + 1).find((line) => !line.fenced && SECTION_HEADING.test(line.text));
  return {
    start: lines[index].start,
    bodyStart: lines[index].start + lines[index].text.length + 1,
    end: next ? next.start : markdown.length
  };
}

/** The file without its "## Roles" section. */
export function stripRolesSection(markdown: string): string {
  const text = normalizeNewlines(markdown);
  const section = findRolesSection(text);
  if (!section) return text;
  return `${text.slice(0, section.start)}${text.slice(section.end)}`.replace(/\n{3,}/g, "\n\n");
}

/** "### name" blocks of the section body, ignoring fenced headings. */
export function splitRoleBlocks(body: string): Array<{ heading: string; text: string }> {
  const blocks: Array<{ heading: string; lines: string[] }> = [];
  for (const line of scanLines(body)) {
    const heading = !line.fenced ? /^###[ \t]+(.*)$/.exec(line.text) : null;
    if (heading) blocks.push({ heading: heading[1].trim(), lines: [] });
    else blocks.at(-1)?.lines.push(line.text);
  }
  return blocks.map((block) => ({ heading: block.heading, text: block.lines.join("\n").trim() }));
}
