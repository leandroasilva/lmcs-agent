import { createReviewEnvironmentAtoms } from "@lmcstools/client/state/review";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime);
