import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
});
