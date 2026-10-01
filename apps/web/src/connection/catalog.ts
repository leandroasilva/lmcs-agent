import { createEnvironmentCatalogAtoms } from "@lmcstools/client/state/connections";

import { connectionAtomRuntime } from "./runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);
