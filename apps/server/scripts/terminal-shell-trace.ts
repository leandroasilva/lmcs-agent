// Trace generator for the PTY spawn golden. Drives the shipped `TerminalManager`
// through the seams it already has — injected `env`, injected `shellResolver`, the
// `HostProcessPlatform` reference and `makeWithOptions`'s `ptyAdapter` — so the Rust
// port is checked against the shipped candidate list, the shipped child environment
// and the shipped fallback loop instead of against a re-reading of them.
//
// `HostProcessPlatform` is a `Context.Reference`, so the Windows branch is measured on
// a POSIX host: the platform is an argument, not a fact about the machine.
//
// `node apps/server/scripts/terminal-shell-trace.ts > /tmp/pty-trace.txt`

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@lmcstools/core/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as ProcessRunner from "../src/processRunner.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";

type Attempt = {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Array<[string, string]>;
};

class RecordingPtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 4242;
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): () => void {
    return () => {};
  }
  onExit(): () => void {
    return () => {};
  }
}

type FailMode = "none" | "retryable" | "fatal" | "fatal-string";

class RecordingPtyAdapter {
  readonly attempts: Attempt[] = [];
  readonly failMode: FailMode;

  constructor(failMode: FailMode) {
    this.failMode = failMode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.attempts.push({
      shell: input.shell,
      ...(input.args === undefined ? {} : { args: input.args }),
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: Object.entries(input.env),
    });

    if (this.failMode === "none") {
      return Effect.succeed(new RecordingPtyProcess());
    }
    // `node-pty` reports a missing executable through a nested cause, which the
    // shipped retry predicate has to reach by walking `cause`; the manager's own
    // exhausted-candidates error wraps a previous error one level deeper again.
    const cause =
      this.failMode === "fatal"
        ? new Error("EACCES: permission denied")
        : this.failMode === "fatal-string"
          ? "EACCES: permission denied"
          : { message: "posix_spawnp failed.", cause: { message: "Extra detail." } };
    return Effect.fail(
      new PtyAdapter.PtySpawnError({
        adapter: "node-pty",
        shell: input.shell,
        cause,
      }),
    );
  }
}

const machinePaths = [process.env["HOME"] ?? "", process.env["TMPDIR"] ?? "", process.cwd()].filter(
  (value) => value.length > 0,
);

/**
 * Keep the trace portable: no record may carry a path that only exists on this host,
 * including the per-case temporary directory, whose suffix is random.
 */
function mask(text: string, temporaryDirectory: string): string {
  const values = [...machinePaths, temporaryDirectory]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  let masked = text;
  for (const value of values) {
    masked = masked.split(value).join("<M>");
  }
  return masked;
}

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");

const failureText = (error: unknown): string =>
  String((error as { message?: string }).message ?? error);

type Case = {
  readonly name: string;
  readonly platform: NodeJS.Platform;
  readonly baseEnv: Record<string, string>;
  /** `undefined` keeps the shipped default resolver (`env.SHELL ?? "bash"`). */
  readonly shell?: string;
  readonly runtimeEnv?: Record<string, string>;
  readonly failMode: FailMode;
};

