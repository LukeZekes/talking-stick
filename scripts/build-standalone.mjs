#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const target = process.argv[2] ?? `bun-${process.platform}-${process.arch}`;
const match = /^bun-(darwin|linux)-(x64|arm64)(-baseline)?$/.exec(target);
if (!match) throw new Error(`Unsupported target: ${target}`);
const [, os, arch] = match;
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const output = path.resolve(process.env.TT_RELEASE_DIR ?? "release-dist");
const name = `talking-stick_${version}_${os}_${arch}`;
fs.mkdirSync(output, { recursive: true });
const stage = fs.mkdtempSync(path.join(output, ".build-"));
try {
  execFileSync("bun", ["build", "--compile", "--external=better-sqlite3", `--target=${target}`, "src/standalone.ts", "--outfile", path.join(stage, "tt")], { stdio: "inherit" });
  fs.copyFileSync("package.json", path.join(stage, "package.json"));
  fs.copyFileSync("LICENSE.md", path.join(stage, "LICENSE.md"));
  fs.cpSync("skills", path.join(stage, "skills"), { recursive: true });
  fs.mkdirSync(path.join(stage, "scripts"));
  fs.copyFileSync("scripts/install.sh", path.join(stage, "scripts/install.sh"));
  const archive = `${name}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(output, archive), "-C", stage, "tt", "package.json", "LICENSE.md", "skills", "scripts"]);
  const digest = createHash("sha256").update(fs.readFileSync(path.join(output, archive))).digest("hex");
  fs.writeFileSync(path.join(output, `${name}.sha256`), `${digest}  ${archive}\n`);
  console.log(path.join(output, archive));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
