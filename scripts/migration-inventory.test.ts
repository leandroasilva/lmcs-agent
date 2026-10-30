import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import { EnvironmentHttpApi } from "../packages/core/src/contracts/environmentHttp.ts";
import { WsRpcGroup, WS_METHODS } from "../packages/core/src/contracts/rpc.ts";
import * as Channels from "../apps/desktop/src/ipc/channels.ts";
import { RPC_REQUIRED_SCOPES } from "../apps/server/src/auth/RpcAuthorization.ts";
import { buildMigrationInventory } from "./migration-inventory.ts";
import {
  classifyMigrationInventory,
  migrationContractClassifications,
} from "./migration-coverage.ts";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const inventory = buildMigrationInventory(root);
const rpcPath = "packages/core/src/contracts/rpc.ts";
const schemaPath = "packages/core/src/contracts/schema.ts";
const sorted = (values: Iterable<string>) => [...values].sort();

it("keeps reviewed schema gaps linked to unchanged evidence without waiving parity", async () => {
  const result = await inventory;
  const classified = classifyMigrationInventory(result, migrationContractClassifications);
  assert.deepEqual(classified.reviewIssues, []);
  const schemaGaps = result.issues.filter((issue) =>
    ["raw-http-schema-not-declared", "ipc-schema-not-declared"].includes(issue.code),
  );
  assert.lengthOf(classified.pendingParity, schemaGaps.length);
  assert.isTrue(classified.pendingParity.every((entry) => entry.status === "not-run"));
  assert.isFalse(classified.unresolved.some((issue) => schemaGaps.includes(issue)));
  assert.equal(result.issues.length, classified.entries.length);
});

it("matches the runtime RPC map, streams, and exported channel strings without loading handlers", async () => {
  const result = await inventory;
  assert.deepEqual(
    result.rpc.map((entry) => entry.tag),
    sorted(WsRpcGroup.requests.keys()),
  );
  for (const entry of result.rpc) {
    const request = WsRpcGroup.requests.get(entry.tag)!;
    assert.equal(
      entry.mode,
      RpcSchema.isStreamSchema(request.successSchema) ? "stream" : "unary",
      entry.tag,
    );
    assert.isNotNull(entry.schemas.payload);
    assert.isNotNull(entry.schemas.error);
  }
  assert.deepEqual(
    sorted(result.desktopIpc.map((entry) => entry.channel!)),
    sorted(
      Object.entries(Channels)
        .filter(([name]) => name.endsWith("_CHANNEL"))
        .map(([, channel]) => channel),
    ),
  );
  assert.isFalse(
    result.desktopIpc.some((entry) => entry.symbol === "SSH_PASSWORD_PROMPT_CANCELLED_RESULT"),
  );
  assert.deepEqual(
    sorted(result.unregisteredWsMethods.map((entry) => entry.tag)),
    sorted(Object.values(WS_METHODS).filter((tag) => !WsRpcGroup.requests.has(tag))),
  );
  assert.deepEqual(
    result.issues
      .filter((entry) => entry.code === "missing-rpc-scope")
      .map((entry) => entry.subject),
    sorted(
      [...WsRpcGroup.requests.keys()].filter((tag) => !Object.hasOwn(RPC_REQUIRED_SCOPES, tag)),
    ),
  );
  const dynamic = result.rpc.find((entry) => entry.tag === "device.list")!.scope;
  assert.equal(dynamic.value, "orchestration:read");
  assert.include(dynamic.dynamic!.expression, "input.retryHostId || input.updateTool");
  assert.include(dynamic.dynamic!.expression, "AuthOrchestrationOperateScope");
});

it("retains unregistered project declarations and scopes their reference evidence", async () => {
  const result = await inventory;
  assert.deepEqual(
    result.unregisteredWsMethods.map((entry) => entry.tag),
    ["projects.list", "projects.add", "projects.remove"],
  );
  for (const entry of result.unregisteredWsMethods) {
    assert.equal(entry.registration, "not-a-member-of-WsRpcGroup");
    assert.deepEqual(entry.referenceCandidates, []);
    assert.match(entry.declarationFingerprint, /^[a-f0-9]{64}$/);
    assert.isTrue(
      result.issues.some(
        (issue) => issue.code === "declared-unregistered-ws-method" && issue.subject === entry.tag,
      ),
    );
  }
  for (const path of ["packages/client/src", "apps/web/src", "apps/mobile/src"]) {
    assert.include(result.unregisteredMethodEvidence.scannedRoots, path);
    assert.isTrue(
      result.unregisteredMethodEvidence.additionalSources.some((source) =>
        source.file.startsWith(`${path}/`),
      ),
    );
  }
  assert.include(
    result.unregisteredMethodEvidence.interpretation,
    "not resolved consumers or proof of dead code",
  );
});

