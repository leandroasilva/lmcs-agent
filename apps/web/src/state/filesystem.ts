import { createFilesystemEnvironmentAtoms } from "@lmcstools/client/state/filesystem";

import { connectionAtomRuntime } from "../connection/runtime";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);
