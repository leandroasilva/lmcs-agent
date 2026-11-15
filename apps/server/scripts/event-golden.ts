// @effect-diagnostics nodeBuiltinImport:off
/**
 * event-golden — measure what the shipped write path persists, as literal text.
 *
 * The Rust port has to produce rows that the existing database and the existing
 * clients accept, byte for byte. Every claim in `rules` was read off this
 * script's output rather than off the source, because the source is misleading
 * in three places:
 *
 * 1. `payload_json` is NOT `JSON.stringify(event.payload)`. The event store
 *    re-encodes `projectIcon` before writing (OrchestrationEventStore.ts:268),
 *    so a monogram that is `{kind:"monogram",text,color}` in memory lands as
 *    `{kind:"lucide",name:"folder-code",color,monogramText}` on disk, with a
 *    `name` value no client ever sent.
 * 2. `metadata_json` is not untyped either: it goes through
 *    `Schema.fromJsonString(OrchestrationEventMetadata)`, so undeclared keys are
 *    dropped, while `payload_json` goes through `Schema.Unknown` and keeps
 *    whatever the client sent, including keys the contracts never declared.
 * 3. `occurred_at` is usually not the client's timestamp: the transport
 *    canonicalizes `createdAt` to the server receive time before the decider
 *    sees it (Normalizer.ts:25).
 *
 * The pipeline under measurement is the production one, end to end:
 *
 *   wire JSON text
 *     → OrchestrationCommand codec      (packages/core)
 *     → normalizeDispatchCommand        (apps/server/src/orchestration/Normalizer.ts)
 *     → engine.dispatch                 (decide → append → project, one transaction)
 *     → raw TEXT columns                (SELECT payload_json, metadata_json)
 *
 * Determinism, using production seams only — nothing in the code under test is
 * patched:
 * - `Clock.Clock` is fixed at one instant, because `DateTime.now` is
 *   `Clock.currentTimeMillis` and the decider's `nowIso` reads it.
 * - `Crypto.Crypto.randomUUIDv4` is replaced by a counter, because the decider
 *   mints an id per event. The shape stays UUIDv4 (version/variant nibbles).
 * - Workspace roots live under a fresh temp directory, or are repo-relative, and
 *   every absolute path in the output is masked, so the golden is portable.
 *
 * Both overrides are provided as layers, so they reach the engine's own context
 * and not just this script's call sites.
 *
 * Run: node apps/server/scripts/event-golden.ts > /tmp/event-golden.json
 *
 * Not measured here, deliberately left for later fatias: the DB projection
 * tables, the checkpoint and provider reactors with their runtime receipts, and
 * `stream_version` behaviour under contention (dispatch is serialized by the
 * engine queue, so a single writer is all this path can exhibit).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommand,
  OrchestrationEvent,
  ThreadId,
  type OrchestrationClientOrigin,
} from "@lmcstools/core";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { normalizeDispatchCommand } from "../src/orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolver } from "../src/project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";

const instant = "2026-01-01T00:00:00.000Z";
/** A client-sent timestamp that is NOT the server instant, to expose stamping. */
const clientInstant = "2020-02-02T02:02:02.222Z";

/**
 * `<TMP>` stands for a directory this run creates. Absolute machine paths never
 * reach the output: they are masked to `<TMP>`, `<CWD>` or `<HOME>` at the end,
 * and the script fails if any other absolute path survives.
 */
type Scenario = {
  readonly name: string;
  readonly json: unknown;
  readonly probe: string;
  readonly origin?: OrchestrationClientOrigin;
};

const scenario = (
  name: string,
  json: unknown,
  probe: string,
  origin?: OrchestrationClientOrigin,
): Scenario => ({ name, json, probe, ...(origin === undefined ? {} : { origin }) });

