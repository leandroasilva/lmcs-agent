import * as NodeAssert from "node:assert/strict";
import { makeKeyedCoalescingWorker } from "@lmcstools/core/KeyedCoalescingWorker";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { BoundedTerminalHistory } from "../src/terminal/Manager.ts";

// Scheduling/reference oracle only: gates replace Manager's debounce and I/O.
// This does not validate Rust's Arc/Mutex, cancellable 40ms delay, or sanitizer.
type Session = readonly [threadId: string, terminalId: string];
interface PersistRequest {
  readonly history: BoundedTerminalHistory;
  readonly immediate: boolean;
}
interface Begin {
  readonly key: string;
  readonly holderID: string;
  readonly immediate: boolean;
  readonly release: Deferred.Deferred<void>;
}
interface Write {
  readonly begin: Begin;
  readonly content: string;
}

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
const sessionKey = ([threadId, terminalId]: Session) => `${threadId}\u0000${terminalId}`;
const primary: Session = ["thread-a", "terminal-1"];
const other: Session = ["thread-a", "terminal-2"];

const makeTrace = Effect.fnUntraced(function* (rows: string[]) {
  const begins = yield* Effect.acquireRelease(Queue.unbounded<Begin>(), Queue.shutdown);
  const writes = yield* Effect.acquireRelease(Queue.unbounded<Write>(), Queue.shutdown);
  const holderIDs = new Map<BoundedTerminalHistory, string>();
  const usedIDs = new Set<string>();

  const holderID = (history: BoundedTerminalHistory) => {
    const id = holderIDs.get(history);
    NodeAssert.ok(id !== undefined, "unregistered history holder");
    return id;
  };

  const worker = yield* makeKeyedCoalescingWorker<string, PersistRequest, never, never>({
    // Match terminal/Manager.ts's persistWorker merge, not a second scheduler.
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fnUntraced(function* (key, request) {
      const release = yield* Deferred.make<void>();
      const begin: Begin = {
        key,
        holderID: holderID(request.history),
        immediate: request.immediate,
        release,
      };
      yield* Queue.offer(begins, begin);
      yield* Deferred.await(release);
      yield* Queue.offer(writes, { begin, content: request.history.value() });
    }),
  });

  const history = (id: string, initial: string) => {
    NodeAssert.match(id, /^[a-z][a-z0-9-]*$/);
    NodeAssert.ok(!usedIDs.has(id), `duplicate holder ID: ${id}`);
    usedIDs.add(id);
    // Fixtures remain well below these limits; this trace does not test truncation.
    const holder = new BoundedTerminalHistory(100, initial, 64_000);
    holderIDs.set(holder, id);
    rows.push(["H", id, hex(initial)].join("\t"));
    return holder;
  };

  const enqueue = Effect.fnUntraced(function* (
    session: Session,
    history: BoundedTerminalHistory,
    immediate: boolean,
  ) {
    yield* worker.enqueue(sessionKey(session), { history, immediate });
    rows.push(
      ["E", hex(session[0]), hex(session[1]), holderID(history), Number(immediate)].join("\t"),
    );
  });

  const begin = Effect.fnUntraced(function* (
    session: Session,
    history: BoundedTerminalHistory,
    immediate: boolean,
  ) {
    const receipt = yield* Queue.take(begins);
    rows.push(["B", hex(receipt.key), receipt.holderID, Number(receipt.immediate)].join("\t"));
    NodeAssert.equal(receipt.key, sessionKey(session), "unexpected processor key/order");
    NodeAssert.equal(receipt.holderID, holderID(history), "unexpected processor history handle");
    NodeAssert.equal(receipt.immediate, immediate, "unexpected processor immediate flag");
    return receipt;
  });

  const append = (history: BoundedTerminalHistory, text: string) => {
    const id = holderID(history);
    history.append(text);
    rows.push(["A", id, hex(text)].join("\t"));
  };

  const write = Effect.fnUntraced(function* (active: Begin, expectedContent: string) {
    NodeAssert.equal(yield* Deferred.succeed(active.release, undefined), true, "already released");
    const receipt = yield* Queue.take(writes);
    NodeAssert.strictEqual(receipt.begin, active, "write belongs to another processor");
    rows.push(["W", hex(receipt.content)].join("\t"));
    NodeAssert.equal(receipt.content, expectedContent, "unexpected late history sample");
  });

  const drain = Effect.fnUntraced(function* (session: Session) {
    yield* worker.drainKey(sessionKey(session));
    rows.push(["D", hex(session[0]), hex(session[1])].join("\t"));
  });

  // Each scenario drains every enqueued key before this one-shot receipt check.
  const assertEmpty = Effect.gen(function* () {
    NodeAssert.equal(yield* Queue.size(begins), 0, "unconsumed begin receipt");
    NodeAssert.equal(yield* Queue.size(writes), 0, "unconsumed write receipt");
  });

  return { history, enqueue, begin, append, write, drain, assertEmpty };
});