it("matches typed HTTP membership and retains raw routes and the separate OAuth listener", async () => {
  const result = await inventory;
  const expected = Object.values(EnvironmentHttpApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map(
      (endpoint) =>
        `${group.identifier}:${endpoint.identifier}:${endpoint.method}:${endpoint.path}`,
    ),
  );
  assert.deepEqual(
    sorted(
      result.http.typed.map(
        (entry) => `${entry.group}:${entry.name}:${entry.method}:${entry.path}`,
      ),
    ),
    sorted(expected),
  );
  const snapshot = result.http.typed.find((entry) => entry.name === "threadSnapshot")!;
  assert.equal(snapshot.schemas.params!.expression, "EnvironmentOrchestrationThreadSnapshotParams");
  assert.equal(snapshot.schemas.payload!.expression, "EnvironmentOrchestrationThreadSnapshotQuery");
  assert.equal(snapshot.middlewares[0]!.expression, "EnvironmentAuthenticatedAuth");
  assert.deepEqual(
    sorted(
      result.http.raw
        .filter((entry) => entry.listener === "environment")
        .map((entry) => `${entry.method} ${entry.path}`),
    ),
    [
      "* /api/device-hub/*",
      "GET *",
      "GET /api/assets/*",
      "GET /api/devices",
      "GET /api/devices/:deviceId",
      "GET /api/devices/by-token/:token",
      "GET /ws",
      "POST /api/attachments/upload/*",
      "POST /api/devices",
      "POST /api/observability/v1/traces",
    ].sort(),
  );
  assert.deepEqual(
    result.http.raw
      .filter((entry) => entry.listener === "oauth-loopback")
      .map((entry) => entry.path),
    ["/callback"],
  );
  assert.isAbove(result.registrationEvidence.rpc.length, 0);
  assert.isAbove(result.registrationEvidence.http.length, 0);
  assert.isFalse(result.evidencePolicy.runtimeVerified);
});

it("extracts helper-based IPC signatures and does not mistake sync payload omission for missing metadata", async () => {
  const result = await inventory;
  const back = result.desktopIpc.find((entry) => entry.symbol === "PREVIEW_GO_BACK_CHANNEL")!;
  assert.equal(back.factories.length, 1);
  assert.equal(back.factories[0]!.helper!.symbol, "tabMethod");
  assert.equal(back.factories[0]!.source.symbol, "goBack");
  assert.equal(back.factories[0]!.schemas.payload!.expression, "DesktopPreviewTabInputSchema");
  assert.equal(back.factories[0]!.mode, "invoke");
  const branding = result.desktopIpc.find((entry) => entry.symbol === "GET_APP_BRANDING_CHANNEL")!;
  assert.equal(branding.factories[0]!.mode, "sync");
  assert.isNull(branding.factories[0]!.schemas.payload);
  assert.isFalse(
    result.issues.some((entry) =>
      ["unresolved-ipc-factory-channel", "missing-ipc-schema"].includes(entry.code),
    ),
  );
  const menu = result.desktopIpc.find((entry) => entry.symbol === "MENU_ACTION_CHANNEL")!;
  assert.include(menu.modes, "event");
  assert.isTrue(
    menu.usages.some((usage) => usage.source.file === "apps/desktop/src/window/DesktopWindow.ts"),
  );
});

it("is deterministic, JSON-compatible, and contains no host-specific paths", async () => {
  const first = await inventory;
  const second = await buildMigrationInventory(root);
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.formatVersion, 1);
  assert.notInclude(JSON.stringify(first), root);
  assert.isTrue(
    first.sources.every(
      (entry) => !entry.file.startsWith("/") && /^[a-f0-9]{64}$/.test(entry.fingerprint),
    ),
  );
});

