import { createRelayEnvironmentDiscoveryAtoms } from "@lmcstools/client/state/relay";

import { connectionAtomRuntime } from "../connection/runtime";

export const relayEnvironmentDiscovery =
  createRelayEnvironmentDiscoveryAtoms(connectionAtomRuntime);
