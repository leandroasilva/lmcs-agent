import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createLaunch } from "./lmcs-agent.mjs";

const directory = NodePath.resolve("workspace with spaces", "lmcs-agent");

function runtimeArguments(launch) {
  return launch.args.slice(launch.args.indexOf("--") + 1);
}

describe("LMCS Agent launcher", () => {
  it("pins the toolchain and keeps its cache inside the checkout", () => {
    const launch = createLaunch("setup", [], directory);
    expect(launch.cwd).toBe(directory);
    expect(launch.args).toContain("--package=node@24.18.0");
    expect(launch.args).toContain("--package=pnpm@11.10.0");
    expect(launch.args).toContain(NodePath.join(directory, "node_modules/.cache/npm"));
    expect(runtimeArguments(launch)).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--store-dir",
      NodePath.join(directory, ".pnpm-store"),
    ]);
  });

  it.each(["dev", "dev:server", "dev:web", "dev:desktop"])(
    "isolates %s data without changing the upstream script",
    (task) => {
      expect(runtimeArguments(createLaunch(task, [], directory))).toEqual([
        "npm",
        "run",
        task,
        "--",
        "--home-dir",
        NodePath.join(directory, ".lmcs-agent"),
      ]);
    },
  );

  it("starts the built server on loopback with isolated data", () => {
    expect(runtimeArguments(createLaunch("start", ["--port", "14000"], directory))).toEqual([
      "node",
      "apps/server/dist/bin.mjs",
      "--base-dir",
      NodePath.join(directory, ".lmcs-agent"),
      "--host",
      "127.0.0.1",
      "--port",
      "14000",
    ]);
  });

  it("preserves arguments containing spaces as individual arguments", () => {
    expect(runtimeArguments(createLaunch("test", ["a file.test.ts"], directory))).toEqual([
      "npm",
      "run",
      "test",
      "--",
      "a file.test.ts",
    ]);
  });

  it("rejects unsupported tasks before spawning a process", () => {
    expect(() => createLaunch("publish")).toThrow("Unknown task: publish");
  });
});