const fixtureFiles: Record<string, string> = {
  [schemaPath]: "export const Input = Schema.Struct({ field: Schema.String });",
  [rpcPath]: `
    import { Input as Payload } from "./schema.ts";
    throw new Error("Inventory must never execute this module");
    export const WS_METHODS = { one: "one", two: "two", orphanMethod: "orphan" } as const;
    const one = Rpc.make(WS_METHODS.one, { payload: Payload, success: Schema.String });
    const two = Rpc.make(WS_METHODS.two, { payload: MissingSchema, stream: true });
    const orphan = Rpc.make(WS_METHODS.orphanMethod, {});
    // Rpc.make("comment", {}); HttpRouter.add("GET", "/comment", handler);
    const decoy = 'Rpc.make("string", {})';
    export const WsRpcGroup = RpcGroup.make(one, two, MissingRpc);
  `,
  "apps/server/src/auth/RpcAuthorization.ts": `
    export const RPC_REQUIRED_SCOPES = { one: "read" } as const;
    export const requiredScopeForDeviceList = (input) => input.retry ? "operate" : "read";
  `,
  "packages/core/src/contracts/environmentHttp.ts": `
    class Unused extends HttpApiGroup.make("unused").add(HttpApiEndpoint.get("unused", "/unused")) {}
    class Group extends HttpApiGroup.make("live")
      .add(HttpApiEndpoint.get("first", "/first", { query: Schema.Struct({ q: Schema.String }) }))
      .add(HttpApiEndpoint.get("second", "/second", { success: Schema.String })) {}
    export class EnvironmentHttpApi extends HttpApi.make("environment").add(Group) {}
  `,
  "apps/server/src/nested/routes.ts": `
    const prefix = "/raw";
    export const first = HttpRouter.add("GET", \`\${prefix}/first\`, handler);
    export const second = HttpRouter.add("GET", \`\${prefix}/second\`, handler);
    export const unresolved = HttpRouter.add("POST", dynamicPath(), handler);
  `,
  "apps/desktop/src/ipc/channels.ts": `
    export const CALL_CHANNEL = "call";
    export const EVENT_CHANNEL = "event";
    export const UNUSED_CHANNEL = "unused";
    export const UNKNOWN_CHANNEL = unknownChannel();
    export const CANCELLED_RESULT = "not-a-channel";
    const PRIVATE_CHANNEL = "private";
  `,
  "apps/desktop/src/ipc/methods/helper.ts": `
    import * as IpcChannels from "../channels.ts";
    const tabMethod = (channel) => DesktopIpc.makeIpcMethod({ channel, payload: Schema.String, result: Schema.Void });
    export const run = tabMethod(IpcChannels.CALL_CHANNEL);
    window.webContents.send(IpcChannels.EVENT_CHANNEL, event);
    DesktopIpc.makeIpcMethod({ channel: UnknownChannel, payload: Schema.Void });
  `,
  "apps/server/src/poison.test.ts": 'HttpRouter.add("GET", "/test", handler);',
  "apps/server/src/nested/tests/poison.ts": 'HttpRouter.add("GET", "/test-directory", handler);',
  "apps/server/src/build/poison.ts": 'HttpRouter.add("GET", "/build", handler);',
  "packages/client/src/usage.ts": `
    throw new Error("Reference scanning must never execute client code");
    const { orphanMethod: alias } = WS_METHODS;
    const methods = WS_METHODS;
    send(methods["orphanMethod"]);
    send("orphan");
    send("orphan-extra");
    // WS_METHODS.orphanMethod and "orphan" are not references here.
    const text = "WS_METHODS.orphanMethod";
  `,
  "apps/web/src/usage.tsx": `
    const orphanMethod = "unrelated-local-name";
    const view = <div>{WS_METHODS.orphanMethod}</div>;
    HttpRouter.add("GET", "/not-a-server-route", handler);
  `,
  "apps/mobile/src/usage.ts": "send(`orphan`);",
  "apps/mobile/src/ignored.test.ts": 'send("orphan");',
};

