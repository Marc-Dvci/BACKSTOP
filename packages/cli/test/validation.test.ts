import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "backstop-cli-test-"));
const config = JSON.parse(readFileSync(join(root, "attestations/reference.json"), "utf8"));
const run = (args: string[]) => spawnSync(process.execPath, [join(root, "packages/cli/dist/index.js"), ...args], { cwd: root, encoding: "utf8", timeout: 20000 });
const audit = ["audit", "--attestation", "attestations/reference.json", "--pool", "pools/v1.json"];
afterAll(() => {
  if (!temporary.startsWith(join(tmpdir(), "backstop-cli-test-"))) throw new Error("unexpected temporary path");
  rmSync(temporary, { recursive: true, force: true });
});

describe("CLI configuration boundaries", () => {
  it("refuses a draw count that changes the committed sampling law", () => {
    const result = run([...audit, "--draws", String(config.n - 1)]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/draws|committed/i);
  });
  it("refuses rounds beyond the attestation lifetime", () => {
    const result = run([...audit, "--rounds", String(config.tMax + 1)]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/rounds|tMax/i);
  });
  it("rejects changed sampling configuration before querying an endpoint", () => {
    const path = join(temporary, "modified-sampling.json");
    writeFileSync(path, JSON.stringify({ ...config, sampling: { ...config.sampling, temperature: 0 } }));
    const result = run(["audit", "--attestation", path, "--pool", "pools/v1.json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/sampling/i);
  });
  it("returns a failed verdict for a record under a foreign seed commitment", () => {
    const path = join(temporary, "foreign-seed.json");
    writeFileSync(path, JSON.stringify({ ...config, seedChainRoot: `0x${"ab".repeat(32)}` }));
    const result = run(["replay", "--record", "docs/results/round-primary-crossing.json", "--attestation", path]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/FAIL|differs|rejected|does not/i);
  });
});
