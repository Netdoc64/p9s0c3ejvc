#!/usr/bin/env node
/**
 * Smoke ohne Staging: frische lokale D1 (Migrationen + seed:pilot), lokaler
 * Worker (wrangler dev --local), dann scripts/smoke.ts dagegen.
 *
 *   pnpm smoke:local
 *
 * - Eigenes --persist-to in einem Temp-Verzeichnis: der Entwicklungs-Zustand
 *   unter .wrangler bleibt unberuehrt.
 * - API-Key und HMAC-Secret kommen aus der Ausgabe von seed-pilot und gehen nur
 *   als Umgebungsvariablen an den Kindprozess; nichts wird in Dateien geschrieben.
 * - Keine Cloudflare-Zugriffe: alles laeuft mit --local.
 * - Plattformneutral: Kindprozesse laufen ueber `node <entry>`, ohne Shell.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const HEALTH_TIMEOUT_MS = Number(process.env.SMOKE_LOCAL_HEALTH_TIMEOUT_MS ?? 120_000);

const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

// seed-pilot ruft `wrangler` ueber die Shell auf: node_modules/.bin in den PATH.
const childEnv = {
  ...process.env,
  PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  NO_COLOR: "1",
};
// Nie versehentlich gegen die Cloud arbeiten.
delete childEnv.CLOUDFLARE_API_TOKEN;
delete childEnv.CLOUDFLARE_ACCOUNT_ID;

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

function runSync(label, args, env = childEnv) {
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf-8" });
  if (r.status !== 0) {
    process.stderr.write(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    throw new Error(`${label} fehlgeschlagen (Exit ${r.status})`);
  }
  return r.stdout ?? "";
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function waitForHealth(url, child, getLog) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev beendet (Exit ${child.exitCode})\n${getLog()}`);
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) return;
    } catch {
      /* noch nicht bereit */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`/health nach ${HEALTH_TIMEOUT_MS} ms nicht erreichbar\n${getLog()}`);
}

async function main() {
  const persist = mkdtempSync(join(tmpdir(), "smoke-local-"));
  let worker;
  let log = "";
  const cleanup = () => {
    killTree(worker);
    try {
      rmSync(persist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows haelt Dateien kurz nach dem Beenden */
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  try {
    console.log("› Migrationen (lokale D1, frisch)");
    runSync("Migrationen", [wranglerBin, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist]);

    console.log("› seed:pilot (lokal)");
    const seedOut = runSync("seed:pilot", [tsxCli, "scripts/seed-pilot.ts", "--persist-to", persist]);
    const apiKey = /api_key:\s+(\S+)/.exec(seedOut)?.[1];
    const hmacSecret = /hmac_secret:\s+(\S+)/.exec(seedOut)?.[1];
    if (!apiKey || !hmacSecret) throw new Error("seed:pilot lieferte keinen API-Key/HMAC-Secret");

    const port = await freePort();
    const inspectorPort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    console.log(`› wrangler dev --local auf ${base}`);
    worker = spawn(
      process.execPath,
      [wranglerBin, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", persist],
      { cwd: root, env: childEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
    );
    const collect = (d) => {
      log = (log + d).slice(-8000);
    };
    worker.stdout.on("data", collect);
    worker.stderr.on("data", collect);
    await waitForHealth(base, worker, () => log);

    console.log("› scripts/smoke.ts");
    const smoke = spawn(process.execPath, [tsxCli, "scripts/smoke.ts"], {
      cwd: root,
      env: { ...childEnv, GROSSHANDEL_BASE_URL: base, GROSSHANDEL_API_KEY: apiKey, GROSSHANDEL_HMAC_SECRET: hmacSecret },
      stdio: "inherit",
    });
    return await new Promise((ok) => smoke.on("exit", (code) => ok(code ?? 1)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  } finally {
    cleanup();
  }
}

process.exit(await main());
