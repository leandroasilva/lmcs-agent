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
const scriptJs = "console.log('synthetic');\n";
const immutableJs = "console.log('immutable');\n";

// Validators derive from size and mtime, so a pinned mtime is what makes the raw header values
// byte-identical across runs and therefore reusable as conditional request headers.
// @effect-diagnostics-next-line globalDate:off - a fixed fixture timestamp, not a clock read
const FIXED_MTIME = new Date(1_700_000_000_000);

const writeFixture = async (directory: string) => {
  const files: Record<string, string> = {
    "index.html": indexHtml,
    "nested/index.html": nestedHtml,
    "app.js": scriptJs,
    "assets/main-abcdefgh.js": immutableJs,
    "assets/other-12345678.js": "console.log('revalidated');\n",
    ".vite/manifest.json": JSON.stringify({
      "src/main.ts": { file: "assets/main-abcdefgh.js" },
    }),
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = NodePath.join(directory, relative);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, contents);
    await NodeFSP.utimes(file, FIXED_MTIME, FIXED_MTIME);
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

    // The snapshot above only records whether the ETag has the weak size-mtime shape; a
    // conditional round trip needs the raw validators, and a 304 needs its own narrow snapshot
    // because it keeps Cache-Control, ETag, Last-Modified and Vary while dropping the body.
    const conditional = async (path: string, headers: Record<string, string>) => {
      const response = await staticMode.handler(
        new Request(`http://migration.invalid${path}`, { headers }),
      );
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        vary: response.headers.get("vary"),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentLength: response.headers.get("content-length"),
        body: await response.text(),
      };
    };

    const scriptValidators = {
      etag: `W/"${byteLength(scriptJs).toString(16)}-${FIXED_MTIME.getTime().toString(16)}"`,
      lastModified: FIXED_MTIME.toUTCString(),
    };
    const immutableValidators = {
      etag: `W/"${byteLength(immutableJs).toString(16)}-${FIXED_MTIME.getTime().toString(16)}"`,
      lastModified: FIXED_MTIME.toUTCString(),
    };
    const notModified = {
      status: 304,
      cacheControl: "no-cache",
      vary: "Accept-Encoding",
      etag: scriptValidators.etag,
      lastModified: scriptValidators.lastModified,
      contentLength: null,
      body: "",
    };
    const scriptFull = {
      status: 200,
      cacheControl: "no-cache",
      vary: null,
      etag: scriptValidators.etag,
      lastModified: scriptValidators.lastModified,
      contentLength: String(byteLength(scriptJs)),
      body: scriptJs,
    };

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
      contentLength: String(byteLength(scriptJs)),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: true,
      body: scriptJs,
    });
    check("manifest-asset-is-immutable", await get("/assets/main-abcdefgh.js"), {
      status: 200,
      contentType: "text/javascript",
      cacheControl: "public, max-age=31536000, immutable",
      contentLength: String(byteLength(immutableJs)),
      vary: null,
      location: null,
      etagIsWeakSizeMtime: true,
      body: immutableJs,
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
    check(
      "script-emits-weak-validator-and-last-modified",
      await conditional("/app.js", {}),
      scriptFull,
    );
    check(
      "if-none-match-with-the-emitted-etag-returns-304",
      await conditional("/app.js", { "if-none-match": scriptValidators.etag }),
      notModified,
    );
    // The comparison strips `W/` from both sides, so the strong form of the same value matches too.
    check(
      "if-none-match-compares-weakly-so-the-strong-form-matches",
      await conditional("/app.js", { "if-none-match": scriptValidators.etag.slice(2) }),
      notModified,
    );
    check(
      "if-none-match-list-containing-the-etag-returns-304",
      await conditional("/app.js", { "if-none-match": `"stale", ${scriptValidators.etag}` }),
      notModified,
    );
    check(
      "if-none-match-with-a-stale-etag-returns-200",
      await conditional("/app.js", { "if-none-match": '"stale"' }),
      scriptFull,
    );
    check(
      "if-modified-since-with-the-emitted-date-returns-304",
      await conditional("/app.js", { "if-modified-since": scriptValidators.lastModified }),
      notModified,
    );
    check(
      "if-modified-since-with-an-older-date-returns-200",
      await conditional("/app.js", { "if-modified-since": "Tue, 14 Nov 2023 22:13:19 GMT" }),
      scriptFull,
    );
    // A present If-None-Match short-circuits the date branch, so a stale validator wins over a
    // date that alone would have been a 304.
    check(
      "if-none-match-takes-precedence-over-if-modified-since",
      await conditional("/app.js", {
        "if-none-match": '"stale"',
        "if-modified-since": "Tue, 14 Nov 2023 22:13:21 GMT",
      }),
      scriptFull,
    );
    // An unparsable date compares as NaN and never yields a false 304.
    check(
      "if-modified-since-with-an-unparsable-date-returns-200",
      await conditional("/app.js", { "if-modified-since": "not a date" }),
      scriptFull,
    );
    // HTML deliberately carries no validator, so neither conditional header can ever 304 it.
    check(
      "html-has-no-validator-so-if-modified-since-returns-200",
      await conditional("/", { "if-modified-since": "Tue, 14 Nov 2023 22:13:21 GMT" }),
      {
        status: 200,
        cacheControl: "no-cache",
        vary: null,
        etag: null,
        lastModified: null,
        contentLength: String(byteLength(indexHtml)),
        body: indexHtml,
      },
    );
    check(
      "immutable-asset-304-keeps-immutable-cache-control",
      await conditional("/assets/main-abcdefgh.js", { "if-none-match": immutableValidators.etag }),
      {
        status: 304,
        cacheControl: "public, max-age=31536000, immutable",
        vary: "Accept-Encoding",
        etag: immutableValidators.etag,
        lastModified: immutableValidators.lastModified,
        contentLength: null,
        body: "",
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
      "Executed the real GET * static/dev handler through HttpRouter.toWebHandler against a synthetic temporary directory and config layers. No listener, compression, browser, packaged build, GitHub media, signed asset claims or Rust implementation is exercised. Missing files fall back to index.html with 200, so this corpus does not prove a secure static policy. Conditional requests are recorded, not approved: this route hand-rolls its own If-None-Match and If-Modified-Since comparison in http.ts instead of using Effect's HttpStaticServer, while the asset route reads neither header and can never return 304 — so the server honours a weak validator on one path and ignores a strong one on the other. A port must settle on one policy deliberately rather than inherit both.",
    fixturePolicy:
      "The temporary directory contains fixed HTML, JS and one manifest-listed asset, each pinned to a fixed mtime so the emitted weak ETag and Last-Modified are byte-identical across runs and can be pinned as raw values and reused as conditional request headers. The broad snapshot still validates ETags by shape; only the conditional rows read the raw validators.",
    knownLimitations: [
      "Compression, range responses and media streaming belong to the asset route, not this fallback handler, and are not exercised here.",
      "Conditional requests are exercised for the revalidated script and the immutable asset only; HEAD with a conditional header, a conditional request that falls back to index.html and conditional behaviour under compression remain uncovered.",
      "The dev redirect checks a loopback Host in-process; real network URL parsing, TLS and proxy loop behavior remain untested.",
      "No packaged build, immutable-manifest drift, cancellation or concurrent requests are covered.",
    ],
    results,
  };
}
