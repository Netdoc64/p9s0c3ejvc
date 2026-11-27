import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";

const apiUrl = process.env.GROSSHANDEL_API_URL?.trim() ?? "";
const tenant = process.env.GROSSHANDEL_TENANT_SLUG?.trim() ?? "";
if (apiUrl) {
  const origin = new URL(apiUrl);
  if (!["https:", "http:"].includes(origin.protocol) || origin.pathname !== "/" ||
      origin.username || origin.password || origin.search || origin.hash ||
      (origin.protocol === "http:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) || !tenant) {
    throw new Error("Die Dashboard-API benötigt einen HTTPS-Ursprung und einen Tenant.");
  }
}

const output = new URL("./dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(
  ["index.html", "style.css", "app.mjs", "data.mjs", "api.mjs", "login.mjs"].map(file =>
    copyFile(new URL(file, import.meta.url), new URL(file, output)),
  ),
);
await writeFile(new URL("config.mjs", output), `export const config = ${JSON.stringify({ apiUrl, tenant })};\n`);
