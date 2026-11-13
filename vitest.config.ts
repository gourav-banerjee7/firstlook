import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    css: false,
  },
});
