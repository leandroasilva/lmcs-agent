// @effect-diagnostics nodeBuiltinImport:off
//
// electron-builder is invoked once per architecture (arm64 and x64) so each
// run emits its own `latest-mac.yml` describing only the artifacts it just
// produced. Shipping both feeds verbatim would leave electron-updater with a
// manifest for a single CPU, so the desktop CI merges the two into one feed
// whose `files` entries carry an explicit `arch`. electron-updater 6.x then
// picks the ZIP that matches the host `process.arch`.
//
// Usage: node scripts/merge-latest-mac-yml.ts <arm64-feed> <x64-feed> <output>
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { parse, stringify } from "yaml";

interface MacUpdateFile {
  readonly url: string;
  readonly sha512: string;
  readonly size?: number;
  readonly blockMapSize?: number;
  arch?: string;
}

interface MacUpdateFeed {
  readonly version: string;
  files: Array<MacUpdateFile>;
  readonly path?: string;
  readonly sha512?: string;
  readonly releaseDate?: string;
}

function readFeed(filePath: string, arch: "arm64" | "x64"): MacUpdateFeed {
  const raw = NodeFS.readFileSync(filePath, "utf8");
  const parsed = parse(raw) as MacUpdateFeed | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.version !== "string" ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error(`Invalid latest-mac.yml at ${filePath}: expected version and files[]`);
  }

  // Tag every artifact with its CPU so the merged feed is unambiguous for
  // electron-updater's per-arch selection.
  for (const file of parsed.files) {
    file.arch = arch;
  }
  return parsed;
}

function main(): void {
  const [arm64Path, x64Path, outputPath] = NodeProcess.argv.slice(2);
  if (arm64Path === undefined || x64Path === undefined || outputPath === undefined) {
    NodeProcess.stderr.write(
      "Usage: node scripts/merge-latest-mac-yml.ts <arm64-feed> <x64-feed> <output>\n",
    );
    NodeProcess.exit(1);
  }

  const arm64Feed = readFeed(arm64Path, "arm64");
  const x64Feed = readFeed(x64Path, "x64");

  if (arm64Feed.version !== x64Feed.version) {
    throw new Error(
      `Version mismatch between macOS feeds: arm64=${arm64Feed.version} x64=${x64Feed.version}`,
    );
  }

  const mergedFiles: Array<MacUpdateFile> = [...arm64Feed.files, ...x64Feed.files];
  const merged: Record<string, unknown> = {
    version: arm64Feed.version,
    files: mergedFiles,
  };
  // Preserve the top-level fallback fields from the arm64 feed. electron-updater
  // only reads `path`/`sha512` when no `files` entry matches the host arch,
  // which cannot happen once both arches are tagged, but keeping them matches
  // the single-arch manifest shape electron-builder produces.
  if (arm64Feed.path !== undefined) merged.path = arm64Feed.path;
  if (arm64Feed.sha512 !== undefined) merged.sha512 = arm64Feed.sha512;
  const releaseDate = arm64Feed.releaseDate ?? x64Feed.releaseDate;
  if (releaseDate !== undefined) merged.releaseDate = releaseDate;

  NodeFS.writeFileSync(outputPath, stringify(merged), "utf8");
  NodeProcess.stdout.write(
    `Merged macOS update feed -> ${outputPath} (version ${arm64Feed.version}, ${mergedFiles.length} files)\n`,
  );
}

main();
