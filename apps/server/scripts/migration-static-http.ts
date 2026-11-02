import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import * as ServerConfig from "../src/config.ts";
import { staticAndDevRouteLayer } from "../src/http.ts";

const subject = "environment: GET *";

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const indexHtml = "<!doctype html><h1>synthetic index</h1>";
const nestedHtml = "<!doctype html><h1>nested index</h1>";

const writeFixture = async (directory: string) => {
  const files: Record<string, string> = {
    "index.html": indexHtml,
    "nested/index.html": nestedHtml,
    "app.js": "console.log('synthetic');\n",
    "assets/main-abcdefgh.js": "console.log('immutable');\n",
    "assets/other-12345678.js": "console.log('revalidated');\n",
    ".vite/manifest.json": JSON.stringify({
      "src/main.ts": { file: "assets/main-abcdefgh.js" },
    }),
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = NodePath.join(directory, relative);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, contents);
  }
};

const config = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return { ...base, ...overrides };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "lmcs-migration-static-config-" }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

const makeHandler = (service: ServerConfig.ServerConfig["Service"]) =>
  HttpRouter.toWebHandler(
    staticAndDevRouteLayer.pipe(
      Layer.provideMerge(Layer.mergeAll(ServerConfig.layer(service), NodeServices.layer)),
    ),
    { disableLogger: true },
  );

