import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Run against installed peers without adding dependencies to the project.
const [piArg, toolchainArg] = process.argv.slice(2);
if (!piArg || !toolchainArg) {
  throw new Error("Usage: node qa/run.mjs <installed pi-coding-agent directory> <node_modules containing tsx/typescript/@types/node>");
}
const pi = resolve(piArg);
const toolchain = resolve(toolchainArg);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), "multi-goal-qa-run-"));
// Copy README and qa/evidence too: the maintained tests read them (the JSON
// contract in the README; the recorded host-capability probes).
const hostProbe = "qa/host-capabilities.test.ts";
const copyPaths = ["src", "test", "qa/runtime.test.ts", "README.md", "qa/evidence",
  ...(existsSync(join(project, hostProbe)) ? [hostProbe] : []),
  "index.ts", "package.json", "tsconfig.json"];
for (const path of copyPaths) {
  mkdirSync(dirname(join(sandbox, path)), { recursive: true });
  cpSync(join(project, path), join(sandbox, path), { recursive: true });
}
for (const [name, target] of [
  ["@earendil-works/pi-coding-agent", pi],
  ["@earendil-works/pi-ai", join(pi, "node_modules/@earendil-works/pi-ai")],
  ["typebox", join(pi, "node_modules/typebox")],
  ["@types/node", join(toolchain, "@types/node")],
]) {
  const dest = join(sandbox, "node_modules", name);
  mkdirSync(dirname(dest), { recursive: true }); symlinkSync(target, dest);
}
const evidence = join(project, "qa/evidence"); mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, "environment.json"), JSON.stringify({
  node: process.version, pi, piVersion: JSON.parse(readFileSync(join(pi, "package.json"))).version,
  toolchain, sandbox, date: new Date().toISOString(),
}, null, 2) + "\n");
const auditedFiles = ["index.ts", "package.json", "tsconfig.json", "docs/architecture.md",
  ...readdirSync(join(project, "src")).map(name => `src/${name}`)];
writeFileSync(join(evidence, "source-sha256.txt"), auditedFiles.map(path =>
  `${createHash("sha256").update(readFileSync(join(project, path))).digest("hex")}  ${path}`,
).join("\n") + "\n");
let failed = false;
for (const [name, args] of [
  // Refresh the capability evidence first so the baseline run reads the
  // probes recorded against this exact peer.
  ...(existsSync(join(sandbox, hostProbe)) ? [["host-capabilities", [join(toolchain, "tsx/dist/cli.mjs"), "--test", hostProbe]]] : []),
  ["baseline", [join(toolchain, "tsx/dist/cli.mjs"), "--test",
    ...readdirSync(join(sandbox, "test")).filter(name => name.endsWith(".test.ts")).map(name => `test/${name}`)]],
  ["runtime", [join(toolchain, "tsx/dist/cli.mjs"), "--test", "qa/runtime.test.ts"]],
  ["typecheck", [join(toolchain, "typescript/bin/tsc"), "--noEmit", "--pretty", "false"]],
]) {
  const result = spawnSync(process.execPath, args, { cwd: sandbox, encoding: "utf8" });
  const output = (result.stdout ?? "") + (result.stderr ?? "") + (result.error ? String(result.error) : "");
  writeFileSync(join(evidence, `${name}.txt`), output);
  console.log(`${name}: exit ${result.status}; evidence: ${join(evidence, `${name}.txt`)}`);
  failed ||= result.status !== 0;
}
// The probe test writes its evidence inside the sandbox (relative to its own
// path); copy the fresh record back into the project's qa/evidence.
const sandboxProbeEvidence = join(sandbox, "qa/evidence/host-capabilities.txt");
if (existsSync(sandboxProbeEvidence)) {
  cpSync(sandboxProbeEvidence, join(evidence, "host-capabilities.txt"));
}
console.log(`Isolated source/dependency snapshot retained at ${sandbox}`);
process.exitCode = failed ? 1 : 0;