async function withFixture(run: (directory: string) => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "migration-inventory-"));
  try {
    for (const [path, contents] of Object.entries(fixtureFiles)) {
      const absolute = NodePath.join(directory, path);
      await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
      await NodeFSP.writeFile(absolute, contents);
    }
    await run(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

it("uses AST membership, preserves same-method routes, and reports unresolved source metadata", async () => {
  await withFixture(async (directory) => {
    const result = await buildMigrationInventory(directory);
    assert.deepEqual(
      result.rpc.map((entry) => entry.tag),
      ["one", "two"],
    );
    assert.deepEqual(
      result.http.typed.map((entry) => entry.path),
      ["/first", "/second"],
    );
    assert.deepEqual(
      result.http.raw.map((entry) => entry.path),
      ["/raw/first", "/raw/second", null],
    );
    assert.isFalse(result.sources.some((entry) => entry.file.includes("poison")));
    assert.deepEqual(
      result.desktopIpc.map((entry) => entry.channel),
      ["call", "event", "unused", null],
    );
    assert.equal(result.desktopIpc[0]!.factories[0]!.helper!.symbol, "tabMethod");
    for (const code of [
      "missing-rpc-scope",
      "unresolved-rpc-member",
      "unresolved-schema",
      "unresolved-raw-route",
      "unclassified-ipc-channel",
      "unresolved-ipc-channel",
      "unresolved-ipc-factory-channel",
      "declared-unregistered-ws-method",
    ]) {
      assert.isTrue(
        result.issues.some((entry) => entry.code === code),
        code,
      );
    }
    assert.include(result.http.raw[0]!.registration.status, "mounting-unverified");
    assert.equal(result.rpc[0]!.schemas.payload!.references[0]!.file, schemaPath);
  });
});

it("fingerprints schema changes even when tags and schema reference names stay unchanged", async () => {
  await withFixture(async (directory) => {
    const before = await buildMigrationInventory(directory);
    const file = NodePath.join(directory, schemaPath);
    const original = await NodeFSP.readFile(file, "utf8");
    await NodeFSP.writeFile(file, original.replace("Schema.String", "Schema.Number"));
    const after = await buildMigrationInventory(directory);
    assert.deepEqual(
      before.rpc.map((entry) => entry.tag),
      after.rpc.map((entry) => entry.tag),
    );
    assert.notDeepEqual(
      before.rpc[0]!.schemas.payload!.references,
      after.rpc[0]!.schemas.payload!.references,
    );
    assert.notEqual(
      before.sources.find((entry) => entry.file === schemaPath)!.fingerprint,
      after.sources.find((entry) => entry.file === schemaPath)!.fingerprint,
    );
  });
});

it("records AST reference candidates across clients without treating names as resolved consumers", async () => {
  await withFixture(async (directory) => {
    const result = await buildMigrationInventory(directory);
    const method = result.unregisteredWsMethods.find((entry) => entry.tag === "orphan")!;
    const candidates = method.referenceCandidates;
    assert.equal(method.registration, "not-a-member-of-WsRpcGroup");
    assert.deepEqual(
      candidates
        .filter((entry) => entry.source.file === rpcPath)
        .map((entry) => entry.source.symbol),
      ["orphan"],
    );
    assert.deepEqual(
      candidates
        .filter((entry) => entry.source.file === "packages/client/src/usage.ts")
        .map((entry) => [entry.match, entry.syntax]),
      [
        ["symbol-name", "identifier"],
        ["symbol-name", "string-literal"],
        ["wire-tag", "string-literal"],
      ],
    );
    assert.lengthOf(
      candidates.filter((entry) => entry.source.file === "apps/web/src/usage.tsx"),
      2,
    );
    assert.lengthOf(
      candidates.filter((entry) => entry.source.file === "apps/mobile/src/usage.ts"),
      1,
    );
    assert.lengthOf(candidates, 7);
    assert.isTrue(
      candidates.every(
        (entry) =>
          entry.source.line > 0 &&
          entry.source.column > 0 &&
          /^[a-f0-9]{64}$/.test(entry.source.fingerprint),
      ),
    );
    assert.isFalse(result.http.raw.some((entry) => entry.path === "/not-a-server-route"));
    assert.isFalse(result.sources.some((entry) => entry.file.includes("/usage.")));
    assert.lengthOf(result.unregisteredMethodEvidence.additionalSources, 3);
    assert.isFalse(
      result.unregisteredMethodEvidence.additionalSources.some((entry) =>
        entry.file.includes("ignored.test"),
      ),
    );
  });
});

it("detects new client reference candidates without changing server contract evidence", async () => {
  await withFixture(async (directory) => {
    const before = await buildMigrationInventory(directory);
    const path = "apps/mobile/src/usage.ts";
    await NodeFSP.writeFile(
      NodePath.join(directory, path),
      'send(WS_METHODS.orphanMethod); send("orphan");',
    );
    const after = await buildMigrationInventory(directory);
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.rpc, before.rpc);
    assert.notDeepEqual(
      after.unregisteredWsMethods[0]!.referenceCandidates,
      before.unregisteredWsMethods[0]!.referenceCandidates,
    );
    assert.notEqual(
      after.unregisteredMethodEvidence.additionalSources.find((source) => source.file === path)!
        .fingerprint,
      before.unregisteredMethodEvidence.additionalSources.find((source) => source.file === path)!
        .fingerprint,
    );
    assert.isTrue(
      after.issues.some(
        (issue) => issue.code === "declared-unregistered-ws-method" && issue.subject === "orphan",
      ),
    );
  });
});

it("does not let reference-only client globals resolve missing server contracts", async () => {
  await withFixture(async (directory) => {
    const before = await buildMigrationInventory(directory);
    await NodeFSP.writeFile(
      NodePath.join(directory, "packages/client/src/usage.ts"),
      `
      const MissingRpc = Rpc.make("client-only-rpc", {});
      const MissingSchema = Schema.Struct({ fromClient: Schema.String });
    `,
    );
    const after = await buildMigrationInventory(directory);
    assert.deepEqual(after.rpc, before.rpc);
    assert.deepEqual(after.http, before.http);
    assert.deepEqual(after.desktopIpc, before.desktopIpc);
    assert.deepEqual(after.issues, before.issues);
  });
});

it("keeps reference-source parse failures visible instead of claiming an empty usage set", async () => {
  await withFixture(async (directory) => {
    const path = "apps/mobile/src/usage.ts";
    await NodeFSP.writeFile(NodePath.join(directory, path), "const broken = (");
    const result = await buildMigrationInventory(directory);
    assert.isTrue(
      result.issues.some((issue) => issue.code === "source-parse-error" && issue.subject === path),
    );
  });
});
