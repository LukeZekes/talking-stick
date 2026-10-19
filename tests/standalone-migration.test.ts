import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestDirectory, recordManagedContent } from "../src/managed-content.js";
import { advanceCurrentLink, ensureCurrentLink, findRemovableNpmCopy, repointManagedSkillLinks, skillLinksInto } from "../src/standalone-migration.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function layout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-migrate-")));
  roots.push(root);
  const install = path.join(root, "install");
  const release = (name: string, text: string) => {
    const dir = path.join(install, "releases", name);
    fs.mkdirSync(path.join(dir, "skills", "talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "skills", "talking-stick", "SKILL.md"), text);
    return dir;
  };
  const home = path.join(root, "home");
  const env = { ...process.env, HOME: home, TALKING_STICK_DATA_DIR: path.join(root, "data") };
  return { root, install, release, home, env };
}

describe("standalone migration", () => {
  it("creates current only when it is missing", () => {
    const f = layout();
    const release = f.release("0.23.1-abc", "new");
    expect(ensureCurrentLink({ releaseRoot: release })).toBe(true);
    expect(fs.readlinkSync(path.join(f.install, "current"))).toBe(path.join("releases", "0.23.1-abc"));
    expect(ensureCurrentLink({ releaseRoot: release })).toBe(false);
  });

  it("re-points only proven managed links and reports the rest", () => {
    const f = layout();
    const oldRelease = f.release("0.23.0-old", "old");
    const release = f.release("0.23.1-abc", "new");
    ensureCurrentLink({ releaseRoot: release });
    const skill = (dir: string, text: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), text);
      return dir;
    };
    // Simulates `tt install`: link the skill and record what it linked.
    const link = (target: string, source: string) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(source, target);
      recordManagedContent(target, "skill-copy", digestDirectory(source), { env: f.env });
    };
    const npmSkill = skill(path.join(f.root, "lib", "node_modules", "talking-stick", "skills", "talking-stick"), "npm");
    const checkout = skill(path.join(f.root, "checkout", "skills", "talking-stick"), "dev");
    const claude = path.join(f.home, ".claude", "skills", "talking-stick");
    const shared = path.join(f.home, ".agents", "skills", "talking-stick");
    const grok = path.join(f.home, ".grok", "skills", "talking-stick");
    link(claude, npmSkill);
    link(shared, path.join(oldRelease, "skills", "talking-stick"));
    link(grok, checkout);

    const result = repointManagedSkillLinks({ releaseRoot: release, env: f.env, homeDir: f.home });
    const current = path.join(f.install, "current", "skills", "talking-stick");
    expect(result.repointed.map((entry) => entry.path).sort()).toEqual([shared, claude].sort());
    expect(result.unproven).toEqual([]);
    expect(fs.readlinkSync(claude)).toBe(current);
    expect(fs.readFileSync(path.join(shared, "SKILL.md"), "utf8")).toBe("new");
    // A development checkout link is someone's choice; leave it.
    expect(fs.readlinkSync(grok)).toBe(checkout);
    expect(repointManagedSkillLinks({ releaseRoot: release, env: f.env, homeDir: f.home }).repointed).toEqual([]);
  });

  it("keeps a customized npm skill and an npm-linked checkout", () => {
    const f = layout();
    const release = f.release("0.23.1-abc", "new");
    ensureCurrentLink({ releaseRoot: release });
    const npmSkill = path.join(f.root, "lib", "node_modules", "talking-stick", "skills", "talking-stick");
    fs.mkdirSync(npmSkill, { recursive: true });
    fs.writeFileSync(path.join(npmSkill, "SKILL.md"), "npm");
    const claude = path.join(f.home, ".claude", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.symlinkSync(npmSkill, claude);
    recordManagedContent(claude, "skill-copy", digestDirectory(npmSkill), { env: f.env });
    fs.appendFileSync(path.join(npmSkill, "SKILL.md"), "\nmy local rule");

    const linkedPackage = path.join(f.root, "linked", "node_modules", "talking-stick");
    const checkout = path.join(f.root, "checkout");
    fs.mkdirSync(path.join(checkout, "skills", "talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "skills", "talking-stick", "SKILL.md"), "dev");
    fs.mkdirSync(path.dirname(linkedPackage), { recursive: true });
    fs.symlinkSync(checkout, linkedPackage);
    const shared = path.join(f.home, ".agents", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(path.join(linkedPackage, "skills", "talking-stick"), shared);
    recordManagedContent(shared, "skill-copy", digestDirectory(path.join(checkout, "skills", "talking-stick")), { env: f.env });

    const result = repointManagedSkillLinks({ releaseRoot: release, env: f.env, homeDir: f.home });
    expect(result.repointed).toEqual([]);
    expect(result.unproven.map((entry) => entry.path).sort()).toEqual([shared, claude].sort());
    expect(fs.readlinkSync(claude)).toBe(npmSkill);
  });

  it("pins an edited skill linked through current before advancing it", () => {
    const f = layout();
    const oldRelease = f.release("0.23.1-old", "old");
    const release = f.release("0.23.2-new", "new");
    ensureCurrentLink({ releaseRoot: oldRelease });
    const through = path.join(f.install, "current", "skills", "talking-stick");
    const claude = path.join(f.home, ".claude", "skills", "talking-stick");
    const shared = path.join(f.home, ".agents", "skills", "talking-stick");
    for (const target of [claude, shared]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(through, target);
      recordManagedContent(target, "skill-copy", digestDirectory(through), { env: f.env });
    }
    // Someone edited the release's skill that claude reads; record shared as edited.
    fs.appendFileSync(path.join(oldRelease, "skills", "talking-stick", "SKILL.md"), " + local edit");
    recordManagedContent(shared, "skill-copy", digestDirectory(through), { env: f.env });

    const pinned = advanceCurrentLink({ releaseRoot: release, env: f.env, homeDir: f.home });
    expect(pinned.map((link) => link.path)).toEqual([claude]);
    expect(fs.readFileSync(path.join(claude, "SKILL.md"), "utf8")).toBe("old + local edit");
    expect(fs.readFileSync(path.join(shared, "SKILL.md"), "utf8")).toBe("new");
  });

  it("pins an edited skill that reaches current through an alias", () => {
    const f = layout();
    const oldRelease = f.release("0.23.1-old", "old");
    const release = f.release("0.23.2-new", "new");
    ensureCurrentLink({ releaseRoot: oldRelease });
    const alias = path.join(f.root, "alias");
    fs.symlinkSync(path.join(f.install, "current", "skills", "talking-stick"), alias);
    const claude = path.join(f.home, ".claude", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.symlinkSync(alias, claude);
    recordManagedContent(claude, "skill-copy", digestDirectory(alias), { env: f.env });
    fs.appendFileSync(path.join(oldRelease, "skills", "talking-stick", "SKILL.md"), " + edit");
    expect(advanceCurrentLink({ releaseRoot: release, env: f.env, homeDir: f.home }).map((link) => link.path)).toEqual([claude]);
    expect(fs.readFileSync(path.join(claude, "SKILL.md"), "utf8")).toBe("old + edit");
  });

  it("finds skill links that reach a package through an alias", () => {
    const f = layout();
    const npmSkill = path.join(f.root, "lib", "node_modules", "talking-stick", "skills", "talking-stick");
    fs.mkdirSync(npmSkill, { recursive: true });
    const alias = path.join(f.root, "shared-alias");
    fs.symlinkSync(npmSkill, alias);
    const claude = path.join(f.home, ".claude", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.symlinkSync(alias, claude);
    expect(skillLinksInto(path.join(f.root, "lib", "node_modules", "talking-stick"), { env: f.env, homeDir: f.home }))
      .toEqual([claude]);
  });

  it("reports an npm copy only when npm root -g owns it and it is not npm-linked", () => {
    const f = layout();
    const npmRoot = path.join(f.root, "npm-global", "lib", "node_modules");
    const cli = path.join(npmRoot, "talking-stick", "dist", "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "");
    const npmBin = path.join(f.root, "npm-global", "bin");
    fs.mkdirSync(npmBin, { recursive: true });
    fs.symlinkSync(cli, path.join(npmBin, "tt"));
    fs.writeFileSync(path.join(npmBin, "npm"), `#!/bin/sh\necho '${npmRoot}'\n`, { mode: 0o755 });
    const binDir = path.join(f.root, "bin");
    fs.mkdirSync(binDir);
    const env = { ...f.env, PATH: `${npmBin}${path.delimiter}${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin` };
    expect(findRemovableNpmCopy(binDir, { env })).toEqual({ path: path.join(npmBin, "tt"), package_dir: path.join(npmRoot, "talking-stick") });

    // `npm link` of a checkout: the global package is a symlink.
    const checkout = path.join(f.root, "checkout");
    fs.renameSync(path.join(npmRoot, "talking-stick"), checkout);
    fs.symlinkSync(checkout, path.join(npmRoot, "talking-stick"));
    expect(findRemovableNpmCopy(binDir, { env })).toBeNull();
  });
});

describe("release layout", () => {
  it("only an installer-placed release counts as installed", async () => {
    const { isInstalledRelease } = await import("../src/standalone-mode.js");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-layout-")));
    roots.push(root);
    const installed = path.join(root, "install", "releases", "0.23.1-abc");
    const extracted = path.join(root, "Downloads", "talking-stick_0.23.1_darwin_arm64");
    for (const dir of [installed, extracted]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
    }
    expect(isInstalledRelease(installed)).toBe(true);
    expect(isInstalledRelease(extracted)).toBe(false);
  });
});
