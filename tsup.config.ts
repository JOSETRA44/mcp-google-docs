import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // googleapis is enormous and resolves lazily at runtime; bundling it is slow and pointless.
  external: ["googleapis", "@modelcontextprotocol/sdk"],
  banner: { js: "#!/usr/bin/env node" },
});
