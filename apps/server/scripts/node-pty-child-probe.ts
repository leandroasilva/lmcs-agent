// The other half of the PTY swap: what the packaged `node-pty` actually hands a child process,
// measured on this host.
//
// `native/pty/tests/native_pty.rs` asks `portable-pty` the same questions and asserts the answers,
// so running both on one machine turns the deviation list in `native/pty/src/native_pty.rs` into
// something a maintainer can re-check rather than a claim to trust:
//
//   cargo test -p lmcs-pty --test native_pty
//   node apps/server/scripts/node-pty-child-probe.ts [directory-holding-node-pty]
//
// Each line is one scenario. The probe scenarios print the same `key=value|key=value` fields in
// the same order as the Rust side; the only difference is which parent-only variable the `leak=`
// field watches, because each side names a variable its own process really has.
//
// The directory argument exists because pnpm hardlinks `node_modules` into a machine-wide store,
// and a prebuilt `spawn-helper` that needs its executable bit fixed must be fixed on a copy, not
// on the store. The shipped product makes that same fix for its own install
// (`NodePtyAdapter.ensureNodePtySpawnHelperExecutable`); this script refuses to make it anywhere:
//
//   cp -R "$(realpath apps/server/node_modules/node-pty)" /tmp/ptyprobe
//   chmod +x /tmp/ptyprobe/prebuilds/darwin-arm64/spawn-helper
//   node apps/server/scripts/node-pty-child-probe.ts /tmp/ptyprobe

import * as FileSystem from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

const requireFromHere = Module.createRequire(import.meta.url);

/** The shape `NodePtyAdapter.spawn` builds; the adapter itself is measured by `node-pty-adapter-trace.ts`. */
const SPAWN_OPTIONS = {
  name: "xterm-256color",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
} as const;

/** A variable this process has and the spawn environment does not: it must not reach the child. */
process.env["LMCS_LEAK_PROBE"] = "leaked";

// Not a template literal: the shell has to see `$LMCS_LEAK_PROBE`, and every `$` here would need
// escaping in one.
const PROBE = [
  "printf 'term=%s|terms=%s|marker=%s|leak=%s|shell=%s|size=%s|pwd=%s|arg0=%s|argc=%s\\n' ",
  '"$TERM" "$(env | grep -c \'^TERM=\')" spawned "$LMCS_LEAK_PROBE" "$SHELL" ',
  '"$(stty size < /dev/tty 2>/dev/null)" "$(/bin/pwd)" "$0" "$#"',
].join("");

type Scenario = {
  readonly name: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly options?: Record<string, unknown>;
  /** Applied, then this is written, once the child is up. */
  readonly afterResize?: readonly [cols: number, rows: number];
  readonly thenWrite?: string;
  /** `null` means call `kill()` with no argument at all. */
  readonly killWith?: string | null;
};

const sh = (script: string): readonly string[] => ["-c", script];

const SCENARIOS: readonly Scenario[] = [
  { name: "probe", file: "/bin/sh", args: sh(PROBE), options: { cols: 132, rows: 43 } },
  {
    name: "termDumb",
    file: "/bin/sh",
    args: sh(PROBE),
    options: { env: { PATH: "/usr/bin:/bin", HOME: "/tmp", TERM: "dumb" } },
  },
  {
    name: "termEmpty",
    file: "/bin/sh",
    args: sh(PROBE),
    options: { env: { PATH: "/usr/bin:/bin", HOME: "/tmp", TERM: "" } },
  },
  { name: "exit0", file: "/bin/sh", args: sh("exit 0") },
  { name: "exit3", file: "/bin/sh", args: sh("exit 3") },
  { name: "killSelf9", file: "/bin/sh", args: sh("kill -9 $$") },
  { name: "killSelf15", file: "/bin/sh", args: sh("kill -TERM $$") },
  { name: "hugeCols", file: "/bin/sh", args: sh(PROBE), options: { cols: 65_539, rows: 3 } },
  {
    name: "resize",
    file: "/bin/sh",
    // The child reports the kernel's window only after it is handed a line, so the write below is
    // what makes "resize first, then look" a sequence rather than a race.
    args: sh("read -r _ ; stty size < /dev/tty"),
    afterResize: [100, 30],
    thenWrite: "\n",
  },
  { name: "missingExecutable", file: "/bin/definitely-not-here", args: [] },
  {
    name: "missingCwd",
    file: "/bin/sh",
    args: sh(PROBE),
    options: { cwd: "/definitely/not/a/dir" },
  },
  { name: "killNoSignal", file: "/bin/sh", args: sh("sleep 5"), killWith: null },
  { name: "killSigterm", file: "/bin/sh", args: sh("exec sleep 5"), killWith: "SIGTERM" },
  { name: "killSigkill", file: "/bin/sh", args: sh("exec sleep 5"), killWith: "SIGKILL" },
];

