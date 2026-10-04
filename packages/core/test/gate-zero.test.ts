import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Exercise the actual reporting/exit path with controlled campaign counts. The expensive
// simulation is validated separately; it cannot reliably trigger CI's failure branch on demand.
const source = readFileSync(new URL("../scripts/gate-zero.ts", import.meta.url), "utf8");
const wilson = source.slice(source.indexOf("function wilson("), source.indexOf("\nconst started ="));
const reporting = source.slice(source.indexOf("const results: Record"));
function run(crossings: number) {
  const code = ts.transpileModule(wilson + "\n" + reporting, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const process = { argv: [], exitCode: undefined as number | undefined };
  const lines: string[] = [];
  runInNewContext(code, {
    ALPHA: 0.05, alphaRay: 50000000000000000000000000n, started: Date.now(), process,
    runCampaign: () => ({ crossings, trials: 200, delays: [] }),
    RunningProduct: class { boundaryRay = 0n; }, formatRay: () => "boundary",
    console: { log: (line: string) => lines.push(line) },
  });
  return { exit: process.exitCode, text: lines.join("\n") };
}
describe("Gate Zero CI verdict", () => {
  it("passes a known-null sample whose confidence interval stays below alpha", () => {
    const result = run(0);
    expect(result.exit).toBe(0);
    expect(result.text).toContain("PASS");
  });
  it("does not mislabel an overlapping confidence interval as proof of a bound", () => {
    const result = run(10);
    expect(result.exit).toBe(0);
    expect(result.text).toContain("INCONCLUSIVE");
  });
  it("fails the process for a statistically significant false-alarm overrun", () => {
    const result = run(40);
    expect(result.exit).toBe(1);
    expect(result.text).toContain("FAIL");
  });
});
