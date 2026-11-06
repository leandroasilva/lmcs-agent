import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { ASSET_ROUTE_PREFIX, issueAssetUrl } from "../src/assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../src/assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "../src/auth/utils.ts";
import { createPendingAttachmentId } from "../src/attachmentStore.ts";
import * as ServerConfig from "../src/config.ts";
import { assetRouteLayer } from "../src/http.ts";
import * as ProjectFaviconResolver from "../src/project/ProjectFaviconResolver.ts";
import * as GitHubCli from "../src/sourceControl/GitHubCli.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";

const subject = `environment: GET ${ASSET_ROUTE_PREFIX}/*`;

const SIGNING_SECRET = Uint8Array.from({ length: 32 }, (_, index) => 32 - index);

// ASCII payload: byte ranges, text decoding and lengths stay readable.
const BYTES = [97, 98, 99, 100, 101, 102];
const BODY_TEXT = "abcdef";

// Validators derive from size and mtime, so a pinned mtime is what makes the raw header values
// byte-identical across runs instead of only their shape being checkable.
// @effect-diagnostics-next-line globalDate:off - a fixed fixture timestamp, not a clock read
const FIXED_MTIME = new Date(1_700_000_000_000);

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const config = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return { ...base, ...overrides };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "lmcs-migration-asset-config-" }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

const services = (service: ServerConfig.ServerConfig["Service"]) =>
  Layer.mergeAll(
    ServerConfig.layer(service),
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(SIGNING_SECRET),
    }),
    Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
    Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
    Layer.mock(GitHubCli.GitHubCli)({}),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No upstream fetch is configured for this corpus.")),
    ),
    WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
    NodeHttpPlatform.layer,
    NodeServices.layer,
  );

const mintUrl = (
  service: ServerConfig.ServerConfig["Service"],
  resource: Parameters<typeof issueAssetUrl>[0]["resource"],
) =>
  Effect.runPromise(
    issueAssetUrl({ resource }).pipe(
      Effect.provide(services(service)),
      Effect.provideService(Logger.LogToStderr, true),
    ),
  );

const splitRelativeUrl = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separatorIndex = suffix.indexOf("/");
  if (separatorIndex <= 0) throw new Error("Expected a token and file name.");
  return { token: suffix.slice(0, separatorIndex), fileName: suffix.slice(separatorIndex + 1) };
};

const tamperSignature = (relativeUrl: string) => {
  const { token, fileName } = splitRelativeUrl(relativeUrl);
  const [payload, signature] = token.split(".");
  return `${ASSET_ROUTE_PREFIX}/${payload}.${signature?.slice(0, -2)}aa/${fileName}`;
};