/** Prints a scenario's answer, and never blocks the run: a library that throws is one result. */
function ask(pty: typeof import("node-pty"), scenario: Scenario): Promise<void> {
  return new Promise((resolve) => {
    const options = { ...SPAWN_OPTIONS, ...scenario.options };
    let buffer = "";
    let settled = false;
    const finish = (fields: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      const out = buffer.replace(/\r/g, "").trim().replace(/\n/g, " ");
      process.stdout.write(
        `scenario=${scenario.name}|${Object.entries(fields)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${value}`)
          .join("|")}|out=${out}\n`,
      );
      resolve();
    };

    let child;
    try {
      child = pty.spawn(scenario.file, [...scenario.args], options);
    } catch (error) {
      finish({ threw: (error as Error).message ?? String(error) });
      return;
    }

    child.onData((data) => {
      buffer += data;
    });
    child.onExit(({ exitCode, signal }) => finish({ exit: exitCode, signal: signal ?? null }));

    if (scenario.killWith !== undefined || scenario.thenWrite !== undefined) {
      // Both flows wait on nothing but the child being up, which `sleep 5` and a blocked `read`
      // each give generously.
      setTimeout(() => {
        if (scenario.afterResize !== undefined) {
          const [cols, rows] = scenario.afterResize;
          child.resize(cols, rows);
        }
        if (scenario.thenWrite !== undefined) child.write(scenario.thenWrite);
        if (scenario.killWith !== undefined) {
          try {
            // `killWith: null` is a `kill()` with no argument, which is what the shipped Windows
            // branch reaches by dropping the signal. Passing `undefined` here instead would make
            // every scenario end this way, since node-pty's default is SIGHUP.
            child.kill(scenario.killWith ?? undefined);
          } catch (error) {
            finish({ threwKill: (error as Error).message ?? String(error) });
          }
        }
      }, 300);
    }
  });
}

function resolvePackage(): string {
  const given = process.argv[2];
  if (given === undefined) return "node-pty";
  const directory = Path.resolve(given);
  if (!FileSystem.existsSync(directory)) {
    throw new Error(`${directory} is not a node-pty package directory`);
  }
  return directory;
}

function assertSpawnHelperExecutable(pkg: string): void {
  if (process.platform === "win32") return;
  const triple = `${process.platform}-${process.arch}`;
  const candidates = [
    Path.join(pkg, "build", "Release", "spawn-helper"),
    Path.join(pkg, "prebuilds", triple, "spawn-helper"),
  ];
  const helper = candidates.find((candidate) => FileSystem.existsSync(candidate));
  if (helper === undefined) return;
  try {
    FileSystem.accessSync(helper, FileSystem.constants.X_OK);
  } catch {
    throw new Error(
      `${helper} is not executable, so every spawn below would fail for that reason alone.\n` +
        `Copy the package and fix the copy, so nothing is written into the shared store.`,
    );
  }
}

async function run(): Promise<void> {
  const request = resolvePackage();
  const pty = requireFromHere(request) as typeof import("node-pty");
  if (request !== "node-pty") assertSpawnHelperExecutable(request);

  for (const scenario of SCENARIOS) {
    await ask(pty, scenario);
  }
}

run().then(
  () => process.exit(0),
  (cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  },
);
