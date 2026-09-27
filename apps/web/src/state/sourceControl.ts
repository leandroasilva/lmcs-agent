import { createSourceControlEnvironmentAtoms } from "@lmcstools/client-runtime/state/source-control";

import { connectionAtomRuntime } from "../connection/runtime";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(connectionAtomRuntime);
