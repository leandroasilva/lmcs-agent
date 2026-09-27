import { createFilesystemEnvironmentAtoms } from "@lmcstools/client-runtime/state/filesystem";

import { connectionAtomRuntime } from "../connection/runtime";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);
