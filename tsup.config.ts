import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});