export async function runMigrationStaticHttp() {
  const results: {
    id: string;
    subject: typeof subject;
    passed: boolean;
    expected: unknown;
    actual: unknown;
  }[] = [];
  const check = (id: string, actual: unknown, expected: unknown) => {
    results.push({
      id,
      subject,
      passed: NodeUtil.isDeepStrictEqual(actual, expected),
      expected,
      actual,
    });
  };

  const staticDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lmcs-migration-static-"));
  await writeFixture(staticDir);

  const disposeAll: (() => Promise<void>)[] = [];
  try {
    const read = async (
      handler: (request: Request) => Promise<Response>,
      url: string,
      init?: RequestInit,
    ) => {
      const response = await handler(new Request(url, init));
      const text = await response.text();
      const etag = response.headers.get("etag");
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        contentLength: response.headers.get("content-length"),
        vary: response.headers.get("vary"),
        location: response.headers.get("location"),
        etagIsWeakSizeMtime: etag === null ? null : /^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(etag),
        body: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      };
    };

    const staticMode = makeHandler(await config({ staticDir, devUrl: undefined }));
    disposeAll.push(staticMode.dispose);
    const get = (path: string, init?: RequestInit) =>
      read(staticMode.handler, `http://migration.invalid${path}`, init);

    const root = await get("/");
    check("root-serves-index-html", root, {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
      contentLength: String(byteLength(indexHtml)),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: indexHtml,
    });
    check("extensionless-missing-falls-back-to-root-index", await get("/missing"), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
      contentLength: String(byteLength(indexHtml)),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: indexHtml,
    });
    check("extensionless-directory-serves-nested-index", await get("/nested"), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
      contentLength: String(byteLength(nestedHtml)),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: nestedHtml,
    });
    check("missing-extension-file-falls-back-to-html-index", await get("/missing.js"), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
      contentLength: String(byteLength(indexHtml)),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: indexHtml,
    });

    const script = await get("/app.js");
    check("script-is-not-immutable", script, {
      status: 200,
      contentType: "text/javascript",
      cacheControl: "no-cache",
      contentLength: String(byteLength("console.log('synthetic');\n")),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: true,
      body: "console.log('synthetic');\n",
    });
    check("manifest-asset-is-immutable", await get("/assets/main-abcdefgh.js"), {
      status: 200,
      contentType: "text/javascript",
      cacheControl: "public, max-age=31536000, immutable",
      contentLength: String(byteLength("console.log('immutable');\n")),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: true,
      body: "console.log('immutable');\n",
    });
    check(
      "hash-like-file-outside-manifest-is-revalidated",
      await get("/assets/other-12345678.js"),
      {
        status: 200,
        contentType: "text/javascript",
        cacheControl: "no-cache",
        contentLength: String(byteLength("console.log('revalidated');\n")),
        vary: null,
        location: null,
        etagIsWeakSizeMtime: true,
        body: "console.log('revalidated');\n",
      },
    );

    check(
      "if-none-match-star-returns-304-without-body",
      await get("/app.js", {
        headers: { "if-none-match": "*" },
      }),
      {
        status: 304,
        contentType: null,
        cacheControl: "no-cache",
        contentLength: null,
        vary: "Accept-Encoding",
        location: null,
        etagIsWeakSizeMtime: true,
        body: "",
      },
    );
    check(
      "html-ignores-if-none-match-star",
      await get("/", {
        headers: { "if-none-match": "*" },
      }),
      {
        status: 200,
        contentType: "text/html; charset=utf-8",
        cacheControl: "no-cache",
        contentLength: String(byteLength(indexHtml)),
        vary: null,
        location: null,
        etagIsWeakSizeMtime: null,
        body: indexHtml,
      },
    );
    check("head-serves-headers-without-body", await get("/", { method: "HEAD" }), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
      contentLength: String(byteLength(indexHtml)),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: "",
    });
    check("encoded-parent-segment-is-rejected", await get("/..%2Fsecret.txt"), {
      status: 400,
      contentType: "text/plain",
      cacheControl: null,
      contentLength: String(byteLength("Invalid static file path")),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: "Invalid static file path",
    });
    check("invalid-host-is-a-bad-request", await get("/", { headers: { host: "[" } }), {
      status: 400,
      contentType: "text/plain",
      cacheControl: null,
      contentLength: String(byteLength("Bad Request")),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: "Bad Request",
    });
    check("post-is-not-served-by-the-get-route", await get("/", { method: "POST" }), {
      status: 404,
      contentType: null,
      cacheControl: null,
      contentLength: null,
      vary: null,
      location: null,
      etagIsWeakSizeMtime: null,
      body: "",
    });

    const devMode = makeHandler(
      await config({ staticDir, devUrl: new URL("http://127.0.0.1:5733") }),
    );
    disposeAll.push(devMode.dispose);
    check(
      "dev-loopback-host-redirects-preserving-path-and-query",
      await read(devMode.handler, "http://127.0.0.1:3773/nested/app.js?x=1"),
      {
        status: 302,
        contentType: null,
        cacheControl: null,
        contentLength: null,
        vary: null,
        location: "http://127.0.0.1:5733/nested/app.js?x=1",
        etagIsWeakSizeMtime: null,
        body: "",
      },
    );
    for (const [id, path] of [
      ["dev-api-prefix-is-not-redirected", "/api/devices"],
      ["dev-oauth-prefix-is-not-redirected", "/oauth/token"],
      ["dev-ws-prefix-is-not-redirected", "/ws"],
    ] as const) {
      check(id, await read(devMode.handler, `http://127.0.0.1:3773${path}`), {
        status: 404,
        contentType: "text/plain",
        cacheControl: null,
        contentLength: String(byteLength("Not Found")),
        vary: null,
        location: null,
        etagIsWeakSizeMtime: null,
        body: "Not Found",
      });
    }
    check(
      "dev-non-loopback-host-serves-static",
      await read(devMode.handler, "http://migration.invalid/", {
        headers: { host: "migration.invalid" },
      }),
      {
        status: 200,
        contentType: "text/html; charset=utf-8",
        cacheControl: "no-cache",
        contentLength: String(byteLength(indexHtml)),
        vary: null,
        location: null,
        etagIsWeakSizeMtime: null,
        body: indexHtml,
      },
    );

    const emptyMode = makeHandler(await config({ staticDir: undefined, devUrl: undefined }));
    disposeAll.push(emptyMode.dispose);
    check(
      "no-static-dir-and-no-dev-url",
      await read(emptyMode.handler, "http://migration.invalid/"),
      {
        status: 503,
        contentType: "text/plain",
        cacheControl: null,
        contentLength: String(byteLength("No static directory configured and no dev URL set.")),
        vary: null,
        location: null,
        etagIsWeakSizeMtime: null,
        body: "No static directory configured and no dev URL set.",
      },
    );
  } finally {
    for (const dispose of disposeAll.toReversed()) await dispose();
    await NodeFSP.rm(staticDir, { recursive: true, force: true });
  }

  return {
    interpretation:
      "Executed the real GET * static/dev handler through HttpRouter.toWebHandler against a synthetic temporary directory and config layers. No listener, compression, browser, packaged build, GitHub media, signed asset claims or Rust implementation is exercised. Missing files fall back to index.html with 200, so this corpus does not prove a secure static policy.",
    fixturePolicy:
      "The temporary directory contains fixed HTML, JS and one manifest-listed asset. ETags are validated by shape because they derive from file size and mtime; no clock or mtime normalization is applied.",
    knownLimitations: [
      "Compression, range responses and media streaming belong to the asset route, not this fallback handler, and are not exercised here.",
      "If-None-Match uses a fixed weak validator rather than the generated ETag; If-Modified-Since behavior is not covered.",
      "The dev redirect checks a loopback Host in-process; real network URL parsing, TLS and proxy loop behavior remain untested.",
      "No packaged build, immutable-manifest drift, cancellation or concurrent requests are covered.",
    ],
    results,
  };
}
