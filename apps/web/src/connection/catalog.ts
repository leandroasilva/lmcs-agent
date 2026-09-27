import { createEnvironmentCatalogAtoms } from "@lmcstools/client-runtime/state/connections";

import { connectionAtomRuntime } from "./runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);
