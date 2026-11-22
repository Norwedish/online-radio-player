import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@radio/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
  "@radio/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
  "@radio/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
};

/** Audio integration tests (real FFmpeg + Icecast): `pnpm test:integration`. */
export default defineConfig({
  resolve: { alias },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
