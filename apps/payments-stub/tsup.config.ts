import { defineConfig } from "tsup";

// Bundle everything (workspace packages and npm deps) into one file, so the container image
// needs only Node and dist/index.js.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  noExternal: [/.*/],
  external: ["pg-native"],
  // Some CommonJS dependencies call require() for Node built-ins; give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
