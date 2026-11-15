import { mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = await mkdtemp("/tmp/opencode/linklet-package-");
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { encoding: "utf8" })) as
  { filename: string; files: { path: string }[] }[];
if (packed[0].files.some(file => file.path.startsWith("test/"))) throw new Error("Test-only RPC harness must not ship.");
for (const path of ["LICENSE", "dist/index.js", "dist/index.d.ts"])
  if (!packed[0].files.some(file => file.path === path)) throw new Error(`Missing release file: ${path}`);
for (const path of ["DOGFOODING.md", "VALIDATION.md"])
  if (packed[0].files.some(file => file.path === path)) throw new Error(`Local report must not ship: ${path}`);
execFileSync("npm", ["install", "--prefix", root, "--ignore-scripts", resolve(root, packed[0].filename)], { stdio: "inherit" });
execFileSync(process.execPath, ["--import", "tsx", "test/host-smoke.ts"], { stdio: "inherit", env: {
  ...process.env, LINKLET_VALIDATION_ENTRY: resolve(root, "node_modules/opencode-linklet/dist/index.js"),
} });
console.log(`Installed-package validation passed. Artifacts: ${root}`);
