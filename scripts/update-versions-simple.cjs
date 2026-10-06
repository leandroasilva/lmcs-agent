#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const version = process.argv[2];
if (!version) {
  console.error("Usage: node update-versions-simple.js <version>");
  process.exit(1);
}

const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/core/package.json",
];

for (const relativePath of releasePackageFiles) {
  const filePath = path.join(process.cwd(), relativePath);
  const packageJson = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  packageJson.version = version;
  fs.writeFileSync(filePath, JSON.stringify(packageJson, null, 2) + "\n");
  console.log(`Updated ${relativePath} to version ${version}`);
}
