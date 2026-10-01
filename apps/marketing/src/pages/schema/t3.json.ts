import type { APIRoute } from "astro";

import { buildT3ProjectFileJsonSchema } from "@lmcstools/core/t3ProjectFile";

// Rendered at build time; published at https://lmcs.codes/schema/lmcs.json so
// lmcs.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
