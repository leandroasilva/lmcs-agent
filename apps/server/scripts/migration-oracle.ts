// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@lmcstools/core";
import * as NodeSqliteClient from "@lmcstools/core/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { createEmptyReadModel, projectEvent } from "../src/orchestration/projector.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import { OrchestrationCommandReceiptRepository } from "../src/persistence/Services/OrchestrationCommandReceipts.ts";
import { RepositoryIdentityResolver } from "../src/project/RepositoryIdentityResolver.ts";

const instant = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("oracle-project");
const threadId = ThreadId.make("oracle-thread");
const createProject = {
  type: "project.create",
  commandId: CommandId.make("create-project"),
  projectId,
  title: "Synthetic project",
  workspaceRoot: "/synthetic/workspace",
  createdAt: instant,
} as const satisfies OrchestrationCommand;
const commands = [
  createProject,
  {
    type: "thread.create",
    commandId: CommandId.make("create-thread"),
    threadId,
    projectId,
    title: "Synthetic thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: instant,
  },
  {
    type: "thread.message.user.append",
    commandId: CommandId.make("user-message"),
    threadId,
    message: { messageId: MessageId.make("user-message"), text: "Hello", attachments: [] },
    createdAt: instant,
  },
  {
    type: "thread.message.assistant.delta",
    commandId: CommandId.make("provider:assistant-delta"),
    threadId,
    messageId: MessageId.make("assistant-message"),
    delta: "Hello back",
    createdAt: instant,
  },
  {
    type: "thread.message.assistant.complete",
    commandId: CommandId.make("provider:assistant-complete"),
    threadId,
    messageId: MessageId.make("assistant-message"),
    createdAt: instant,
  },
  {
    type: "thread.meta.update",
    commandId: CommandId.make("rename-thread"),
    threadId,
    title: "Renamed thread",
  },
  { type: "thread.archive", commandId: CommandId.make("archive-thread"), threadId },
  { type: "thread.unarchive", commandId: CommandId.make("unarchive-thread"), threadId },
] as const satisfies ReadonlyArray<OrchestrationCommand>;
const duplicate = { ...createProject, commandId: CommandId.make("duplicate-project") };

function orchestrationLayer(directory: string, databasePath: string) {
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(makeSqlitePersistenceLive(databasePath)),
    Layer.provide(ServerConfig.layerTest(directory, directory)),
    Layer.provide(NodeServices.layer),
  );
}

const measure = Effect.fnUntraced(function* <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
) {
  const start = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const value = yield* effect;
  return {
    value,
    measurement: {
      operation,
      elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
      cpuMicros: process.cpuUsage(cpu),
      rssDeltaBytes: process.memoryUsage().rss - memory.rss,
      heapUsedDeltaBytes: process.memoryUsage().heapUsed - memory.heapUsed,
    },
  };
});