const scenarios: ReadonlyArray<Scenario> = [
  scenario(
    "p1.create",
    {
      type: "project.create",
      commandId: "cmd-p1-create",
      projectId: "project-alpha",
      title: "Alpha",
      workspaceRoot: "<TMP>/alpha",
      // Documented as ignored by the server; must not reach the payload.
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
      createdAt: clientInstant,
    },
    "which command fields reach payload_json, and whose timestamp wins",
  ),
  scenario(
    "p1.meta.title",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-title",
      projectId: "project-alpha",
      title: "Alpha renamed",
    },
    "partial update: absent keys must not appear, updatedAt must be last",
  ),
  scenario(
    "p1.meta.iconMonogram",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-icon-monogram",
      projectId: "project-alpha",
      projectIcon: { kind: "monogram", text: "AB", color: "blue" },
    },
    "the encode-before-write case: a monogram lands as lucide+monogramText",
  ),
  scenario(
    "p1.meta.iconWireMonogram",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-icon-wire",
      projectId: "project-alpha",
      projectIcon: { kind: "lucide", name: "folder-open", color: "teal", monogram: "XY" },
    },
    "legacy wire key `monogram` decodes to a monogram and re-encodes as `monogramText`",
  ),
  scenario(
    "p1.meta.iconEmoji",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-icon-emoji",
      projectId: "project-alpha",
      projectIcon: { kind: "emoji", emoji: "🦀" },
    },
    "non-monogram icon: does the encode-before-write case touch it",
  ),
  scenario(
    "p1.meta.iconNull",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-icon-null",
      projectId: "project-alpha",
      projectIcon: null,
    },
    "the projectIcon special case tests truthiness, so null takes the raw path",
  ),
  scenario(
    "p1.meta.scriptsJunk",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-scripts",
      projectId: "project-alpha",
      scripts: [
        {
          id: "dev",
          name: "Dev",
          command: "vp run dev",
          icon: "build",
          runOnWorktreeCreate: false,
          // Not declared by ProjectScript.
          undeclared: "survives?",
        },
        {
          id: "ship",
          name: "Ship",
          command: "vp run ship",
          icon: "play",
          runOnWorktreeCreate: true,
          async: true,
          previewUrl: "http://127.0.0.1:3000",
        },
      ],
    },
    "payload_json is Schema.Unknown, so keys the contracts never declared may persist",
  ),
  scenario(
    "p1.meta.modelSelection",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-model",
      projectId: "project-alpha",
      defaultModelSelection: {
        options: { reasoning: "high" },
        model: "gpt-5.4",
        instanceId: "codex",
      },
    },
    "ModelSelection has a decode/encode transform: does the column follow it or the client order",
  ),
  scenario(
    "p1.meta.modelSelectionJunk",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-model-junk",
      projectId: "project-alpha",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.4", undeclared: [1, 2, 3] },
    },
    "an undeclared sibling of a transformed struct field: kept, reordered, or dropped",
  ),
  scenario(
    "p1.meta.faviconAndEnvMode",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-favicon",
      projectId: "project-alpha",
      faviconPath: "public/icon.png",
      defaultThreadEnvMode: "worktree",
      autoPull: true,
    },
    "key order of the conditional spreads in the meta.update branch",
  ),
  scenario(
    "p1.meta.empty",
    {
      type: "project.meta.update",
      commandId: "cmd-p1-empty",
      projectId: "project-alpha",
    },
    "a meta update touching nothing still emits an event; what does its payload hold",
  ),
  scenario(
    "p2.createImplicit",
    {
      type: "project.create",
      commandId: "cmd-p2-create",
      projectId: "project-beta",
      title: "Beta",
      workspaceRoot: "<TMP>/nested/deeper/beta",
      createWorkspaceRootIfMissing: true,
      createdAt: clientInstant,
    },
    "createIfMissing writes to the filesystem; the flag itself is not a payload field",
  ),
  scenario(
    "p2.createDuplicateId",
    {
      type: "project.create",
      commandId: "cmd-p2-dup",
      projectId: "project-beta",
      title: "Beta again",
      workspaceRoot: "<TMP>/beta-again",
      createdAt: clientInstant,
    },
    "invariant rejection: nothing must be written",
  ),
  scenario(
    "p3.createHome",
    {
      type: "project.create",
      commandId: "cmd-p3-create",
      projectId: "project-home",
      title: "Home",
      workspaceRoot: "~",
      createdAt: clientInstant,
    },
    "workspaceRoot normalization: ~ expansion reaches the persisted payload",
  ),
  scenario(
    "p4.createRelative",
    {
      type: "project.create",
      commandId: "cmd-p4-create",
      projectId: "project-relative",
      title: "Relative",
      workspaceRoot: "apps",
      createdAt: clientInstant,
    },
    "a relative root resolves against the process working directory",
  ),
  scenario(
    "p5.createPadded",
    {
      type: "project.create",
      commandId: "cmd-p5-create",
      projectId: "project-padded",
      title: "  Padded  ",
      workspaceRoot: "  <TMP>/padded  ",
      createdAt: clientInstant,
    },
    "trim happens at the codec; what survives in the column",
  ),
  scenario(
    "t1.create",
    {
      type: "thread.create",
      commandId: "cmd-t1-create",
      threadId: "thread-one",
      projectId: "project-alpha",
      title: "First thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: clientInstant,
    },
    "a second aggregate: its stream_version restarts at 0 while sequence grows globally",
  ),
  scenario(
    "t1.createHistoryImport",
    {
      type: "thread.create",
      commandId: "cmd-t1-import",
      threadId: "thread-import",
      projectId: "project-alpha",
      title: "Imported thread",
      modelSelection: { instanceId: "claude", model: "opus" },
      runtimeMode: "auto",
      interactionMode: "plan",
      branch: "feature/x",
      worktreePath: null,
      createdAt: clientInstant,
      historyImport: true,
    },
    "the one decider branch that sets event metadata, plus the engine's origin stamp",
    { surface: "desktop", appVersion: "1.2.3" },
  ),
  scenario(
    "t1.archive",
    { type: "thread.archive", commandId: "cmd-t1-archive", threadId: "thread-one" },
    "archive writes two timestamps from one clock read",
  ),
  scenario(
    "t1.unarchive",
    { type: "thread.unarchive", commandId: "cmd-t1-unarchive", threadId: "thread-one" },
    "unarchive omits archivedAt; compare against the archive payload",
  ),
  scenario(
    "t1.pinNoKey",
    { type: "thread.pin", commandId: "cmd-t1-pin", threadId: "thread-one" },
    "optional orderKey omitted by the client: absent, null, or invented",
  ),
  scenario(
    "t1.renameAndRegenerate",
    {
      type: "thread.meta.update",
      commandId: "cmd-t1-bad",
      threadId: "thread-one",
      title: "Both",
      regenerateTitle: true,
    },
    "a command-level .check filter: which text reaches the client",
  ),
  scenario(
    "t1.providerDelta",
    {
      type: "thread.message.assistant.delta",
      commandId: "provider:assistant-delta",
      threadId: "thread-one",
      messageId: "msg-assistant-1",
      delta: "Hello back",
      createdAt: clientInstant,
    },
    "actor_kind inference from a `provider:` command id prefix",
  ),
  scenario(
    "t1.serverDelta",
    {
      type: "thread.message.assistant.delta",
      commandId: "server:assistant-note",
      threadId: "thread-one",
      messageId: "msg-assistant-2",
      delta: "Server note",
      createdAt: clientInstant,
    },
    "actor_kind inference from a `server:` command id prefix",
  ),
  scenario(
    "p1.deleteWithoutForce",
    { type: "project.delete", commandId: "cmd-p1-delete-soft", projectId: "project-alpha" },
    "non-empty project rejection must leave the stream untouched",
  ),
  scenario(
    "p1.deleteForced",
    {
      type: "project.delete",
      commandId: "cmd-p1-delete-force",
      projectId: "project-alpha",
      force: true,
    },
    "one command id fanning out to N events across M aggregates",
  ),
  scenario(
    "p1.deleteReplay",
    {
      type: "project.delete",
      commandId: "cmd-p1-delete-force",
      projectId: "project-alpha",
      force: true,
    },
    "the same command id twice: receipt dedupe versus a fresh invariant rejection",
  ),
  scenario(
    "t1.missingThread",
    { type: "thread.archive", commandId: "cmd-missing-thread", threadId: "thread-ghost" },
    "rejection text for an unknown aggregate id",
  ),
];

