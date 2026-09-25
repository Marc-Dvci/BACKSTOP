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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-npm", "backstop-audit");
const cliPkg = JSON.parse(readFileSync(join(ROOT, "packages", "cli", "package.json"), "utf8"));
const corePkg = JSON.parse(readFileSync(join(ROOT, "packages", "core", "package.json"), "utf8"));
const sdkPkg = JSON.parse(readFileSync(join(ROOT, "packages", "sdk", "package.json"), "utf8"));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Third-party runtime dependencies of everything the bundle inlines.
const external = { ...corePkg.dependencies, ...sdkPkg.dependencies };
for (const k of Object.keys(external)) if (k.startsWith("@backstop/")) delete external[k];

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

// The committed reference attestation ships with the package, so the first command works with
// nothing else downloaded.
mkdirSync(join(OUT, "attestations"), { recursive: true });
cpSync(join(ROOT, "attestations", "reference.json"), join(OUT, "attestations", "reference.json"));
cpSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));
writeFileSync(
  join(OUT, "README.md"),
  `# backstop-audit

The BACKSTOP command line: audit an OpenAI-compatible endpoint against a committed attestation,
and recompute any verdict BACKSTOP published on Monad from its record alone.

\`\`\`bash
npx backstop-audit replay --record round.json --attestation live-switched.json
npx backstop-audit audit  --attestation reference.json --pool v1.json --base-url http://127.0.0.1:8080/v1
\`\`\`

Exit codes: 0 consistent with the envelope, 1 boundary crossed, 2 run incomplete.

Method, live index and the published rounds: https://backstop-smoky.vercel.app
Source: https://github.com/Marc-Dvci/BACKSTOP
`,
);

const onWindows = process.platform === "win32";
const tarball = execFileSync(onWindows ? "npm.cmd" : "npm", ["pack", "--silent"], { cwd: OUT, shell: onWindows })
  .toString()
  .trim();
console.log(`packed ${join(OUT, tarball)}`);
