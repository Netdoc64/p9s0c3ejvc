import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./tests/_setup/apply-migrations.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./tests/_setup/worker.ts",
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityDate: "2025-01-09",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: {
            RETURNS_SUPPLIER_EDGE: { name: Symbol.for("miniflare.kCurrentWorker") as never, entrypoint: "ReturnsSupplierInbox" },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            CUSTOMER_APP_ORIGINS: "https://app.pilot.example",
            STAFF_APP_ORIGINS: "https://admin.pilot.example",
            MODULE_KEK: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            ADMIN_API_KEY: "test-admin-key-0123456789abcdef0123456789abcdef",
          },
        },
      },
    },
  },
});
