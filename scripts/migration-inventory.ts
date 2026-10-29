#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import ts from "typescript-legacy";

const roots = ["packages/core/src", "apps/server/src", "apps/desktop/src"];
const rpcFile = "packages/core/src/contracts/rpc.ts";
const httpFile = "packages/core/src/contracts/environmentHttp.ts";
const authFile = "apps/server/src/auth/RpcAuthorization.ts";
const channelsFile = "apps/desktop/src/ipc/channels.ts";
const ignored = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
]);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const text = (node: ts.Node) =>
  printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const unwrap = (node: ts.Node): ts.Node =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;
const callName = (node: ts.CallExpression) => text(node.expression);
const location = (node: ts.Node) => {
  let owner: ts.Node | undefined = node;
  while (
    owner &&
    !ts.isVariableDeclaration(owner) &&
    !ts.isFunctionDeclaration(owner) &&
    !ts.isClassDeclaration(owner)
  )
    owner = owner.parent;
  return {
    file: node.getSourceFile().fileName,
    symbol: owner?.name ? text(owner.name) : null,
    line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
  };
};
type Location = ReturnType<typeof location>;

/** Static evidence only: never imports or evaluates code from the supplied root. */
export async function buildMigrationInventory(root: string) {
  const files = new Map<string, ts.SourceFile>();
  async function collect(directory: string) {
    const entries = await NodeFSP.readdir(NodePath.resolve(root, directory), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      const path = NodePath.posix.join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (
        entry.isFile() &&
        /\.(?:[cm]?ts|tsx)$/.test(path) &&
        !/\.(?:test|spec|d)\.[cm]?tsx?$/.test(path)
      ) {
        files.set(
          path,
          ts.createSourceFile(
            path,
            await NodeFSP.readFile(NodePath.resolve(root, path), "utf8"),
            ts.ScriptTarget.Latest,
            true,
          ),
        );
      }
    }
  }
  for (const directory of roots) await collect(directory);
  // A closed compiler host gives us lexical binding and barrel/alias resolution, not execution.
  // It cannot load dependencies, configs, plugins, or files outside these source trees.
  const options = { noLib: true, allowImportingTsExtensions: true, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => files.get(name);
  host.fileExists = (name) => files.has(name);
  host.readFile = (name) => files.get(name)?.text;
  host.getCurrentDirectory = () => "";
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      const path =
        name === "@lmcstools/core"
          ? "packages/core/src/contracts/index.ts"
          : name.startsWith(".")
            ? NodePath.posix.normalize(
                NodePath.posix.join(NodePath.posix.dirname(containing), name),
              )
            : "";
      return files.has(path) ? { resolvedFileName: path, extension: ts.Extension.Ts } : undefined;
    });
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const issues: { code: string; subject: string; source: Location | null }[] = [];
  const issue = (code: string, subject: string, node?: ts.Node) =>
    issues.push({ code, subject, source: node ? location(node) : null });
  for (const diagnostic of program.getSyntacticDiagnostics()) {
    issue("source-parse-error", diagnostic.file?.fileName ?? "source");
  }
  function declaration(node: ts.Node): ts.Declaration | undefined {
    let symbol =
      ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }
  function value(node: ts.Node | undefined, seen = new Set<ts.Node>()): ts.Node | undefined {
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    node = unwrap(node);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const target = declaration(node);
      if (target && ts.isVariableDeclaration(target)) return value(target.initializer, seen);
      if (target && ts.isPropertyAssignment(target)) return value(target.initializer, seen);
    }
    return node;
  }
  function literal(node: ts.Node | undefined): string | null {
    node = value(node);
    if (!node) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const part = literal(span.expression);
        if (part === null) return null;
        result += part + span.literal.text;
      }
      return result;
    }
    return null;
  }
  function fields(node: ts.Node | undefined) {
    node = value(node);
    const result = new Map<string, ts.Node>();
    if (node && !ts.isObjectLiteralExpression(node)) issue("unresolved-options", text(node), node);
    if (node && ts.isObjectLiteralExpression(node))
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          issue("unresolved-object-spread", text(prop.expression), prop);
          continue;
        }
        const name = ts.isComputedPropertyName(prop.name)
          ? literal(prop.name.expression)
          : ts.isStringLiteralLike(prop.name) || ts.isIdentifier(prop.name)
            ? prop.name.text
            : null;
        if (name === null) issue("unresolved-property", text(prop.name), prop);
        else if (ts.isPropertyAssignment(prop)) result.set(name, prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) result.set(name, prop.name);
      }
    return result;
  }
  const named = (file: string, name: string) => {
    const source = files.get(file);
    let found: ts.Node | undefined;
    if (source)
      for (const statement of source.statements) {
        if (
          (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
          statement.name?.text === name
        )
          found = statement;
        if (ts.isVariableStatement(statement))
          for (const decl of statement.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === name) found = decl.initializer;
          }
      }
    if (!found) issue("missing-declaration", `${file}#${name}`);
    return found;
  };
  const evidence = (node: ts.Node) => ({ ...location(node), fingerprint: hash(text(node)) });
  function descriptor(node: ts.Node | undefined) {
    if (!node) return null;
    const references = new Map<string, ReturnType<typeof evidence>>();
    walk(node, (child) => {
      if (!ts.isIdentifier(child) && !ts.isPropertyAccessExpression(child)) return;
      const decl = declaration(child);
      if (
        decl &&
        (ts.isVariableDeclaration(decl) || ts.isClassDeclaration(decl)) &&
        decl !== node
      ) {
        const ref = evidence(decl);
        references.set(`${ref.file}:${ref.symbol}:${ref.line}`, ref);
      }
    });
    if (ts.isIdentifier(node) && !declaration(node)) issue("unresolved-schema", text(node), node);
    return { expression: text(node), ...evidence(node), references: [...references.values()] };
  }
  const schemas = (options: ts.Node | undefined, keys: string[]) => {
    const props = fields(options);
    return Object.fromEntries(keys.map((key) => [key, descriptor(props.get(key))]));
  };
  const calls: ts.CallExpression[] = [];
  for (const file of files.values())
    walk(file, (node) => {
      if (ts.isCallExpression(node)) calls.push(node);
    });
  const registrations = (name: string, argument: string) =>
    calls
      .filter(
        (call) => callName(call) === name && call.arguments.some((arg) => text(arg) === argument),
      )
      .map(evidence);

  const group = value(named(rpcFile, "WsRpcGroup"));
  const scopeMap = fields(named(authFile, "RPC_REQUIRED_SCOPES"));
  const dynamicScope = named(authFile, "requiredScopeForDeviceList");
  const rpc = [];
  if (!group || !ts.isCallExpression(group) || callName(group) !== "RpcGroup.make")
    issue("unresolved-rpc-group", "WsRpcGroup", group);
  else
    for (const member of group.arguments) {
      const definition = value(member);
      if (!definition || !ts.isCallExpression(definition) || callName(definition) !== "Rpc.make") {
        issue("unresolved-rpc-member", text(member), member);
        continue;
      }
      const tag = literal(definition.arguments[0]);
      if (tag === null) {
        issue("unresolved-rpc-tag", text(member), member);
        continue;
      }
      const props = fields(definition.arguments[1]);
      const scope = scopeMap.get(tag);
      if (!scope) issue("missing-rpc-scope", tag, definition);
      else if (literal(scope) === null) issue("unresolved-rpc-scope", tag, scope);
      const stream = value(props.get("stream"));
      const mode =
        !stream || stream.kind === ts.SyntaxKind.FalseKeyword
          ? "unary"
          : stream.kind === ts.SyntaxKind.TrueKeyword
            ? "stream"
            : "unclassified";
      if (mode === "unclassified") issue("unresolved-rpc-stream", tag, stream);
      rpc.push({
        tag,
        mode,
        definition: evidence(definition),
        registration: { status: "member-of-WsRpcGroup", source: location(member) },
        scope: {
          value: literal(scope),
          declaration: descriptor(scope),
          dynamic: tag === "device.list" ? descriptor(dynamicScope) : null,
        },
        schemas: schemas(definition.arguments[1], ["payload", "success", "error"]),
        defaults: { payload: "Schema.Void", success: "Schema.Void", error: "Schema.Never" },
      });
    }
  rpc.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const tags = new Set(rpc.map((entry) => entry.tag));
  const unregisteredWsMethods = [...fields(named(rpcFile, "WS_METHODS"))].flatMap(
    ([symbol, node]) => {
      const tag = literal(node);
      if (tag === null) {
        issue("unresolved-ws-method", symbol, node);
        return [];
      }
      if (tags.has(tag)) return [];
      issue("declared-unregistered-ws-method", tag, node);
      return [{ symbol, tag, source: location(node) }];
    },
  );

  // Follow only the fluent .add chain rooted at EnvironmentHttpApi, not every endpoint declaration.
  function chain(node: ts.Node | undefined): ts.CallExpression[] {
    node = value(node);
    if (node && ts.isClassDeclaration(node)) node = node.heritageClauses?.[0]?.types[0]?.expression;
    if (!node || !ts.isCallExpression(node)) return [];
    const receiver = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.expression
      : undefined;
    return [...chain(receiver), node];
  }
  const additions = (node: ts.Node | undefined) =>
    chain(node)
      .filter(
        (call) =>
          ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "add",
      )
      .flatMap((call) => [...call.arguments]);
  const typedHttp = [];
  const api = named(httpFile, "EnvironmentHttpApi");
  for (const groupRef of additions(api)) {
    const groupDecl = declaration(groupRef);
    const groupCalls = chain(groupDecl);
    const groupName = literal(
      groupCalls.find((call) => callName(call) === "HttpApiGroup.make")?.arguments[0],
    );
    if (!groupDecl || !groupName) {
      issue("unresolved-http-group", text(groupRef), groupRef);
      continue;
    }
    for (const endpointRef of additions(groupDecl)) {
      const endpointCalls = chain(endpointRef);
      const endpoint = endpointCalls.find((call) => callName(call).startsWith("HttpApiEndpoint."));
      if (!endpoint) {
        issue("unresolved-http-endpoint", text(endpointRef), endpointRef);
        continue;
      }
      const method = callName(endpoint).split(".")[1]!.toUpperCase();
      const path = literal(endpoint.arguments[1]);
      if (!path) issue("unresolved-http-path", text(endpoint.arguments[1]!), endpoint);
      const middlewareCalls = [...groupCalls, ...endpointCalls].filter(
        (call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "middleware",
      );
      typedHttp.push({
        group: groupName,
        name: literal(endpoint.arguments[0]),
        method,
        path,
        schemas: schemas(endpoint.arguments[2], [
          "params",
          "query",
          "headers",
          "payload",
          "success",
          "error",
        ]),
        middlewares: middlewareCalls.flatMap((call) => call.arguments.map(descriptor)),
        definition: evidence(endpoint),
        registration: { status: "member-of-EnvironmentHttpApi", source: location(groupRef) },
      });
    }
  }
  const rawHttp = calls
    .filter(
      (call) =>
        call.getSourceFile().fileName.startsWith("apps/server/src/") &&
        callName(call) === "HttpRouter.add",
    )
    .map((call) => {
      const method = literal(call.arguments[0]);
      const path = literal(call.arguments[1]);
      const listener =
        call.getSourceFile().fileName === "apps/server/src/cloud/CliTokenManager.ts"
          ? "oauth-loopback"
          : "environment";
      if (!method || !path) issue("unresolved-raw-route", `${method ?? "?"} ${path ?? "?"}`, call);
      issue("raw-http-schema-not-declared", `${listener}: ${method} ${path}`, call);
      return {
        method,
        path,
        listener,
        definition: evidence(call),
        pathExpression: descriptor(call.arguments[1]),
        schemas: null,
        handler: call.arguments[2] ? evidence(call.arguments[2]) : null,
        registration: { status: "route-factory-call; mounting-unverified", source: location(call) },
      };
    });

  type Factory = {
    mode: string;
    source: ReturnType<typeof evidence>;
    helper: Location | null;
    schemas: ReturnType<typeof schemas>;
  };
  type Usage = { source: Location; operation: string; mode: string; evidence: string };
  const desktopIpc = [];
  const channelSource = files.get(channelsFile);
  if (!channelSource) issue("missing-declaration", channelsFile);
  if (channelSource)
    for (const statement of channelSource.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.name.text.endsWith("_CHANNEL")) continue;
        const channel = literal(decl.initializer);
        if (!channel) issue("unresolved-ipc-channel", decl.name.text, decl);
        desktopIpc.push({
          symbol: decl.name.text,
          channel,
          definition: evidence(decl),
          factories: [] as Factory[],
          usages: [] as Usage[],
          modes: [] as string[],
        });
      }
    }
  const channelByValue = new Map(
    desktopIpc.filter((entry) => entry.channel).map((entry) => [entry.channel, entry]),
  );
  const isFactory = (call: ts.CallExpression) =>
    [
      "DesktopIpc.makeIpcMethod",
      "DesktopIpc.makeSyncIpcMethod",
      "makeIpcMethod",
      "makeSyncIpcMethod",
    ].includes(callName(call));
  for (const call of calls.filter((node) =>
    node.getSourceFile().fileName.startsWith("apps/desktop/src/"),
  )) {
    let factory = isFactory(call) ? call : undefined;
    let helper: ts.ArrowFunction | undefined;
    const target = value(call.expression);
    if (!factory && target && ts.isArrowFunction(target)) {
      const body = unwrap(target.body);
      if (ts.isCallExpression(body) && isFactory(body)) {
        helper = target;
        factory = body;
      }
    }
    if (factory) {
      const props = fields(factory.arguments[0]);
      let channelNode = props.get("channel");
      if (helper && channelNode) {
        const index = helper.parameters.findIndex(
          (param) => text(param.name) === text(channelNode!),
        );
        channelNode = call.arguments[index];
      }
      const channel = literal(channelNode);
      const entry = channelByValue.get(channel);
      // The parameterized helper definition is not itself an installed method.
      if (
        !entry &&
        !helper &&
        channelNode &&
        declaration(channelNode) &&
        ts.isParameter(declaration(channelNode)!)
      )
        continue;
      if (!entry) {
        issue("unresolved-ipc-factory-channel", channel ?? "dynamic", call);
        continue;
      }
      const mode = callName(factory).includes("Sync") ? "sync" : "invoke";
      entry.factories.push({
        mode,
        source: evidence(call),
        helper: helper ? location(helper) : null,
        schemas: schemas(factory.arguments[0], ["payload", "result"]),
      });
      if ((mode !== "sync" && !props.has("payload")) || !props.has("result"))
        issue("missing-ipc-schema", entry.symbol, call);
      continue;
    }
    for (const arg of call.arguments) {
      const entry = channelByValue.get(literal(arg));
      if (!entry) continue;
      const operation = callName(call);
      const method = ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.text
        : operation;
      const mode =
        method === "sendSync"
          ? "sync"
          : method === "invoke" || method === "handle"
            ? "invoke"
            : ["send", "sendAll", "on", "once", "removeListener", "dispatchRendererEvent"].includes(
                  method,
                )
              ? "event"
              : "raw";
      entry.usages.push({
        source: location(call),
        operation,
        mode,
        evidence: "call-reference; not installation proof",
      });
    }
  }
  for (const entry of desktopIpc) {
    entry.modes = [
      ...new Set([...entry.factories.map((f) => f.mode), ...entry.usages.map((u) => u.mode)]),
    ].sort();
    if (!entry.modes.length) issue("unclassified-ipc-channel", entry.symbol);
    if (!entry.factories.length) issue("ipc-schema-not-declared", entry.symbol);
  }
  return {
    formatVersion: 1 as const,
    evidencePolicy: {
      runtimeVerified: false,
      registration:
        "Contract membership and source calls only; references/factories do not prove listener mounting or functional coverage.",
      scopes:
        "Authorization is not a side-effect classification. device.list is payload-dependent; inspect its dynamic declaration. Read-scoped calls may refresh caches, report activity, or perform other effects.",
      schemas:
        "Source expressions and declaration fingerprints, not evaluated schemas. Null means omitted/unknown; RPC defaults apply only to omitted fields. Stream success/error describe elements, not the transport wrapper.",
      fingerprints:
        "SHA-256 of comment-free TypeScript printing. Source manifest covers all scanned files, including transitive local schema changes; external package implementations are not resolved.",
      scannedRoots: roots,
    },
    rpc,
    unregisteredWsMethods,
    http: { typed: typedHttp, raw: rawHttp },
    desktopIpc,
    registrationEvidence: {
      rpc: registrations("RpcServer.make", "WsRpcGroup"),
      http: registrations("HttpApiBuilder.layer", "EnvironmentHttpApi"),
      desktop: { status: "factory-definitions-and-call-references; installation-unverified" },
    },
    sources: [...files].map(([file, source]) => ({ file, fingerprint: hash(text(source)) })),
    issues,
  };
}

if (import.meta.main) {
  process.stdout.write(
    `${JSON.stringify(await buildMigrationInventory(NodePath.resolve(process.argv[2] ?? ".")), null, 2)}\n`,
  );
}