/** A UUIDv4-shaped id from a counter, so the golden stays reproducible. */
const uuidFromCounter = (counter: number) => {
  const hex = counter.toString(16).padStart(8, "0");
  return `${hex}-${hex.slice(0, 4)}-4000-8000-${(hex + hex).slice(0, 12)}`;
};

type PersistedRow = {
  readonly sequence: number;
  readonly eventId: string;
  readonly aggregateKind: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly commandId: string | null;
  readonly causationEventId: string | null;
  readonly correlationId: string | null;
  readonly actorKind: string;
  readonly payloadJson: string;
  readonly metadataJson: string;
};

type ReceiptRow = {
  readonly commandId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly acceptedAt: string;
  readonly resultSequence: number;
  readonly status: string;
  readonly error: string | null;
};

/**
 * Pair the raw column text with the same event read back through the production
 * store. The store's row decode yields the in-memory (Type-side) shape, i.e.
 * what the decider planned, so comparing its `JSON.stringify` against the column
 * text isolates the encode-before-write step — the part of the write path a port
 * cannot see from the decider source.
 */
const planAgainstColumns = (
  rows: ReadonlyArray<PersistedRow>,
  events: ReadonlyArray<OrchestrationEvent>,
) => {
  const plannedById = new Map(events.map((event) => [event.eventId as string, event] as const));
  return rows.map((row) => {
    const event = plannedById.get(row.eventId);
    if (event === undefined) return { ...row, rowRoundTrips: false } as const;
    const plannedPayloadJson = JSON.stringify(event.payload);
    const plannedMetadataJson = JSON.stringify(event.metadata);
    return {
      ...row,
      rowRoundTrips: true,
      plannedType: event.type,
      plannedPayloadJson,
      plannedMetadataJson,
      payloadRewrittenByStorage: plannedPayloadJson !== row.payloadJson,
      metadataRewrittenByStorage: plannedMetadataJson !== row.metadataJson,
    } as const;
  });
};

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "lmcs-event-golden-" });
  const workspaceRoot = path.join(directory, "roots");
  yield* fs.makeDirectory(workspaceRoot, { recursive: true });
  // Cases that dispatch without `createWorkspaceRootIfMissing` need a real
  // directory, or they would measure the missing-root rejection instead of the
  // invariant they are about.
  for (const existing of ["alpha", "beta-again", "padded"]) {
    yield* fs.makeDirectory(path.join(workspaceRoot, existing), { recursive: true });
  }

  // Fixed clock and deterministic ids must be layers: the engine reads them from
  // its own build context, not from this call site.
  const liveCrypto = yield* Crypto.Crypto;
  let eventCounter = 0;
  // Shared with the store-level appends below, so ids minted by this script and
  // ids minted by the decider never collide.
  const nextEventId = () => EventId.make(uuidFromCounter((eventCounter += 1)));
  const cryptoLayer = Layer.succeed(Crypto.Crypto, {
    ...liveCrypto,
    randomUUIDv4: Effect.sync(() => uuidFromCounter((eventCounter += 1))),
  } satisfies Crypto.Crypto);

  const liveClock = yield* Clock.Clock;
  const fixedMillis = Date.parse(instant);
  const clockLayer = Layer.succeed(Clock.Clock, {
    ...liveClock,
    currentTimeMillis: Effect.succeed(fixedMillis),
    currentTimeMillisUnsafe: () => fixedMillis,
    currentTimeNanos: Effect.succeed(BigInt(fixedMillis) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(fixedMillis) * 1_000_000n,
  } satisfies Clock.Clock);

  const persistence = makeSqlitePersistenceLive(path.join(directory, "state.sqlite"));
  const engineLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    // Merge, not plain provide: the script reads the store directly to compare
    // planned events against persisted rows, so it must stay in the context.
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(persistence),
    // Merged because this script runs the transport's own normalization step,
    // which needs the workspace-root validator and the server config.
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(ServerConfig.layerTest(directory, directory)),
    // Merged, not merely provided: the transport normalization this script runs
    // itself reads the wall clock, so the fixed clock has to be visible above
    // the engine layer and not only inside it.
    Layer.provideMerge(cryptoLayer),
    Layer.provideMerge(clockLayer),
  );

  const body = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestrationEngineService;
    const eventStore = yield* OrchestrationEventStore;
    const decodeWire = Schema.decodeResult(OrchestrationCommand);

    const readRowsSince = (sequenceExclusive: number) =>
      sql<PersistedRow>`
        SELECT
          sequence,
          event_id AS "eventId",
          aggregate_kind AS "aggregateKind",
          stream_id AS "streamId",
          stream_version AS "streamVersion",
          event_type AS "eventType",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          actor_kind AS "actorKind",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE sequence > ${sequenceExclusive}
        ORDER BY sequence ASC
      `;

    const readReceipt = (commandId: string) =>
      sql<ReceiptRow>`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `.pipe(Effect.map((rows) => rows[0] ?? null));

    /** The same events through the store's read path, for the plan/column diff. */
    const readPlanned = (sequenceExclusive: number, count: number) =>
      count === 0
        ? Effect.succeed([] as ReadonlyArray<OrchestrationEvent>)
        : Stream.runCollect(eventStore.readFromSequence(sequenceExclusive, count)).pipe(
            Effect.map((chunk) => Array.from(chunk) as ReadonlyArray<OrchestrationEvent>),
          );

    const cases: unknown[] = [];
    let lastSequence = 0;
    let accepted = 0;
    let rejected = 0;
    let codecRejected = 0;

    for (const input of scenarios) {
      const wire = JSON.stringify(input.json).replaceAll("<TMP>", workspaceRoot);
      const before = lastSequence;
      const decoded = decodeWire(JSON.parse(wire) as never);

      if (decoded._tag === "Failure") {
        codecRejected += 1;
        const rows = yield* readRowsSince(before);
        cases.push({
          name: input.name,
          probe: input.probe,
          wire,
          outcome: "codec-rejected",
          issue: SchemaIssue.defaultFormatter(decoded.failure.issue),
          rowsWritten: rows.length,
        });
        continue;
      }

      const command = decoded.success;
      const decision = yield* normalizeDispatchCommand(command).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.succeed({
              outcome: "normalize-rejected" as const,
              error: { tag: cause._tag, message: cause.message },
            }),
          onSuccess: (normalized) =>
            engine
              .dispatch(
                normalized,
                input.origin === undefined ? undefined : { origin: input.origin },
              )
              .pipe(
                Effect.matchEffect({
                  onFailure: (cause) =>
                    readRowsSince(before).pipe(
                      Effect.map((rows) => ({
                        outcome: "rejected" as const,
                        error: { tag: cause._tag, message: cause.message },
                        rows,
                      })),
                    ),
                  onSuccess: (result) =>
                    readRowsSince(before).pipe(
                      Effect.map((rows) => ({
                        outcome: "accepted" as const,
                        dispatchResultSequence: result.sequence,
                        rows,
                      })),
                    ),
                }),
              ),
        }),
      );

      if (decision.outcome === "accepted") accepted += 1;
      else rejected += 1;

      const rows = "rows" in decision ? decision.rows : [];
      lastSequence = rows.reduce((max, row) => Math.max(max, row.sequence), lastSequence);

      cases.push({
        name: input.name,
        probe: input.probe,
        wire,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        outcome: decision.outcome,
        ...("error" in decision ? { error: decision.error } : {}),
        ...("dispatchResultSequence" in decision
          ? { dispatchResultSequence: decision.dispatchResultSequence }
          : {}),
        receipt: yield* readReceipt(command.commandId),
        rows: planAgainstColumns(rows, yield* readPlanned(before, rows.length)),
      });
    }

    // Store-level appends. `commandId: null` and provider metadata without a
    // prefixed id are unreachable through dispatch, yet `append` is the
    // production function the engine calls for every event, and a Rust writer
    // implements it, not the caller.
    type StoreInput = {
      readonly name: string;
      readonly commandId: string | null;
      readonly metadata: unknown;
      readonly probe: string;
    };
    const storeInputs: ReadonlyArray<StoreInput> = [
      {
        name: "nullCommandId",
        commandId: null,
        metadata: {},
        probe: "a null command id with no provider metadata falls back to server",
      },
      {
        name: "adapterKeyOnly",
        commandId: "cmd-client-with-adapter-key",
        metadata: { adapterKey: "codex" },
        probe: "a client command id plus provider metadata promotes to provider",
      },
      {
        name: "undeclaredMetadataKey",
        commandId: "cmd-undeclared-metadata",
        metadata: { adapterKey: "codex", undeclared: "dropped?" },
        probe: "metadata_json is schema-encoded, unlike payload_json",
      },
      {
        name: "originOrder",
        commandId: "cmd-origin-metadata",
        metadata: { origin: { appVersion: "9.9.9", surface: "web" } },
        probe: "nested metadata key order comes from the schema, not the input",
      },
    ];

    const storeLevel = yield* Effect.forEach(storeInputs, (input) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread-store-${input.name}`);
        const commandId = input.commandId === null ? null : CommandId.make(input.commandId);
        const before = yield* engine.latestSequence;
        const saved = yield* eventStore.append({
          type: "thread.message-sent",
          eventId: nextEventId(),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: instant,
          commandId,
          causationEventId: null,
          correlationId: commandId,
          // The undeclared-key case cannot be written any other way: the type
          // forbids exactly what the measurement is about.
          metadata: input.metadata as OrchestrationEvent["metadata"],
          payload: {
            threadId,
            messageId: MessageId.make(`msg-${input.name}`),
            role: "assistant",
            text: input.name,
            turnId: null,
            streaming: false,
            createdAt: instant,
            updatedAt: instant,
          },
        });
        const rows = yield* readRowsSince(before);
        return {
          name: input.name,
          probe: input.probe,
          plannedMetadataJson: JSON.stringify(input.metadata),
          savedEventId: saved.eventId,
          rows: planAgainstColumns(rows, yield* readPlanned(before, rows.length)),
        };
      }),
    );

    const latestSequence = yield* engine.latestSequence;
    const tables = yield* sql<{ name: string; sqlText: string }>`
      SELECT name, sql AS "sqlText" FROM sqlite_master
      WHERE type = 'table' AND name IN ('orchestration_events', 'orchestration_command_receipts')
      ORDER BY name
    `;
    const indexes = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index'
        AND tbl_name IN ('orchestration_events', 'orchestration_command_receipts')
      ORDER BY name
    `;
    const journalMode = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;

    return {
      formatVersion: 1,
      inputs: {
        clock: `Effect wall clock fixed at ${instant}`,
        eventIds: `UUIDv4-shaped ids from a module counter, first is ${uuidFromCounter(1)}`,
        database: "<TMP>/state.sqlite (all shipped migrations applied by the server's own runner)",
        workspaceRoots:
          "<TMP>/roots (created by this run) plus repo-relative and home-relative inputs",
      },
      schema: {
        tables: tables.map((table) => ({ name: table.name, sql: table.sqlText })),
        indexes: indexes.map((index) => index.name),
        journalMode: journalMode[0]?.journal_mode ?? null,
      },
      summary: {
        scenarios: scenarios.length,
        accepted,
        rejected,
        codecRejected,
        eventsPersisted: latestSequence,
        storeLevelAppends: storeLevel.length,
      },
      cases,
      storeLevel,
    };
  });

  return yield* body.pipe(
    Effect.provide(engineLayer),
    Effect.map((output) => ({
      // The temp root is recorded twice so a realpath'd form is masked too;
      // the sentinel check at the bottom catches any variant this misses.
      masks: [
        [workspaceRoot, "<TMP>"] as const,
        [directory, "<TMP>"] as const,
        [`/private${directory}`, "<TMP>"] as const,
        [process.cwd(), "<CWD>"] as const,
        [process.env["HOME"] ?? "", "<HOME>"] as const,
      ].filter(([value]) => value.length > 0),
      output,
    })),
  );
});

const program = main.pipe(
  // The golden is stdout; the migration runner logs at INFO, so silence the
  // runtime rather than filtering its text out of the output afterwards.
  Effect.provide(Logger.layer([])),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.orDie,
);

/** Anything that still looks like an absolute machine path after masking. */
const unmaskedPathPattern = /"(?:\/(?:private|Users|home|var|tmp|Volumes|mnt|run)\/)[^"]*"/g;

type Masked = {
  readonly masks: ReadonlyArray<readonly [string, string]>;
  readonly output: unknown;
};

Effect.runPromise(program).then(({ masks, output }: Masked) => {
  let text = JSON.stringify(output, undefined, 2);
  // Longest first, so `<TMP>/roots` cannot be half-rewritten by the shorter root.
  for (const [value, sentinel] of [...masks].sort((a, b) => b[0].length - a[0].length)) {
    text = text.replaceAll(value, sentinel);
  }
  const survivors = text.match(unmaskedPathPattern) ?? [];
  if (survivors.length > 0) {
    process.stderr.write(
      `event-golden: unmasked machine paths survived: ${survivors.slice(0, 5).join(", ")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${text}\n`);
});