type Trace = Effect.Success<ReturnType<typeof makeTrace>>;

const cases = [
  {
    name: "active-followup-before-other-key",
    run: Effect.fnUntraced(function* (trace: Trace) {
      const old = trace.history("old", "active\n");
      const queued = trace.history("queued", "other key\n");
      const next = trace.history("next", "follow-up\n");
      yield* trace.enqueue(primary, old, false);
      const active = yield* trace.begin(primary, old, false);
      yield* trace.enqueue(other, queued, false);
      yield* trace.enqueue(primary, next, false);
      yield* trace.write(active, "active\n");
      const followup = yield* trace.begin(primary, next, false);
      yield* trace.write(followup, "follow-up\n");
      yield* trace.drain(primary);
      const otherActive = yield* trace.begin(other, queued, false);
      yield* trace.write(otherActive, "other key\n");
      yield* trace.drain(other);
    }),
  },
  {
    name: "pending-immediate-or-latest-history",
    run: Effect.fnUntraced(function* (trace: Trace) {
      const blocker = trace.history("blocker", "blocker\n");
      const first = trace.history("first", "discard first\n");
      const middle = trace.history("middle", "discard middle\n");
      const latest = trace.history("latest", "latest only\n");
      yield* trace.enqueue(other, blocker, false);
      const blocked = yield* trace.begin(other, blocker, false);
      // The single consumer cannot take primary until all three enqueues finish.
      yield* trace.enqueue(primary, first, false);
      yield* trace.enqueue(primary, middle, true);
      yield* trace.enqueue(primary, latest, false);
      yield* trace.write(blocked, "blocker\n");
      yield* trace.drain(other);
      const coalesced = yield* trace.begin(primary, latest, true);
      yield* trace.write(coalesced, "latest only\n");
      yield* trace.drain(primary);
    }),
  },
  {
    name: "active-immediate-not-inherited-by-followup",
    run: Effect.fnUntraced(function* (trace: Trace) {
      const old = trace.history("old", "immediate active\n");
      const next = trace.history("next", "non-immediate follow-up\n");
      yield* trace.enqueue(primary, old, true);
      const active = yield* trace.begin(primary, old, true);
      yield* trace.enqueue(primary, next, false);
      yield* trace.write(active, "immediate active\n");
      const followup = yield* trace.begin(primary, next, false);
      yield* trace.write(followup, "non-immediate follow-up\n");
      yield* trace.drain(primary);
    }),
  },
  {
    name: "active-request-not-replaced",
    run: Effect.fnUntraced(function* (trace: Trace) {
      const old = trace.history("old", "old");
      const next = trace.history("next", "new");
      yield* trace.enqueue(primary, old, false);
      const active = yield* trace.begin(primary, old, false);
      yield* trace.enqueue(primary, next, true);
      trace.append(old, " active\n");
      trace.append(next, " pending\n");
      yield* trace.write(active, "old active\n");
      const followup = yield* trace.begin(primary, next, true);
      yield* trace.write(followup, "new pending\n");
      yield* trace.drain(primary);
    }),
  },
  {
    name: "mutable-history-sampled-late",
    run: Effect.fnUntraced(function* (trace: Trace) {
      const session: Session = ["thread-é", "terminal-名"];
      const holder = trace.history("shared", "initial");
      yield* trace.enqueue(session, holder, false);
      const active = yield* trace.begin(session, holder, false);
      trace.append(holder, "\tcafé\n");
      trace.append(holder, "名\n");
      yield* trace.write(active, "initial\tcafé\n名\n");
      yield* trace.drain(session);
    }),
  },
  {
    name: "independent-idle-drain",
    run: Effect.fnUntraced(function* (trace: Trace) {
      const holder = trace.history("active", "still active\n");
      yield* trace.enqueue(primary, holder, false);
      const active = yield* trace.begin(primary, holder, false);
      // This drain must return while primary's processor is still gated.
      yield* trace.drain(["thread-b", "terminal-1"]);
      yield* trace.write(active, "still active\n");
      yield* trace.drain(primary);
    }),
  },
];

const run = Effect.gen(function* () {
  NodeAssert.equal(new Set(cases.map(({ name }) => name)).size, cases.length, "duplicate cases");
  const rows: string[] = [];
  for (const scenario of cases) {
    rows.push(["C", scenario.name].join("\t"));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* makeTrace(rows);
        yield* scenario.run(trace);
        yield* trace.assertEmpty;
      }),
    );
    rows.push("X");
  }
  return rows;
});

// Top-level await also makes an unresolved receipt a failed Node run, not silent success.
try {
  const rows = await Effect.runPromise(run);
  process.stderr.write(
    `terminal persist worker trace: ${cases.length} cases, ${rows.length} events\n`,
  );
  process.stdout.write(`${rows.join("\n")}\n`);
} catch (cause) {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
}
