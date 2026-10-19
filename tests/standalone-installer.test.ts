import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-test-"));
  roots.push(root);
  const assets = path.join(root, "assets");
  const stage = path.join(root, "stage");
  fs.mkdirSync(assets);
  fs.mkdirSync(path.join(stage, "skills/talking-stick"), { recursive: true });
  // Like a release before 0.23.1, the fixture has no post-install step.
  fs.writeFileSync(path.join(stage, "tt"), "#!/bin/sh\n[ \"$1\" = post-install ] && exit 1\necho standalone-fixture\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stage, "package.json"), '{"version":"0.23.0"}');
  fs.writeFileSync(path.join(stage, "skills/talking-stick/SKILL.md"), "fixture");
  const name = `talking-stick_0.23.0_${process.platform}_${process.arch}.tar.gz`;
  const archive = path.join(assets, name);
  execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  fs.writeFileSync(path.join(assets, "checksums.txt"), `${digest}  ${name}\n`);
  const bin = path.join(root, "bin with spaces");
  const install = path.join(root, "data with spaces");
  const run = () => spawnSync("sh", ["scripts/install.sh", "--base-url", assets, "--bin-dir", bin, "--install-dir", install], { encoding: "utf8" });
  return { root, assets, archive, bin, install, run };
}
describe.skipIf(process.platform === "win32")("standalone installer", () => {
  it("installs a verified archive with adjacent skills and can be rerun", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const binary = fs.realpathSync(path.join(f.bin, "tt"));
    expect(binary.startsWith(fs.realpathSync(f.install))).toBe(true);
    expect(fs.readFileSync(path.join(path.dirname(binary), "skills/talking-stick/SKILL.md"), "utf8")).toBe("fixture");
    expect(execFileSync(binary, ["--help"], { encoding: "utf8" }).trim()).toBe("standalone-fixture");
    expect(fs.realpathSync(path.join(f.install, "current", "tt"))).toBe(binary);
    // tt self-update reruns the installer with this bin directory.
    expect(fs.readFileSync(path.join(f.install, "install-receipt"), "utf8"))
      .toBe(`bin_dir=${fs.realpathSync(f.bin)}\n`);
    expect(f.run().status).toBe(0);
    expect(fs.realpathSync(path.join(f.bin, "tt"))).toBe(binary);
  });
  it("rejects a changed archive without replacing an existing installation", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const before = fs.readlinkSync(path.join(f.bin, "tt"));
    fs.appendFileSync(f.archive, "corruption");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(fs.readlinkSync(path.join(f.bin, "tt"))).toBe(before);
  });
});
