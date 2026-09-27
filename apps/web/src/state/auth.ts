import { createAuthEnvironmentAtoms } from "@lmcstools/client/state/auth";

import { connectionAtomRuntime } from "../connection/runtime";

export const authEnvironment = createAuthEnvironmentAtoms(connectionAtomRuntime);
