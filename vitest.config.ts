import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
          GALLERY_ORIGIN: "https://gallery.test",
          SANDBOX_ORIGIN: "https://sandbox.test",
          ADMIN_TOKEN: "test-admin-token-0123456789abcdef0123456789",
          SIGNING_SECRET: "test-signing-secret-0123456789abcdef0123456789",
        },
      },
    })),
  ],
  test: {
    include: ["test/*.test.ts"],
    globalSetup: ["./scripts/embed-static.mjs"],
    setupFiles: ["./test/setup.ts"],
  },
});
