import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { envio: fileURLToPath(new URL("./indexer/test/registration.ts", import.meta.url)) } },
  test: { include: ["indexer/test/**/*.test.ts"] },
});
