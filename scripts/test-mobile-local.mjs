import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const mobile = join(root, "mobile");
const fixtures = join(mobile, "tests", "fixtures");
const scratch = await mkdtemp(join(tmpdir(), "grosshandel-worker-smoke-"));
const workers = [];
const isolatedEnv = {
  ...process.env,
  CI: "1",
  EXPO_NO_TELEMETRY: "1",
  WRANGLER_SEND_METRICS: "false",
  XDG_CONFIG_HOME: join(scratch, "config"),
};

function start(command, args, options = {}) {
  const process = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...isolatedEnv, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  process.stdout.on("data", (bytes) => { log += bytes; });
  process.stderr.on("data", (bytes) => { log += bytes; });
  const done = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", resolve);
  });
  // Background servers may exit before the first probe inspects them.
  void done.catch(() => {});
  return { process, done, log: () => log };
}

async function run(command, args, options) {
  const task = start(command, args, options);
  const exit = await task.done;
  if (exit !== 0) throw new Error(`${command} exited with ${exit}\n${task.log()}`);
  if (options?.showLog) console.log(task.log().trim());
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, server) {
  for (let i = 0; i < 100; i += 1) {
    if (server.process.exitCode !== null) break;
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(750) })).ok) return;
    } catch {
      // A freshly started server may not be listening yet.
    }
    await sleep(300);
  }
  throw new Error(`Local server unavailable at ${url}\n${server.log()}`);
}

try {
  const workerPort = await freePort();
  const webPort = await freePort();
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const config = join(scratch, "wrangler.toml");
  const state = join(scratch, "state");
  const web = join(scratch, "web");
  const wrangler = join(root, "node_modules", ".bin", "wrangler");
  const expo = join(mobile, "node_modules", ".bin", "expo");
  const defaultConfig = (await readFile(join(root, "wrangler.toml"), "utf8")).split("[env.staging]")[0];
  const localConfig = defaultConfig
    .replace('name = "grosshandel"', 'name = "grosshandel-mobile-local-test"')
    .replace('main = "src/index.ts"', `main = ${JSON.stringify(join(fixtures, "worker.ts"))}`)
    .replace('migrations_dir = "migrations"', `migrations_dir = ${JSON.stringify(join(root, "migrations"))}`);
  await writeFile(config, localConfig);
  const local = ["--config", config, "--local", "--persist-to", state];

  await run(wrangler, ["d1", "migrations", "apply", "DB", ...local]);
  await run(wrangler, ["d1", "execute", "DB", ...local, "--file", join(fixtures, "worker.sql")]);
  const worker = start(wrangler, ["dev", ...local, "--ip", "127.0.0.1", "--port", String(workerPort), "--var", `CUSTOMER_APP_ORIGINS:${webUrl}`]);
  workers.push(worker);
  await waitFor(workerUrl + "/health", worker);

  await run(expo, ["export", "--clear", "--platform", "web", "--output-dir", web], {
    cwd: mobile,
    env: { EXPO_PUBLIC_API_URL: workerUrl, EXPO_PUBLIC_TENANT_SLUG: "mobile-test" },
  });
  const preview = start("python3", ["-m", "http.server", String(webPort), "--bind", "127.0.0.1", "--directory", web]);
  workers.push(preview);
  await waitFor(webUrl, preview);
  await run(process.execPath, ["tests/worker-smoke.mjs"], {
    cwd: mobile,
    env: { PILOT_WORKER_URL: workerUrl, PILOT_SMOKE_URL: webUrl },
    showLog: true,
  });
} finally {
  for (const server of workers) server.process.kill();
  await Promise.allSettled(workers.map((server) => server.done));
  await rm(scratch, { recursive: true, force: true });
}
