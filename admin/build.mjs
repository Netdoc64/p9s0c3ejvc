import { copyFile, mkdir, rm } from "node:fs/promises";

const output = new URL("./dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(
  ["index.html", "style.css", "app.mjs", "data.mjs"].map(file =>
    copyFile(new URL(file, import.meta.url), new URL(file, output)),
  ),
);
