import type { D1Migration } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    KV: KVNamespace;
    ASSETS: R2Bucket;
    OUTBOX_QUEUE: Queue<unknown>;
    STOCK_DO: DurableObjectNamespace;
    WORKER_VERSION: string;
    ENVIRONMENT: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
