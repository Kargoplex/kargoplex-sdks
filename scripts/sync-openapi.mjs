#!/usr/bin/env node
// Copies the OpenAPI document from the server repo (or a path you pass) into this repo.
// Usage: node scripts/sync-openapi.mjs [path/to/openapi.json]
import { copyFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(process.argv[2] ?? resolve(root, "../kargoplex-server/docs/public-api/openapi.json"));
const dest = resolve(root, "openapi.json");

if (!existsSync(src)) {
  console.error(`Source not found: ${src}`);
  process.exit(1);
}
const doc = JSON.parse(readFileSync(src, "utf8"));
if (!doc.openapi || !doc.paths) {
  console.error("Source does not look like an OpenAPI document.");
  process.exit(1);
}
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest} (API version ${doc.info?.version ?? "unknown"}).`);
console.log("Next: node scripts/generate.mjs");