// Every case names the behavior it exists to pin down. The list is the record: a
// candidate order, an argument list, an environment key sequence.
const cases: ReadonlyArray<Case> = [
  {
    // POSIX happy path: the default resolver reads $SHELL, which is also the second
    // candidate, so the requested candidate must dedupe against it.
    name: "posixDefault",
    platform: "darwin",
    baseEnv: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", HOME: "/home/u" },
    failMode: "none",
  },
  {
    // Blocklist and casing: `LMCS_*`/`VITE_*` prefixes and the three exact names are
    // matched after upper-casing, so a lower-case `port` is stripped too. `COLORTERM`
    // empty is replaced, not preserved.
    name: "posixEnvBlocklist",
    platform: "darwin",
    baseEnv: {
      SHELL: "/bin/bash",
      LMCS_TOKEN: "secret",
      lmcs_lower: "secret",
      VITE_URL: "http://x",
      vite_lower: "http://x",
      PORT: "3000",
      port: "3001",
      ELECTRON_RUN_AS_NODE: "1",
      COLORTERM: "",
      PSModulePath: "keep",
      DISPLAY: ":0",
    },
    failMode: "retryable",
  },
  {
    // `normalizeShellCommand` on POSIX: trim, first whitespace token, then one leading
    // and one trailing quote. U+00A0 is whitespace to JavaScript; U+0085 is not.
    name: "posixShellTokenizing",
    platform: "darwin",
    baseEnv: { SHELL: "/bin/sh" },
    shell: "  \u00a0'/bin/zsh'\u00a0--login  ",
    failMode: "retryable",
  },
  {
    // Second token survives when the separator is NEL: JavaScript's `\s` does not
    // include U+0085, so the whole string is the "token".
    name: "posixShellNelSeparator",
    platform: "darwin",
    baseEnv: { SHELL: "/bin/sh" },
    shell: "/bin/zsh\u0085--login",
    failMode: "retryable",
  },
  {
    // Nested quotes: only the outermost pair is removed, so the candidate shell keeps
    // quotes in its name and the basename still resolves to bash.
    name: "posixShellDoubleQuote",
    platform: "darwin",
    baseEnv: { SHELL: "/bin/sh" },
    shell: `"'/bin/bash'"`,
    failMode: "retryable",
  },
  {
    // Blank request falls through to `$SHELL`; a bare `zsh` request dedupes against the
    // bare `zsh` candidate but not against `/bin/zsh` (keys are the full command).
    name: "posixBlankAndBare",
    platform: "darwin",
    baseEnv: { SHELL: "zsh" },
    shell: "   ",
    failMode: "retryable",
  },
  {
    // No `$SHELL` at all: the default resolver yields `bash`, the last candidate is
    // still `sh`, and the zsh candidate carries `-o nopromptsp`.
    name: "posixNoShellVar",
    platform: "linux",
    baseEnv: { PATH: "/usr/bin" },
    failMode: "retryable",
  },
  {
    // `$SHELL` with backslashes on POSIX is a file name, not a path: separators are
    // only folded for the platform, so the basename is the whole string.
    name: "posixBackslashName",
    platform: "linux",
    baseEnv: { SHELL: "C:\\Windows\\System32\\cmd.exe" },
    failMode: "retryable",
  },
  {
    // Windows: `pwsh.exe` default, PowerShell resolved from `%SystemRoot%`, `%ComSpec%`
    // verbatim, `cmd.exe` from `%windir%`. Trailing separators on `SystemRoot` are cut
    // by `joinWindowsPath`, not by the lookup.
    name: "win32Defaults",
    platform: "win32",
    baseEnv: {
      SystemRoot: "D:\\sys\\",
      windir: "E:\\windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
    },
    failMode: "retryable",
  },
  {
    // Windows lookups are exact-key in this seam: `%SYSTEMROOT%` is not found, so both
    // absolute candidates fall back to `C:\Windows`.
    name: "win32KeyCasing",
    platform: "win32",
    baseEnv: { SYSTEMROOT: "D:\\sys", COMSPEC: "C:\\x\\cmd.exe" },
    failMode: "retryable",
  },
  {
    // Windows trims but does not tokenize: a whole command line stays one shell, and
    // forward slashes still yield the `.exe` basename that earns `-NoLogo`.
    name: "win32NoTokenizing",
    platform: "win32",
    baseEnv: {},
    shell: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile",
    failMode: "retryable",
  },
  {
    // Requested shell equals a later candidate: deduped by the formatted key.
    name: "win32DedupesComSpec",
    platform: "win32",
    baseEnv: { SystemRoot: "C:\\Windows", ComSpec: "pwsh.exe" },
    shell: "PWSH.EXE",
    failMode: "retryable",
  },
  {
    // AppImage scrub: markers removed, mount segments cut from the four path-like
    // variables, and a variable left with no segments removed entirely.
    name: "linuxAppImageScrub",
    platform: "linux",
    baseEnv: {
      SHELL: "/bin/sh",
      APPIMAGE: "/x/lmcs.AppImage",
      APPDIR: "/tmp/mount-XXXX//",
      ARGV0: "lmcs",
      OWD: "/x",
      PATH: "/usr/bin:/tmp/mount-XXXX/usr/bin:/bin",
      LD_LIBRARY_PATH: "/tmp/mount-XXXX/usr/lib",
      XDG_DATA_DIRS: "/usr/share:/tmp/mount-XXXX/usr/share",
      GSETTINGS_SCHEMA_DIR: "/tmp/mount-XXXX/usr/share/glib-2.0/schemas",
    },
    failMode: "retryable",
  },
  {
    // Runtime overrides: applied after the blocklist (so an `LMCS_*` runtime key
    // survives), `~` expanded only for the two config homes, and COLORTERM from the
    // client suppressing the `truecolor` default.
    name: "posixRuntimeOverrides",
    platform: "linux",
    baseEnv: { SHELL: "/bin/bash", PATH: "/usr/bin" },
    runtimeEnv: {
      zzz: "1",
      CODEX_HOME: "~/codex",
      CLAUDE_CONFIG_DIR: "~/claude",
      LMCS_FORCED: "x",
      COLORTERM: "256color",
    },
    failMode: "retryable",
  },
  {
    // Only the two config homes are `~`-expanded, and expansion goes through
    // `path.join`, so `.` and `..` segments and doubled separators are normalised
    // while an unexpanded value keeps its spelling.
    name: "posixRuntimeHomeShapes",
    platform: "linux",
    baseEnv: { SHELL: "/bin/bash" },
    runtimeEnv: {
      UNRELATED: "~//./x",
      CODEX_HOME: "~/mounts/../codex",
      CLAUDE_CONFIG_DIR: "~/claude/",
    },
    failMode: "retryable",
  },
  {
    // A `COLORTERM` that exists but is empty is replaced; a present one is left alone.
    name: "posixColorTermPresent",
    platform: "linux",
    baseEnv: { SHELL: "/bin/bash", COLORTERM: "24bit" },
    failMode: "retryable",
  },
  {
    // Non-retryable cause stops the loop after the first candidate.
    name: "posixFatalFirst",
    platform: "linux",
    baseEnv: { SHELL: "/bin/bash" },
    failMode: "fatal",
  },
  {
    // A bare string cause is walked too, and stops the loop just as hard.
    name: "posixFatalString",
    platform: "linux",
    baseEnv: { SHELL: "/bin/bash" },
    failMode: "fatal-string",
  },
  {
    // Every candidate fails retryably: the manager's own error lists the formatted
    // candidates, which is the only place `formatShellCandidate` is observable.
    name: "posixAllRetryable",
    platform: "linux",
    baseEnv: { SHELL: "/usr/local/bin/my shell" },
    failMode: "retryable",
  },
  {
    // The AppImage gate is on either marker, so `APPIMAGE` alone still scrubs the four
    // markers — but with no `APPDIR` there is no mount root to cut out of PATH.
    name: "posixAppImageMarkerOnly",
    platform: "linux",
    baseEnv: {
      SHELL: "/bin/sh",
      APPIMAGE: "/x/lmcs.AppImage",
      ARGV0: "lmcs",
      OWD: "/x",
      PATH: "/usr/bin:/tmp/mount-XXXX/usr/bin",
    },
    failMode: "none",
  },
  {
    // A PATH segment equal to the mount root itself, not merely below it, is a mount
    // segment too; the segments under it are cut by the prefix rule.
    name: "linuxAppImageMountRoot",
    platform: "linux",
    baseEnv: {
      SHELL: "/bin/bash",
      APPDIR: "/tmp/mount-XXXX",
      PATH: "/tmp/mount-XXXX:/usr/bin:/tmp/mount-XXXX/bin:/tmp/other/bin",
      XDG_DATA_DIRS: "/tmp/mount-XXXX",
    },
    failMode: "none",
  },
];

