// Trace generator for the sanitizer golden. Drives the shipped `TerminalManager`
// end to end — spawn, PTY reads, close, read the persisted history log — so the
// Rust port is checked against the real pipeline, not a copy of it.
//
// `node apps/server/scripts/terminal-sanitize-trace.ts > /tmp/sanitize-trace.txt`

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../src/processRunner.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";

class TracePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 9000;
  private readonly dataListeners = new Set<(data: string) => void>();
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }
  onExit(): () => void {
    return () => {};
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class TracePtyAdapter {
  readonly processes: TracePtyProcess[] = [];
  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new TracePtyProcess();
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

// Realistic traffic: prompts, bracketed paste, colour, title, device queries and
// their replies, DCS capability probes, sixel, C1 single-byte spellings, and the
// setters that look like queries but must survive.
const STREAM = [
  "\u001b[?2004h",
  "user@host:~/lmcs$ ",
  "\u001b[6n",
  "\u001b[?u",
  "\u001b[?1u",
  "git status\r\n",
  "\u001b]0;git status\u0007",
  "\u001b]11;?\u0007",
  "On branch \u001b[32mlmcs-agent-rust\u001b[0m\r\n",
  "\u001b[12;4R",
  '\u001bP$q"p\u001b\\',
  "\u001bP1$r\u001b\\",
  "\u001bP+r6b69747479\u001b\\",
  "\u001bPq#0;2;0;0;0!10~\u001b\\",
  "nothing to commit\r\n",
  "\u001b[>0q",
  "\u001b[1 q",
  "\u001b[?25l",
  "caf\u00e9 \u540d \ud83d\ude80\r\n",
  "\u001b[c",
  "\u001b[>c",
  "\u001b[?1;2c",
  "\u001b[!p",
  "\u001b[?62$p",
  "\u001b[?1$y",
  "\u001b]11;rgb:0000/0000/0000\u001b\\",
  "\u001b]7;file://host/path\u0007",
  "\u009b31mred\u009b0m",
  "\u009d10;?\u0007",
  "\u0090$q#0;2;0;0;0\u009c",
  "\u009eapc\u0007",
  "\u001b(B",
  "\u001b7",
  "\u001b8",
  "\u001bM",
  // Kept neighbours of every stripped form, so a predicate that over-strips is
  // visible in the persisted bytes rather than only in the unit table.
  "\u001b]10;#ff0000\u0007",
  "\u001b]12;#ffffff\u0007",
  "\u001b]13;?\u0007",
  "\u001b[1$xR",
  "\u001b[!c",
  '\u001b[61;1"p',
  '\u001b[61;1"y',
  "\u001b[q",
  "\u001b[u",
  "\u001bP1;2$r\u001b\\",
  "\u001bP01$qx\u001b\\",
  "tail line\r\n",
].join("");

// Chunk sizes that cut sequences open, so the held-sequence path is exercised.
function chunks(stream: string): string[] {
  const out: string[] = [];
  const points = Array.from(stream);
  let index = 0;
  let step = 1;
  while (index < points.length) {
    const size = ((step * 7) % 11) + 1;
    out.push(points.slice(index, index + size).join(""));
    index += size;
    step += 1;
  }
  return out;
}

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");

const run = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const pieces = chunks(STREAM);
  const out: string[] = [];

  for (const [maxLines, maxBytes] of [
    [5_000, Infinity],
    [3, Infinity],
    [5_000, 24],
  ] as const) {
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
    const logsDir = join(baseDir, "userdata", "logs", "terminals");
    const ptyAdapter = new TracePtyAdapter();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir,
      historyLineLimit: maxLines,
      ...(maxBytes === Infinity ? {} : { historyByteLimit: maxBytes }),
      ptyAdapter,
      processKillGraceMs: 1,
    });
    yield* manager.open({
      threadId: "thread-1",
      terminalId: "term-1",
      cwd: process.cwd(),
      cols: 100,
      rows: 24,
    });
    for (const piece of pieces) ptyAdapter.processes[0]!.emitData(piece);
    yield* manager.close({ threadId: "thread-1" });

    const logPath = join(logsDir, `terminal_${Buffer.from("thread-1").toString("base64url")}.log`);
    const persisted = Buffer.from(yield* fileSystem.readFile(logPath)).toString("utf8");
    out.push(`C ${maxLines} ${maxBytes === Infinity ? "INF" : maxBytes}`);
    for (const piece of pieces) out.push(`I ${hex(piece)}`);
    out.push(`H ${hex(persisted)}`);
  }

  process.stderr.write(`trace records: ${out.length}\n`);
  process.stdout.write(`${out.join("\n")}\n`);
});

Effect.runPromise(
  Effect.scoped(run).pipe(
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