const expireToken = (relativeUrl: string) => {
  const { token, fileName } = splitRelativeUrl(relativeUrl);
  const [encodedPayload] = token.split(".");
  if (!encodedPayload) throw new Error("Expected a signed payload segment.");
  const claims = JSON.parse(base64UrlDecodeUtf8(encodedPayload)) as Record<string, unknown>;
  claims.expiresAt = 0;
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${ASSET_ROUTE_PREFIX}/${payload}.${signPayload(payload, SIGNING_SECRET)}/${fileName}`;
};

const textResponse = (status: number, body: string) => ({
  status,
  contentType: "text/plain",
  cacheControl: null,
  contentLength: String(byteLength(body)),
  acceptRanges: null,
  contentRange: null,
  contentDisposition: null,
  contentSecurityPolicy: null,
  nosniff: null,
  lastModifiedIsDate: false,
  etagIsStrongSizeMtime: null,
  body,
});

const notFound = textResponse(404, "Not Found");

const fileResponse = (overrides: {
  contentType: string;
  cacheControl: string;
  contentLength?: string;
  acceptRanges?: string | null;
  contentRange?: string | null;
  contentDisposition?: string | null;
  contentSecurityPolicy?: string | null;
  status?: number;
  body?: number[] | string;
}) => ({
  status: overrides.status ?? 200,
  contentType: overrides.contentType,
  cacheControl: overrides.cacheControl,
  contentLength: overrides.contentLength ?? "6",
  acceptRanges: overrides.acceptRanges ?? null,
  contentRange: overrides.contentRange ?? null,
  contentDisposition: overrides.contentDisposition ?? null,
  contentSecurityPolicy: overrides.contentSecurityPolicy ?? null,
  nosniff: "nosniff",
  lastModifiedIsDate: true,
  etagIsStrongSizeMtime: true,
  body: overrides.body ?? BYTES,
});

export async function runMigrationAssetHttp() {
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

  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lmcs-migration-asset-"));
  const attachmentsDir = NodePath.join(root, "attachments");
  await NodeFSP.mkdir(attachmentsDir, { recursive: true });
  const fixMtime = (name: string) =>
    NodeFSP.utimes(NodePath.join(attachmentsDir, name), FIXED_MTIME, FIXED_MTIME);

  const imageId = createPendingAttachmentId();
  const videoId = createPendingAttachmentId(".mp4");
  const pdfId = createPendingAttachmentId(".pdf");
  const htmlId = createPendingAttachmentId(".html");
  const fixtureNames = [`${imageId}.png`, `${videoId}.mp4`, `${pdfId}.pdf`, `${htmlId}.html`];
  for (const name of fixtureNames) {
    await NodeFSP.writeFile(NodePath.join(attachmentsDir, name), Uint8Array.from(BYTES));
    await fixMtime(name);
  }

  const service = await config({ attachmentsDir });
  const { handler, dispose } = HttpRouter.toWebHandler(
    assetRouteLayer.pipe(Layer.provideMerge(services(service))),
    { disableLogger: true },
  );

  const read = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`http://migration.invalid${path}`, init));
    const bodyBytes = [...new Uint8Array(await response.arrayBuffer())];
    const contentType = response.headers.get("content-type");
    const etag = response.headers.get("etag");
    return {
      status: response.status,
      contentType,
      cacheControl: response.headers.get("cache-control"),
      contentLength: response.headers.get("content-length"),
      acceptRanges: response.headers.get("accept-ranges"),
      contentRange: response.headers.get("content-range"),
      contentDisposition: response.headers.get("content-disposition"),
      contentSecurityPolicy: response.headers.get("content-security-policy"),
      nosniff: response.headers.get("x-content-type-options"),
      lastModifiedIsDate: response.headers.get("last-modified") !== null,
      etagIsStrongSizeMtime: etag === null ? null : /^"[0-9a-f]+-[0-9a-f]+"$/.test(etag),
      body: contentType?.startsWith("text/")
        ? new TextDecoder().decode(Uint8Array.from(bodyBytes))
        : bodyBytes,
    };
  };

  // The snapshot above collapses validators to booleans; conditional requests need the raw values.
  const validators = async (path: string) => {
    const response = await handler(new Request(`http://migration.invalid${path}`));
    return {
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  };

  const emittedValidators = {
    etag: `"${BYTES.length.toString(16)}-${FIXED_MTIME.getTime().toString(16)}"`,
    lastModified: FIXED_MTIME.toUTCString(),
  };

  try {
    const image = await mintUrl(service, {
      _tag: "attachment",
      attachmentId: imageId,
      fileName: "shot.png",
      mimeType: "image/png",
    });
    const video = await mintUrl(service, {
      _tag: "attachment",
      attachmentId: videoId,
      fileName: "clip.mp4",
      mimeType: "video/mp4",
    });
    const pdf = await mintUrl(service, {
      _tag: "attachment",
      attachmentId: pdfId,
      fileName: "report.pdf",
      mimeType: "application/pdf",
    });
    const unicodePdf = await mintUrl(service, {
      _tag: "attachment",
      attachmentId: pdfId,
      fileName: "répört.pdf",
      mimeType: "application/pdf",
    });
    const html = await mintUrl(service, {
      _tag: "attachment",
      attachmentId: htmlId,
      fileName: "page.html",
      mimeType: "text/html",
      disposition: "inline",
    });

    check(
      "missing-token-segment-is-not-found",
      await read(`${ASSET_ROUTE_PREFIX}/only-token`),
      notFound,
    );
    check(
      "tampered-signature-is-not-found",
      await read(tamperSignature(image.relativeUrl)),
      notFound,
    );
    check("expired-token-is-not-found", await read(expireToken(image.relativeUrl)), notFound);

    await NodeFSP.rm(NodePath.join(attachmentsDir, `${imageId}.png`));
    check("deleted-file-is-not-found", await read(image.relativeUrl), notFound);
    await NodeFSP.writeFile(
      NodePath.join(attachmentsDir, `${imageId}.png`),
      Uint8Array.from(BYTES),
    );
    await fixMtime(`${imageId}.png`);

    const imageResponse = fileResponse({
      contentType: "image/png",
      cacheControl: "private, max-age=3600",
    });
    check("image-is-served-inline", await read(image.relativeUrl), imageResponse);
    check(
      "image-ignores-range-request",
      await read(image.relativeUrl, { headers: { range: "bytes=1-2" } }),
      imageResponse,
    );
    check("head-returns-headers-without-body", await read(image.relativeUrl, { method: "HEAD" }), {
      ...imageResponse,
      body: [],
    });

    const videoResponse = fileResponse({
      contentType: "video/mp4",
      cacheControl: "private, no-store",
      acceptRanges: "bytes",
    });
    check("video-is-private-no-store", await read(video.relativeUrl), videoResponse);
    check(
      "video-range-returns-partial-content",
      await read(video.relativeUrl, { headers: { range: "bytes=2-4" } }),
      fileResponse({
        contentType: "video/mp4",
        cacheControl: "private, no-store",
        acceptRanges: "bytes",
        contentRange: "bytes 2-4/6",
        contentLength: "3",
        status: 206,
        body: [99, 100, 101],
      }),
    );
    check(
      "video-unsatisfiable-range-is-416",
      await read(video.relativeUrl, { headers: { range: "bytes=10-" } }),
      {
        status: 416,
        contentType: "video/mp4",
        cacheControl: "private, no-store",
        contentLength: null,
        acceptRanges: "bytes",
        contentRange: "bytes */6",
        contentDisposition: null,
        contentSecurityPolicy: null,
        nosniff: "nosniff",
        lastModifiedIsDate: false,
        etagIsStrongSizeMtime: null,
        body: [],
      },
    );

    check(
      "image-validators-are-strong-size-mtime",
      await validators(image.relativeUrl),
      emittedValidators,
    );
    check(
      "video-carries-validators-despite-no-store",
      await validators(video.relativeUrl),
      emittedValidators,
    );

    // The route never reads If-None-Match or If-Modified-Since: HttpServerResponse.file has no
    // access to the request, and the conditional logic in Effect lives only in HttpStaticServer.
    // A client that caches on the emitted strong ETag therefore re-downloads every attachment.
    check(
      "if-none-match-with-the-emitted-etag-still-returns-200",
      await read(image.relativeUrl, { headers: { "if-none-match": emittedValidators.etag } }),
      imageResponse,
    );
    check(
      "if-none-match-star-still-returns-200",
      await read(image.relativeUrl, { headers: { "if-none-match": "*" } }),
      imageResponse,
    );
    check(
      "if-modified-since-with-the-emitted-date-still-returns-200",
      await read(image.relativeUrl, {
        headers: { "if-modified-since": emittedValidators.lastModified },
      }),
      imageResponse,
    );
    check(
      "head-with-if-none-match-still-returns-200",
      await read(image.relativeUrl, {
        method: "HEAD",
        headers: { "if-none-match": emittedValidators.etag },
      }),
      { ...imageResponse, body: [] },
    );

    // If-Range is tested for presence, not validated, so any value at all — including the exact
    // ETag the route just emitted — downgrades the pinned 206 above to a full 200.
    check(
      "if-range-with-a-matching-validator-suppresses-the-range",
      await read(video.relativeUrl, {
        headers: { range: "bytes=2-4", "if-range": emittedValidators.etag },
      }),
      videoResponse,
    );
    check(
      "if-range-with-a-stale-validator-also-suppresses-the-range",
      await read(video.relativeUrl, { headers: { range: "bytes=2-4", "if-range": '"stale"' } }),
      videoResponse,
    );
    check(
      "if-range-without-range-is-ignored",
      await read(video.relativeUrl, { headers: { "if-range": emittedValidators.etag } }),
      videoResponse,
    );

    const download = {
      contentType: "application/pdf",
      cacheControl: "private, max-age=3600",
      contentSecurityPolicy: "default-src 'none'; sandbox",
    };
    check("generic-file-downloads-with-disposition", await read(pdf.relativeUrl), {
      ...fileResponse(download),
      contentDisposition: 'attachment; filename="report.pdf"',
    });
    check("unicode-file-name-is-rfc5987-encoded", await read(unicodePdf.relativeUrl), {
      ...fileResponse(download),
      contentDisposition: `attachment; filename="r_p_rt.pdf"; filename*=UTF-8''r%C3%A9p%C3%B6rt.pdf`,
    });
    check("html-inline-is-sandboxed", await read(html.relativeUrl), {
      ...fileResponse({
        contentType: "text/html; charset=utf-8",
        cacheControl: "private, max-age=3600",
        contentSecurityPolicy: "sandbox allow-scripts allow-forms allow-popups allow-modals",
      }),
      body: BODY_TEXT,
    });

    check(
      "invalid-host-is-a-bad-request",
      await read(image.relativeUrl, { headers: { host: "[" } }),
      textResponse(400, "Bad Request"),
    );
    check(
      "post-is-not-served-by-the-asset-route",
      await read(image.relativeUrl, { method: "POST" }),
      {
        status: 404,
        contentType: null,
        cacheControl: null,
        contentLength: null,
        acceptRanges: null,
        contentRange: null,
        contentDisposition: null,
        contentSecurityPolicy: null,
        nosniff: null,
        lastModifiedIsDate: false,
        etagIsStrongSizeMtime: null,
        body: [],
      },
    );
  } finally {
    await dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }

  return {
    interpretation:
      "Executed the real GET /api/assets/* handler through HttpRouter.toWebHandler with attachment claims minted by the production issueAssetUrl path, a fixed signing secret, a synthetic attachments directory and the Node HTTP platform. No listener, workspace-file or native-app claims, GitHub media fetching, authentication middleware, browser rendering or Rust implementation is exercised. Two conditional-request behaviours are recorded, not approved: the route never emits 304, because If-None-Match and If-Modified-Since are not read at all and HttpServerResponse.file has no access to the request, so a client that caches on the emitted strong ETag re-downloads every attachment; and If-Range is tested for presence rather than validated, so any value — including the exact ETag the route just emitted — turns the pinned 206 into a full 200. Headers and statuses characterize the source at this revision, not an approved contract.",
    fixturePolicy:
      "Attachment ids come from createPendingAttachmentId; every file holds the ASCII bytes abcdef so ranges, lengths and text bodies are exact. Expired and tampered tokens are re-signed with the same fixed secret. Every fixture file is pinned to a fixed mtime, including after the delete-and-rewrite row, so the emitted ETag and Last-Modified are byte-identical across runs and can be pinned as raw values rather than only as a shape.",
    knownLimitations: [
      "Only attachment claims are exercised; workspace-file, media-file-exact, project-favicon, native-app-icon and github-media claim kinds are not covered.",
      "File responses carry a strong size-mtime ETag and Last-Modified even for private, no-store video, which contradicts the media-cache intent recorded in the source; this corpus records the observed headers without approving them.",
      "Conditional request headers are exercised, but descriptor lifetime, cancellation mid-range and the weak ETag the same helper emits for host media files are covered by helper tests, not by this route corpus.",
      "Compression middleware, CORS and authentication are not mounted in this isolated router.",
    ],
    results,
  };
}
