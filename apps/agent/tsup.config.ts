import { defineConfig } from "tsup";

// Bundle the shared workspace package in, so the built app runs with plain `node dist/index.js`.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  noExternal: ["@firstlook/shared"],
});
