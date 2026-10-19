import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { showInstructions } from "../src/instructions.js";
import {
  loadRoleDefinitions,
  parseRoleDefinitionsDetailed,
  replaceRolesSection,
  stripRolesSection,
  updateRoleDefinitionMarkdown
} from "../src/role-definitions.js";
import { renderRoleBlock } from "../src/roles.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-roledefs-"))); roots.push(dir); return dir; };

const FILE = [
  "# Local", "", "Shared rule.", "", "```md", "## Roles", "### not-a-role-in-a-fence", "```", "",
  "## Roles", "", "### architect", "Owns the plan.", "- second line", "", "### scribe", "Writes notes.", "",
  "## Codex", "Codex-only text."
].join("\r\n");

describe("role definitions in instructions", () => {
  it("parses the real section, ignoring fenced examples and CRLF", () => {
    const parsed = parseRoleDefinitionsDetailed(FILE);
    expect(parsed.problems).toEqual([]);
    expect(parsed.definitions).toEqual([
      { name: "architect", text: "Owns the plan.\n- second line" },
      { name: "scribe", text: "Writes notes." }
    ]);
    const stripped = stripRolesSection(FILE);
    expect(stripped).toContain("### not-a-role-in-a-fence");
    expect(stripped).toContain("## Codex");
    expect(stripped).not.toContain("Owns the plan.");
  });

  it("updates one role, keeps the rest of the file, and refuses a malformed section", () => {
    const updated = updateRoleDefinitionMarkdown(FILE, "scribe", "Keeps the CHANGELOG.");
    expect(parseRoleDefinitionsDetailed(updated).definitions.at(-1)).toEqual({ name: "scribe", text: "Keeps the CHANGELOG." });
    expect(updated).toContain("### not-a-role-in-a-fence");
    expect(updated).toContain("Codex-only text.");
    const removed = updateRoleDefinitionMarkdown(updated, "architect", null);
    expect(parseRoleDefinitionsDetailed(removed).definitions.map((d) => d.name)).toEqual(["scribe"]);
    const cleared = replaceRolesSection(removed, []);
    expect(parseRoleDefinitionsDetailed(cleared).definitions).toEqual([]);
    expect(cleared).toContain("### not-a-role-in-a-fence");
    const broken = "## Roles\n\n### Bad Name!\nx\n\n### scribe\na\n\n### scribe\nb\n";
    expect(parseRoleDefinitionsDetailed(broken).problems).toHaveLength(2);
    expect(() => updateRoleDefinitionMarkdown(broken, "tester", "t")).toThrow(/Fix the "## Roles" section/);
  });

  it("layers bundled < user < project, and previews staged project text", () => {
    const data = temp();
    const project = temp();
    fs.writeFileSync(path.join(data, "instructions.md"), "## Roles\n\n### tester\nUser tester.\n\n### ops\nUser ops.\n");
    fs.mkdirSync(path.join(project, ".talking-stick"));
    fs.writeFileSync(path.join(project, ".talking-stick", "instructions.md"), "## Roles\n\n### tester\nProject tester.\n");
    const options = { env: { TALKING_STICK_DATA_DIR: data }, contextPath: project };
    const loaded = loadRoleDefinitions(options);
    expect(loaded.find((d) => d.name === "architect")?.source).toBe("bundled");
    expect(loaded.find((d) => d.name === "tester")).toEqual({ name: "tester", text: "Project tester.", source: "project" });
    expect(loaded.find((d) => d.name === "ops")?.source).toBe("user");
    // A bundled role keeps its place in the order when overridden.
    expect(loaded.map((d) => d.name).indexOf("tester")).toBe(3);
    const staged = loadRoleDefinitions(options, { projectText: "" });
    expect(staged.find((d) => d.name === "tester")?.text).toBe("User tester.");
  });

  it("never shows a Roles section as raw instruction text", () => {
    const data = temp();
    const project = temp();
    fs.mkdirSync(path.join(project, ".talking-stick"));
    fs.writeFileSync(path.join(project, ".talking-stick", "instructions.md"), "## Roles\n\n### architect\nSECRET DEFINITION\n\nShared after.\n");
    const text = showInstructions({ harness: "codex", options: { env: { TALKING_STICK_DATA_DIR: data }, contextPath: project } }).text;
    expect(text).not.toContain("SECRET DEFINITION");
    expect(text).not.toContain("## Roles");
  });

  it("gives an agent its own roles in full and peers a one-line summary", () => {
    const definitions = new Map([["architect", "Owns the plan.\n- Explains tradeoffs."], ["implementer", "Writes code."]]);
    const block = renderRoleBlock({ self: "claude:a", agents: ["claude:a", "codex:b"], assignments: [], userDefaults: {}, version: 3, definitions });
    expect(block).toContain("- You (claude:a): architect (Owns the plan.)");
    expect(block).toContain("- codex:b: implementer (Writes code.)");
    expect(block).toContain("### architect\nOwns the plan.\n- Explains tradeoffs.");
    expect(block).not.toContain("### implementer");
  });
});
