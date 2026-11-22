import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@radio/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
  "@radio/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
  "@radio/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**", "**/*.spec.ts"],
    environment: "node",
    reporters: ["default"],
    // `pnpm test:coverage` (CI): PLAN M14.1 asks for ≥ 80 % lines on packages/*.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // schema.ts is declarative drizzle DDL; its callbacks only run inside drizzle-kit.
      exclude: ["**/*.test.ts", "packages/db/src/schema.ts"],
      reporter: ["text-summary", "html"],
      thresholds: { lines: 80, statements: 80, functions: 75, branches: 65 },
    },
  },
});
