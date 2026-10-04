import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The same "@/..." imports as the Next build, so component tests can load
// screens that use them.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