const run = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const out: string[] = [];

  for (const input of cases) {
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pty-trace-" });
    const cwd = join(baseDir, "work");
    yield* fileSystem.makeDirectory(cwd, { recursive: true });
    const requested = input.shell;
    const messages: string[] = [];

    // The manager reads `HostProcessPlatform` once, at construction, so the reference
    // has to be in scope before `makeWithOptions` runs — not around `open`.
    const { adapter, opened } = yield* Effect.gen(function* () {
      const recording = new RecordingPtyAdapter(input.failMode);
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir: join(baseDir, "logs"),
        ptyAdapter: recording,
        env: input.baseEnv,
        ...(requested === undefined ? {} : { shellResolver: () => requested }),
        processKillGraceMs: 1,
      });
      // A failed spawn is not an `open` failure: the reason leaves the server as an
      // `error` event on the terminal stream, so that is where the record reads it.
      yield* manager.subscribe((event) =>
        event.type === "error" ? Effect.sync(() => messages.push(event.message)) : Effect.void,
      );
      const result = yield* Effect.result(
        manager.open({
          threadId: "thread-1",
          terminalId: "term-1",
          cwd,
          cols: 100,
          rows: 24,
          ...(input.runtimeEnv === undefined ? {} : { env: input.runtimeEnv }),
        }),
      );
      return { adapter: recording, opened: result };
    }).pipe(Effect.provideService(HostProcessPlatform, input.platform));

    // `open` reports a failed spawn as a session in `error` status rather than failing
    // the call, so both halves of the result are part of the record.
    out.push(`C ${input.name} ${input.platform} ${adapter.attempts.length}`);
    out.push(
      `N ${hex(
        JSON.stringify({
          platform: input.platform,
          baseEnv: Object.entries(input.baseEnv),
          shell: input.shell ?? null,
          runtimeEnv: input.runtimeEnv === undefined ? null : Object.entries(input.runtimeEnv),
          failMode: input.failMode,
        }),
      )}`,
    );
    for (const [index, attempt] of adapter.attempts.entries()) {
      const { env, ...rest } = attempt;
      out.push(`A ${index} ${hex(mask(JSON.stringify(rest), baseDir))}`);
      if (index === 0) {
        out.push(`V ${env.length} ${hex(mask(JSON.stringify(env), baseDir))}`);
      }
    }
    if (opened._tag === "Success") {
      const { history, updatedAt, ...visible } = opened.success;
      out.push(`S ${hex(mask(JSON.stringify(visible), baseDir))}`);
    } else {
      out.push(`E ${hex(mask(failureText(opened.failure), baseDir))}`);
    }
    for (const message of messages) {
      out.push(`M ${hex(mask(message, baseDir))}`);
    }
  }

  process.stderr.write(`trace cases: ${cases.length}\n`);
  process.stdout.write(`${out.join("\n")}\n`);
});

Effect.runPromise(
  Effect.scoped(run).pipe(
    // A failed spawn logs at ERROR, which would land on the same stream as the trace.
    Effect.provide(Logger.layer([])),
    Effect.provide(
      Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  ),
).then(
  () => process.exit(0),
  (cause) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exit(1);
  },
);
