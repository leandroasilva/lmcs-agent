// Chunking probe for the terminal transport golden (fatia 11). The pipe trace measures what the
// shipped manager *does* with the strings it is handed; this measures where those strings come
// from, because three of the read side's decisions are the library's and not the manager's:
//
//   1. How big a delivery is. The manager publishes one event per `onData` call, so the chunk
//      boundary is the client's event boundary — a 4 KB `cat` is N events with N sequences, and N
//      is whatever the library's reader happened to read.
//   2. What happens to a UTF-8 sequence split across two reads. `unixTerminal.js` calls
//      `_socket.setEncoding("utf8")` on a `tty.ReadStream`, and Node's StringDecoder holds an
//      incomplete trailing sequence back to prepend to the next chunk. If that is what the product
//      does, a Rust port that decodes each read on its own corrupts a character in the middle of a
//      stream, and a port that buffers partial sequences reproduces the shipped behavior.
//   3. Whether the exit can overtake the last output. A wait can return while bytes are still in
//      the terminal buffer, and the manager's exit teardown drops everything queued behind the
//      exit (measured in `terminal-pipe-trace.ts`). So an ordering here decides whether a user sees
//      the tail of a command.
//
// The probes print what the library reported rather than what it should have reported. A scenario
// whose interleaving did not happen is visible in its own line — `data=1` for `splitMultibyte`
// means the split was not achieved and nothing about decoding was learned.
//
//   node apps/server/scripts/node-pty-chunking-probe.ts

import * as os from "node:os";
import * as pty from "node-pty";

type Delivery =
  | { readonly kind: "data"; readonly text: string }
  | {
      readonly kind: "exit";
      readonly code: number | undefined;
      readonly signal: number | undefined;
    };

const shell = process.env["SHELL"] || "/bin/sh";

const run = (command: string, limitMs: number): Promise<Delivery[]> =>
  new Promise((resolve) => {
    const deliveries: Delivery[] = [];
    const term = pty.spawn(shell, ["-c", command], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { ...process.env, TERM: "xterm-256color" },
    });
    term.onData((data) => {
      deliveries.push({ kind: "data", text: data });
    });
    term.onExit((event) => {
      deliveries.push({ kind: "exit", code: event.exitCode, signal: event.signal });
      resolve(deliveries);
    });
    setTimeout(() => {
      try {
        term.kill("SIGHUP");
      } catch {
        // Already gone; the exit handler resolved above.
      }
    }, limitMs);
  });

const report = (name: string, deliveries: Delivery[]) => {
  const chunks = deliveries.filter(
    (delivery): delivery is Extract<Delivery, { kind: "data" }> => delivery.kind === "data",
  );
  const exit = deliveries.find((delivery) => delivery.kind === "exit");
  const sizes = chunks.map((chunk) => Buffer.from(chunk.text, "utf8").length);
  process.stdout.write(
    `${name} deliveries=${deliveries.length} data=${chunks.length} sizes=${sizes.join(",")} ` +
      `exit=${exit && exit.kind === "exit" ? `${exit.code}|${exit.signal}` : "none"} ` +
      `lastIsExit=${deliveries.at(-1)?.kind === "exit"}\n`,
  );
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.text, "utf8");
    process.stdout.write(
      `  chunk bytes=${bytes.length} codepoints=${[...chunk.text].length} ` +
        `replacement=${chunk.text.includes("\u{fffd}")} hex=${bytes.toString("hex").slice(0, 40)}\n`,
    );
  }
  const text = chunks.map((chunk) => chunk.text).join("");
  process.stdout.write(`  joined=${JSON.stringify(text.slice(0, 60))}\n`);
};

const scenarios: ReadonlyArray<readonly [string, string, number]> = [
  // One big write: how the library splits it.
  ["burst", "python3 -c \"import sys; sys.stdout.write('x'*4096); sys.stdout.flush()\"", 5000],
  // Two writes, one character's halves, 400 ms apart.
  ["splitMultibyte", "printf '\\303'; sleep 0.4; printf '\\251\\n'", 5000],
  // Output and exit in one breath, twice, so a race that only sometimes drops the tail shows up.
  ["tailThenExit", "printf 'the-tail\\n'; exit 0", 5000],
  ["tailThenExitAgain", "printf 'second-tail\\n'; exit 0", 5000],
];

for (const [name, command, limit] of scenarios) {
  report(name, await run(command, limit));
}