const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const persistence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migrations = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  const schema = yield* sql`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;
  return {
    migrationCount: migrations.length,
    latestMigration: migrations.at(-1),
    migrationManifestSha256: hash(migrations),
    schemaSha256: hash(schema),
    userVersion: yield* sql`PRAGMA user_version`,
    journalMode: yield* sql`PRAGMA journal_mode`,
  };
});

const readState = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const repository = yield* OrchestrationCommandReceiptRepository;
  const sql = yield* SqlClient.SqlClient;
  const replayed = yield* measure(
    "read all events + pure projector replay",
    Effect.gen(function* () {
      const events = yield* Stream.runCollect(engine.readEvents(0, Number.MAX_SAFE_INTEGER));
      let replay = createEmptyReadModel(instant);
      for (const event of events) replay = yield* projectEvent(replay, event);
      return { events, replay };
    }),
  );
  const snapshot = yield* measure("SQL projection snapshot query", query.getSnapshot());
  const ids = yield* sql<{ commandId: string }>`
    SELECT command_id AS commandId FROM orchestration_command_receipts ORDER BY command_id`;
  const receipts = yield* Effect.forEach(ids, ({ commandId }) =>
    repository
      .getByCommandId({
        commandId: CommandId.make(commandId),
      })
      .pipe(Effect.map(Option.getOrThrow)),
  );
  return {
    state: {
      ...replayed.value,
      snapshot: snapshot.value,
      receipts,
      latestSequence: yield* engine.latestSequence,
      storedEnvelopes:
        yield* sql`SELECT sequence, stream_version, actor_kind FROM orchestration_events ORDER BY sequence`,
      persistence: yield* persistence,
    },
    measurements: [replayed.measurement, snapshot.measurement],
  };
});

const rejected = OrchestrationEngineService.pipe(
  Effect.flatMap((engine) => engine.dispatch(duplicate)),
  Effect.map(() => NodeAssert.fail("Duplicate project unexpectedly accepted")),
  Effect.catch((error) => Effect.succeed({ tag: error._tag, message: error.message })),
);

// Each invocation owns a fresh scope: the worker and SQLite connection close before reopening.
const session = Effect.fnUntraced(function* (
  directory: string,
  databasePath: string,
  initialize: boolean,
) {
  const startup = yield* measure(
    initialize
      ? "cold orchestration-layer startup (includes migrations)"
      : "reopen orchestration-layer startup",
    Layer.build(orchestrationLayer(directory, databasePath)),
  );
  const result = yield* Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const accepted = [];
    if (initialize) {
      for (const command of commands) accepted.push(yield* engine.dispatch(command));
    }
    // dispatch waits for the durable receipt, projection transaction and deferred cleanup.
    const acceptedRetry = yield* engine.dispatch(createProject);
    const rejectedInitial = yield* rejected;
    const rejectedRetry = yield* rejected;
    return { ...(yield* readState), accepted, acceptedRetry, rejectedInitial, rejectedRetry };
  }).pipe(Effect.provide(startup.value));
  return { ...result, measurements: [startup.measurement, ...result.measurements] };
}, Effect.scoped);

const legacySelection = {
  provider: "claudeAgent",
  model: "claude-opus-4-6",
  options: { effort: "max", thinking: false },
};
const legacyEvents = [
  {
    eventId: "legacy-project-event",
    aggregateKind: "project",
    aggregateId: "legacy-project",
    type: "project.created",
    commandId: "legacy-create-project",
    causationEventId: null,
    payload: {
      projectId: "legacy-project",
      title: "Legacy project",
      workspaceRoot: "/synthetic/legacy",
      defaultModelSelection: null,
      scripts: [],
      createdAt: instant,
      updatedAt: instant,
    },
  },
  {
    eventId: "legacy-thread-event",
    aggregateKind: "thread",
    aggregateId: "legacy-thread",
    type: "thread.created",
    commandId: "legacy-create-thread",
    causationEventId: "legacy-project-event",
    payload: {
      projectId: "legacy-project",
      threadId: "legacy-thread",
      title: "Legacy thread",
      modelSelection: legacySelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "legacy-branch",
      worktreePath: null,
      createdAt: instant,
      updatedAt: instant,
    },
  },
] as const;

const legacyRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    projects:
      yield* sql`SELECT project_id, title, workspace_root, created_at, updated_at FROM projection_projects`,
    threads:
      yield* sql`SELECT thread_id, project_id, title, branch, model_selection_json, created_at, updated_at FROM projection_threads`,
    events: yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
    receipts: yield* sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
  };
});

const upgrade = Effect.fnUntraced(function* (directory: string, databasePath: string) {
  const migrated = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const initialMigrations = yield* runMigrations({ toMigrationInclusive: 25 });
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('legacy-project', 'Legacy project', '/synthetic/legacy', '[]', ${instant}, ${instant})`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, branch, model_selection_json, created_at, updated_at, runtime_mode, interaction_mode)
      VALUES ('legacy-thread', 'legacy-project', 'Legacy thread', 'legacy-branch', ${JSON.stringify(legacySelection)},
        ${instant}, ${instant}, 'full-access', 'default')`;
    for (const event of legacyEvents) {
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id,
          causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
        VALUES (${event.eventId}, ${event.aggregateKind}, ${event.aggregateId}, 0, ${event.type}, ${instant},
          ${event.commandId}, ${event.causationEventId}, 'legacy-correlation', 'client', ${JSON.stringify(event.payload)}, '{}')`;
    }
    yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
      VALUES ('legacy-create-project', 'project', 'legacy-project', ${instant}, 1, 'accepted', NULL),
        ('legacy-create-thread', 'thread', 'legacy-thread', ${instant}, 2, 'accepted', NULL)`;
    const before = yield* legacyRows;
    const applied = yield* runMigrations();
    const after = yield* legacyRows;
    const schema = yield* persistence;
    const repeated = yield* runMigrations();
    NodeAssert.deepStrictEqual(repeated, []);
    NodeAssert.deepStrictEqual(yield* legacyRows, after);
    NodeAssert.deepStrictEqual(yield* persistence, schema);
    return { fromMigration: initialMigrations.at(-1)?.[0], before, after, applied, repeated };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
  const read = readState.pipe(Effect.provide(orchestrationLayer(directory, databasePath)));
  const first = yield* read;
  const reopened = yield* read;
  NodeAssert.deepStrictEqual(first.state, reopened.state);
  return { ...migrated, ...first.state, reopenStable: true };
});

function normalizeEvents(events: ReadonlyArray<OrchestrationEvent>) {
  const ids = new Map<string, string>(
    events.map((event) => [event.eventId, `event-${event.sequence}`]),
  );
  return events.map((event) => ({
    ...event,
    eventId: ids.get(event.eventId),
    causationEventId:
      event.causationEventId === null
        ? null
        : (ids.get(event.causationEventId) ?? event.causationEventId),
    correlationId:
      event.correlationId === null ? null : (ids.get(event.correlationId) ?? event.correlationId),
  }));
}

/** Synthetic Node/Effect baseline. No options accept an existing database or home directory. */
export const runMigrationOracle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "lmcs-migration-oracle-" });
  const liveClock = yield* Clock.Clock;
  const fixedMillis = Date.parse(instant);
  const clock = {
    ...liveClock,
    currentTimeMillisUnsafe: () => fixedMillis,
    currentTimeMillis: Effect.succeed(fixedMillis),
    currentTimeNanosUnsafe: () => BigInt(fixedMillis) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(fixedMillis) * 1_000_000n),
  } satisfies Clock.Clock;
  return yield* Effect.gen(function* () {
    const databasePath = path.join(directory, "current.sqlite");
    const first = yield* session(directory, databasePath, true);
    const reopened = yield* session(directory, databasePath, false);
    NodeAssert.deepStrictEqual(reopened.state, first.state);
    NodeAssert.deepStrictEqual(reopened.acceptedRetry, first.acceptedRetry);
    NodeAssert.deepStrictEqual(reopened.rejectedInitial, first.rejectedRetry);
    NodeAssert.deepStrictEqual(reopened.rejectedRetry, first.rejectedRetry);
    const legacy = yield* upgrade(directory, path.join(directory, "legacy.sqlite"));
    NodeAssert.deepStrictEqual(legacy.persistence, first.state.persistence);
    return {
      oracle: {
        formatVersion: 1,
        rules: {
          clock: `Effect wall clock fixed at ${instant}; real monotonic clock retained`,
          eventIds:
            "Fresh-workflow eventId UUIDs map to event-<sequence>; matching causationEventId/correlationId references use the same map. Legacy IDs and command IDs are unchanged.",
          hashes:
            "SHA-256 of JSON.stringify SQL rows in query column order: migrations ordered by migration_id (id/name only); sqlite_master non-sqlite_% objects ordered by type/name (type/name/tbl_name/sql). Migration timestamps excluded.",
          projections:
            "SQL snapshot and pure event replay are reported independently without field normalization.",
        },
        commands,
        duplicateCommand: duplicate,
        ...first.state,
        events: normalizeEvents(first.state.events),
        dispatch: {
          accepted: first.accepted,
          acceptedRetry: first.acceptedRetry,
          rejectedInitial: first.rejectedInitial,
          rejectedRetry: first.rejectedRetry,
        },
        reopenStable: true,
        legacy,
      },
      measurements: {
        classification:
          "Exploratory, single-process samples; NOT full server startup; no thresholds or speedup claims. Imports/process startup excluded; process-wide CPU/memory deltas include GC and concurrent work.",
        samples: [...first.measurements, ...reopened.measurements],
      },
    };
  }).pipe(Effect.provideService(Clock.Clock, clock));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
