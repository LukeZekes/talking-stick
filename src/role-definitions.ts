import fs from "node:fs";
import {
  extractHarnessInstructions,
  resolveInstructionPaths,
  showInstructions,
  type InstructionOptions
} from "./instructions.js";
import { ROLE_PALETTE, normalizeRole } from "./roles.js";
import { findRolesSection, normalizeNewlines, splitRoleBlocks, stripRolesSection } from "./roles-section.js";

// Role definitions live in the instruction files under "## Roles", one
// "### <name>" block per role. Bundled definitions are the role palette; a
// user or project file overrides a definition by name or adds a role. Because
// "## Roles" names no harness, harness extraction never shows it as raw text:
// agents read definitions only through the room's role block.

export type RoleDefinitionSource = "bundled" | "user" | "project";

export interface RoleDefinition {
  name: string;
  text: string;
  source: RoleDefinitionSource;
}

export interface ParsedRoleDefinitions {
  definitions: Array<{ name: string; text: string }>;
  /** Headings that are not valid, unique role names; a save refuses while any exist. */
  problems: string[];
}

/** The "### name" blocks of a "## Roles" section, in file order. */
export function parseRoleDefinitionsDetailed(markdown: string): ParsedRoleDefinitions {
  const text = normalizeNewlines(markdown);
  const section = findRolesSection(text);
  const result: ParsedRoleDefinitions = { definitions: [], problems: [] };
  if (!section) return result;
  for (const block of splitRoleBlocks(text.slice(section.bodyStart, section.end))) {
    const name = normalizeRole(block.heading);
    if (!name) result.problems.push(`"### ${block.heading}" is not a role name (letters, digits, and '-')`);
    else if (result.definitions.some((definition) => definition.name === name)) result.problems.push(`role "${name}" is defined twice`);
    else result.definitions.push({ name, text: block.text });
  }
  return result;
}

export function parseRoleDefinitions(markdown: string): Array<{ name: string; text: string }> {
  return parseRoleDefinitionsDetailed(markdown).definitions;
}

export { stripRolesSection };

/** Replaces (or appends, or with no definitions removes) the "## Roles" section. */
export function replaceRolesSection(markdown: string, definitions: ReadonlyArray<{ name: string; text: string }>): string {
  const text = normalizeNewlines(markdown);
  const rendered = definitions.length === 0 ? "" : [
    "## Roles",
    "",
    ...definitions.flatMap((definition) => [`### ${definition.name}`, definition.text.trim(), ""])
  ].join("\n").trimEnd();
  const section = findRolesSection(text);
  if (section) {
    const before = text.slice(0, section.start).trimEnd();
    const after = text.slice(section.end).trimStart();
    return [before, rendered, after].filter(Boolean).join("\n\n") + "\n";
  }
  return rendered ? `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${rendered}\n` : text;
}

/**
 * Sets one role's definition in a file's text, or with `body` null removes
 * that file's override so a lower layer's definition (or none) applies.
 * Refuses while the section has headings it cannot read, rather than
 * silently dropping them on save.
 */
export function updateRoleDefinitionMarkdown(markdown: string, name: string, body: string | null): string {
  const role = normalizeRole(name);
  if (!role) throw new Error(`Invalid role ${JSON.stringify(name)}: use letters, digits, and '-'.`);
  const parsed = parseRoleDefinitionsDetailed(markdown);
  if (parsed.problems.length) throw new Error(`Fix the "## Roles" section first: ${parsed.problems.join("; ")}.`);
  const definitions = [...parsed.definitions];
  const index = definitions.findIndex((definition) => definition.name === role);
  if (body === null) {
    if (index !== -1) definitions.splice(index, 1);
  } else if (index === -1) definitions.push({ name: role, text: body.trim() });
  else definitions[index] = { name: role, text: body.trim() };
  return replaceRolesSection(markdown, definitions);
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Bundled < user < project, keyed by name, keeping the first position a
 * name appeared in. `projectText` previews unsaved project-file text.
 */
export function loadRoleDefinitions(
  options: InstructionOptions = {},
  staged: { projectText?: string } = {}
): RoleDefinition[] {
  const merged = new Map<string, RoleDefinition>();
  for (const [name, text] of Object.entries(ROLE_PALETTE)) merged.set(name, { name, text, source: "bundled" });
  const paths = resolveInstructionPaths(options);
  const layers: Array<[RoleDefinitionSource, string]> = [
    ["user", readFile(paths.user)],
    ["project", staged.projectText ?? readFile(paths.project)]
  ];
  for (const [source, text] of layers) {
    for (const definition of parseRoleDefinitions(text)) merged.set(definition.name, { ...definition, source });
  }
  return [...merged.values()];
}

export function definitionMap(definitions: ReadonlyArray<RoleDefinition>): Map<string, string> {
  return new Map(definitions.map((definition) => [definition.name, definition.text]));
}

/**
 * The shared instructions a harness reads (bundled + user + project, with
 * every "## Roles" section left out), optionally with unsaved project text.
 */
export function effectiveSharedInstructions(
  harness: string,
  options: InstructionOptions = {},
  staged: { projectText?: string } = {}
): string {
  // showInstructions already strips "## Roles" from every layer; staged
  // project text is stripped the same way before harness extraction.
  if (staged.projectText === undefined) return showInstructions({ harness, options }).text;
  const resolved = showInstructions({ harness, scope: "bundled", options }).harness;
  const parts = (["bundled", "user"] as const).map((scope) => showInstructions({ harness, scope, options }).text);
  parts.push(extractHarnessInstructions(stripRolesSection(staged.projectText), resolved));
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}
