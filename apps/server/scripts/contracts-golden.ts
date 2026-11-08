// Golden generator for the Rust contracts crate. Dumps the shipped RPC dispatch
// surface — both method tables and the tags actually registered on the group —
// so `native/contracts` is checked against the TypeScript it replaces rather
// than against a copy of it.
//
// `node apps/server/scripts/contracts-golden.ts > /tmp/contracts-golden.json`

import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsRpcGroup } from "@lmcstools/core";

const requests = (WsRpcGroup as unknown as { requests: Map<string, unknown> }).requests;
const registered = [...requests.keys()];

const declared = { ...WS_METHODS, ...ORCHESTRATION_WS_METHODS };
const declaredTags = Object.values(declared);
const registeredSet = new Set(registered);
const declaredSet = new Set(declaredTags);

const golden = {
  wsMethods: WS_METHODS,
  orchestrationWsMethods: ORCHESTRATION_WS_METHODS,
  registered,
  reconciliation: {
    declaredNotRegistered: Object.entries(declared)
      .filter(([, tag]) => !registeredSet.has(tag))
      .map(([key, tag]) => ({ key, tag })),
    registeredNotDeclared: registered.filter((tag) => !declaredSet.has(tag)),
    duplicateTags: declaredTags.filter((tag, index) => declaredTags.indexOf(tag) !== index),
  },
};

process.stderr.write(
  `declared: ${declaredTags.length} (ws ${Object.keys(WS_METHODS).length} + orchestration ${
    Object.keys(ORCHESTRATION_WS_METHODS).length
  }) registered: ${registered.length}\n`,
);
process.stdout.write(`${JSON.stringify(golden, null, 2)}\n`);
