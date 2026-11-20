// Pass a copied node-pty package with an executable spawn-helper; never chmod the shared store.
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const require = NodeModule.createRequire(import.meta.url);
const pty = require(process.argv[2] ?? "node-pty") as typeof import("node-pty");
const encodeReport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Delivery =
  | { readonly kind: "data"; readonly text: string }
  | { readonly kind: "exit"; readonly code: number; readonly signal: number | undefined };

type Scenario = {
  readonly name: string;
  readonly command: string;
  readonly expected: string;
  readonly acknowledge?: string;
};

const run = (scenario: Scenario) =>
  Effect.callback<Delivery[]>((resume) => {
    const deliveries: Delivery[] = [];
    const term = pty.spawn("/bin/sh", ["-c", scenario.command], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: NodeOS.tmpdir(),
      env: { PATH: "/usr/bin:/bin", HOME: NodeOS.tmpdir(), TERM: "xterm-256color" },
    });
    let text = "";
    let acknowledged = false;
    let exited = false;
    const onData = term.onData((data) => {
      deliveries.push({ kind: "data", text: data });
      text += data;
      if (
        !acknowledged &&
        scenario.acknowledge !== undefined &&
        text.includes(scenario.acknowledge)
      ) {
        acknowledged = true;
        term.write("\n");
      }
    });
    const onExit = term.onExit((event) => {
      exited = true;
      deliveries.push({ kind: "exit", code: event.exitCode, signal: event.signal });
      resume(Effect.succeed(deliveries));
    });
    return Effect.sync(() => {
      onData.dispose();
      onExit.dispose();
      if (!exited) term.kill("SIGKILL");
    });
  }).pipe(Effect.timeout("10 seconds"));

const scenarios: ReadonlyArray<Scenario> = [
  { name: "burst", command: "printf '%4096s' ''", expected: " ".repeat(4096) },
  {
    name: "splitMultibyte",
    // The child cannot write the suffix until the client has received the prefix.
    command: "stty -echo; printf 'prefix\\303'; IFS= read -r ack; printf '\\251\\n'",
    expected: "prefixé\r\n",
    acknowledge: "prefix",
  },
  { name: "tailThenExit", command: "printf 'the-tail\\n'; exit 0", expected: "the-tail\r\n" },
  {
    name: "tailThenExitAgain",
    command: "printf 'second-tail\\n'; exit 0",
    expected: "second-tail\r\n",
  },
  { name: "incompleteTwoByteEof", command: "printf 'prefix\\303'", expected: "prefix\ufffd" },
  {
    name: "incompleteThreeByteEof",
    command: "printf 'prefix\\342\\202'",
    expected: "prefix\ufffd",
  },
  {
    name: "incompleteFourByteEof",
    command: "printf 'prefix\\360\\237\\230'",
    expected: "prefix\ufffd",
  },
  {
    name: "invalidSurrogate",
    command: "printf 'prefix\\355\\240\\200'",
    expected: "prefix\ufffd\ufffd\ufffd",
  },
  { name: "invalidByte", command: "printf 'prefix\\377'", expected: "prefix\ufffd" },
];

for (const scenario of scenarios) {
  const deliveries = await Effect.runPromise(run(scenario));
  const chunks = deliveries.filter((delivery) => delivery.kind === "data");
  const text = chunks.map((chunk) => chunk.text).join("");
  NodeAssert.equal(text, scenario.expected, scenario.name);
  NodeAssert.deepEqual(deliveries.at(-1), { kind: "exit", code: 0, signal: 0 });
  if (scenario.acknowledge !== undefined) {
    NodeAssert.ok(chunks.length >= 2, "prefix and suffix must arrive in separate deliveries");
    NodeAssert.equal(chunks[0]?.text, scenario.acknowledge);
  }
  process.stdout.write(
    encodeReport({
      name: scenario.name,
      sizes: chunks.map((chunk) => Buffer.byteLength(chunk.text)),
      replacement: text.includes("\u{fffd}"),
      lastIsExit: deliveries.at(-1)?.kind === "exit",
      bytes: Buffer.byteLength(text),
      prefix: text.slice(0, 32),
    }) + "\n",
  );
}
