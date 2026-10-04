/**
 * Package the CLI for npm as `backstop-audit`.
 *
 * Inside the monorepo the CLI depends on the workspace packages. Published, it has to stand
 * alone, so the workspace code is bundled into one file and only the third-party runtime
 * dependencies stay external. The package is written to dist-npm/backstop-audit and checked by
 * running the packed tarball's `backstop` binary before anything is published.
 *
 * Usage
 *   node scripts/pack-cli.mjs            build and pack
 *   cd dist-npm/backstop-audit && npm publish --access public
 */

import { build } from "tsup";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-npm", "backstop-audit");
const cliPkg = JSON.parse(readFileSync(join(ROOT, "packages", "cli", "package.json"), "utf8"));
const corePkg = JSON.parse(readFileSync(join(ROOT, "packages", "core", "package.json"), "utf8"));
const sdkPkg = JSON.parse(readFileSync(join(ROOT, "packages", "sdk", "package.json"), "utf8"));

if (resolve(OUT) !== resolve(ROOT, "dist-npm", "backstop-audit")) throw new Error("unexpected package output directory");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Third-party runtime dependencies of everything the bundle inlines.
const external = {};
for (const [workspace, pkg] of [["core", corePkg], ["sdk", sdkPkg]]) {
  for (const name of Object.keys(pkg.dependencies)) {
    if (name.startsWith("@backstop/")) continue;
    // Use the tested installed versions rather than resolving a newer runtime at publication.
    const installed = JSON.parse(readFileSync(join(ROOT, "packages", workspace, "node_modules", name, "package.json"), "utf8"));
    external[name] = installed.version;
  }
}

await build({
  entry: { backstop: join(ROOT, "packages", "cli", "src", "index.ts") },
  outDir: join(OUT, "bin"),
  format: ["esm"],
  platform: "node",
  target: "node20",
  noExternal: [/^@backstop\//],
  external: Object.keys(external),
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  silent: true,
});

writeFileSync(
  join(OUT, "package.json"),
  JSON.stringify(
    {
      name: "backstop-audit",
      version: cliPkg.version,
      description:
        "Audit a hosted LLM endpoint against the behavioural envelope its attestation committed to, and recompute any published BACKSTOP verdict.",
      type: "module",
      bin: { backstop: "./bin/backstop.mjs" },
      files: ["bin", "attestations", "README.md", "LICENSE"],
      engines: { node: ">=20" },
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/Marc-Dvci/BACKSTOP.git", directory: "packages/cli" },
      homepage: "https://backstop-smoky.vercel.app",
      keywords: ["llm", "inference", "audit", "e-value", "monad", "erc-8004", "model-substitution"],
      dependencies: external,
    },
    null,
    2,
  ) + "\n",
);

// Ship the reference configuration; auditing still requires its matching pool and endpoint.
mkdirSync(join(OUT, "attestations"), { recursive: true });
cpSync(join(ROOT, "attestations", "reference.json"), join(OUT, "attestations", "reference.json"));
cpSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));
writeFileSync(
  join(OUT, "README.md"),
  `# backstop-audit

The BACKSTOP command line: audit an OpenAI-compatible endpoint against a committed attestation,
and recompute a published verdict from its record and matching attestation.

Install the local tarball with npm. The package does not supply a hosted endpoint or a private
reference pool. Download the public live record and matching attestation to try replay; see the
repository quickstart. The source artifact does not imply that an npm version is published.

\`\`\`bash
backstop replay --record round.json --attestation live-switched.json
backstop audit --attestation reference.json --pool v1.json --base-url http://127.0.0.1:8080/v1
\`\`\`

Audit exits: 0 no crossing, 1 crossing, 2 incomplete. Replay exits: 0 verified, 1 failed checks.

Method, live index and the published rounds: https://backstop-smoky.vercel.app
Source: https://github.com/Marc-Dvci/BACKSTOP
`,
);

const onWindows = process.platform === "win32";
const tarball = execFileSync(onWindows ? "npm.cmd" : "npm", ["pack", "--silent"], { cwd: OUT, shell: onWindows })
  .toString()
  .trim();
console.log(`packed ${join(OUT, tarball)}`);

// Install outside the monorepo: a working workspace binary does not prove the package ships
// everything it needs. Keep npm arguments free of shell metacharacters on Windows.
const smokePrefix = join(tmpdir(), "backstop-cli-");
const smokeDir = mkdtempSync(smokePrefix);
try {
  cpSync(join(OUT, tarball), join(smokeDir, "backstop-audit.tgz"));
  writeFileSync(join(smokeDir, "package.json"), JSON.stringify({ name: "backstop-package-check", private: true }));
  execFileSync(onWindows ? "npm.cmd" : "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "./backstop-audit.tgz"],
    { cwd: smokeDir, shell: onWindows, stdio: "inherit" });
  const recordPath = join(ROOT, "docs/results/live/v6-round-5.json");
  if (existsSync(recordPath)) {
    cpSync(recordPath, join(smokeDir, "round.json"));
  } else {
    const response = await fetch("https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data/v6/round-5.json",
      { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`public replay fixture answered ${response.status}`);
    writeFileSync(join(smokeDir, "round.json"), await response.text());
  }
  cpSync(join(ROOT, "attestations/live-switched.json"), join(smokeDir, "attestation.json"));
  const binary = join(smokeDir, "node_modules", "backstop-audit", "bin", "backstop.mjs");
  execFileSync(process.execPath, [binary, "replay", "--record", "round.json", "--attestation", "attestation.json"],
    { cwd: smokeDir, stdio: "inherit" });
  execFileSync(process.execPath, [binary, "quote", "--notional", "1000", "--term-days", "7"],
    { cwd: smokeDir, stdio: "inherit" });
  console.log("standalone install, published-round replay and quote passed");
} finally {
  if (resolve(smokeDir).startsWith(resolve(smokePrefix))) rmSync(smokeDir, { recursive: true, force: true });
}
