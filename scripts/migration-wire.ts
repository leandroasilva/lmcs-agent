import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  AuthAccessTokenResult,
  AuthCreatePairingCredentialInput,
  AuthSessionState,
  EnvironmentAuthorizationError,
} from "../packages/core/src/contracts/auth.ts";
import { EnvironmentAuthInvalidError } from "../packages/core/src/contracts/environmentHttp.ts";
import { ClientOrchestrationCommand } from "../packages/core/src/contracts/orchestration.ts";
import { ProviderRuntimeEvent } from "../packages/core/src/contracts/providerRuntime.ts";
import {
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
} from "../packages/core/src/contracts/terminal.ts";

const codecs = {
  ClientOrchestrationCommand,
  AuthAccessTokenResult,
  AuthCreatePairingCredentialInput,
  AuthSessionState,
  EnvironmentAuthorizationError,
  EnvironmentAuthInvalidError,
  ProviderRuntimeEvent,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
} satisfies Record<string, Schema.Codec<unknown, unknown>>;

const Corpus = Schema.Struct({
  formatVersion: Schema.Literal(1),
  provenance: Schema.Literal("synthetic-no-user-data"),
  cases: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      schema: Schema.Literals(Object.keys(codecs) as Array<keyof typeof codecs>),
      input: Schema.Unknown,
      expected: Schema.Union([
        Schema.Struct({ accepted: Schema.Literal(true), encoded: Schema.Unknown }),
        Schema.Struct({ accepted: Schema.Literal(false) }),
      ]),
    }),
  ),
});

const decodeCorpus = Schema.decodeUnknownSync(Corpus);
const runners = Object.fromEntries(
  Object.entries(codecs).map(([name, codec]) => {
    const decode = Schema.decodeUnknownExit(codec);
    const encode = Schema.encodeUnknownSync(codec);
    return [
      name,
      (input: unknown) => {
        const decoded = decode(input);
        if (Exit.isFailure(decoded)) return { accepted: false as const };
        return { accepted: true as const, encoded: encode(decoded.value) };
      },
    ];
  }),
);

export function evaluateWireCorpus(input: unknown) {
  const corpus = decodeCorpus(input);
  if (corpus.cases.length === 0) throw new Error("The wire corpus must not be empty.");
  const ids = new Set<string>();
  return corpus.cases.map((fixture) => {
    if (ids.has(fixture.id)) throw new Error(`Duplicate wire fixture: ${fixture.id}`);
    ids.add(fixture.id);
    const actual = runners[fixture.schema]!(fixture.input);
    return {
      id: fixture.id,
      schema: fixture.schema,
      passed: NodeUtil.isDeepStrictEqual(actual, fixture.expected),
      expected: fixture.expected,
      actual,
    };
  });
}

export async function runWireCorpus() {
  const corpus = JSON.parse(
    await NodeFSP.readFile(new URL("./fixtures/migration-wire.json", import.meta.url), "utf8"),
  );
  return evaluateWireCorpus(corpus);
}
