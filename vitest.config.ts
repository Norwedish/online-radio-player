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
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
    environment: "node",
    reporters: ["default"],
  },
});
