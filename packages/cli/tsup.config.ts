import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // The CLI is installed globally, so the shebang has to survive the bundle.
  banner: { js: "#!/usr/bin/env node" },
});
