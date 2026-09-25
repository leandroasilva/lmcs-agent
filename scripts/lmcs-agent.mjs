import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const tasks = new Set(["build", "build:desktop", "test", "typecheck", "lint", "fmt:check"]);
const devTasks = new Set(["dev", "dev:server", "dev:web", "dev:desktop"]);

/** Keep upstream scripts intact while isolating the local runtime and data directory. */
export function createLaunch(task, args = [], directory = root) {
  const home = NodePath.join(directory, ".lmcs-agent");
  let command;
  if (task === "setup") {
    command = [
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--store-dir",
      NodePath.join(directory, ".pnpm-store"),
    ];
  } else if (devTasks.has(task)) {
    command = ["npm", "run", task, "--", "--home-dir", home];
  } else if (task === "start") {
    command = ["node", "apps/server/dist/bin.mjs", "--base-dir", home, "--host", "127.0.0.1"];
  } else if (tasks.has(task)) {
    command = ["npm", "run", task, "--"];
  } else {
    throw new Error(
      `Unknown task: ${task}. Choose setup, start, ${[...devTasks, ...tasks].join(", ")}.`,
    );
  }

  return {
    cwd: directory,
    args: [
      "exec",
      "--cache",
      NodePath.join(directory, "node_modules/.cache/npm"),
      "--yes",
      "--package=node@24.18.0",
      "--package=pnpm@11.10.0",
      "--",
      ...command,
      ...args,
    ],
  };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    const launch = createLaunch(process.argv[2] ?? "dev", process.argv.slice(3));
    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
      throw new Error("Run this launcher through npm: npm run lmcs -- <task> [options].");
    }
    const child = NodeChildProcess.spawn(process.execPath, [npmCli, ...launch.args], {
      cwd: launch.cwd,
      stdio: "inherit",
      env: process.env,
    });
    const onInterrupt = () => child.kill("SIGINT");
    const onTerminate = () => child.kill("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
