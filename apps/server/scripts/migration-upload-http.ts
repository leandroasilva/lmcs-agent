import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AttachmentCreateUploadUrlInput } from "@lmcstools/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { HttpRouter } from "effect/unstable/http";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  issueAttachmentUploadUrl,
} from "../src/assets/AttachmentUpload.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "../src/auth/utils.ts";
import * as ServerConfig from "../src/config.ts";
import { attachmentUploadRouteLayer } from "../src/http.ts";

const subject = `environment: POST ${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`;

// Fixed signing key: tokens are produced by the real issuance path and then
// re-signed here only to corrupt or expire them deterministically.
const SIGNING_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const normalizeName = (name: string) => name.replace(UUID_PATTERN, "<uuid>");

const config = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return { ...base, ...overrides };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "lmcs-migration-upload-config-" }),
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
    NodeServices.layer,
  );

const issueToken = (
  service: ServerConfig.ServerConfig["Service"],
  input: AttachmentCreateUploadUrlInput,
) =>
  Effect.runPromise(
    issueAttachmentUploadUrl(input).pipe(
      Effect.provide(services(service)),
      Effect.provideService(Logger.LogToStderr, true),
    ),
  );

const tokenOf = (relativeUrl: string) =>
  relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);

const resignPayload = (token: string, mutate: (claims: Record<string, unknown>) => void) => {
  const [encodedPayload] = token.split(".");
  if (!encodedPayload) throw new Error("Expected a signed payload segment.");
  const claims = JSON.parse(base64UrlDecodeUtf8(encodedPayload)) as Record<string, unknown>;
  mutate(claims);
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${payload}.${signPayload(payload, SIGNING_SECRET)}`;
};

const streamBody = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

export async function runMigrationUploadHttp() {
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

  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lmcs-migration-upload-"));
  const attachmentsDir = NodePath.join(root, "attachments");
  await NodeFSP.mkdir(attachmentsDir, { recursive: true });
  const service = await config({ attachmentsDir });
  const { handler, dispose } = HttpRouter.toWebHandler(
    attachmentUploadRouteLayer.pipe(Layer.provideMerge(services(service))),
    { disableLogger: true },
  );

  const read = async (path: string, init?: RequestInit) => {
    const response = await handler(
      new Request(`http://migration.invalid${ATTACHMENT_UPLOAD_ROUTE_PREFIX}${path}`, init),
    );
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
      body: text,
    };
  };

  const storedFiles = async () =>
    (await NodeFSP.readdir(attachmentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => normalizeName(entry.name))
      .sort();

  const readBytes = async (name: string) => [
    ...(await NodeFSP.readFile(NodePath.join(attachmentsDir, name))),
  ];

  try {
    const issued = await issueToken(service, {
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 6,
    });
    const token = tokenOf(issued.relativeUrl);
    const imagePath = `/${token}`;

    check("missing-token-is-not-found", await read("/", { method: "POST" }), {
      status: 404,
      contentType: "text/plain",
      contentLength: String(new TextEncoder().encode("Not Found").byteLength),
      body: "Not Found",
    });
    check("malformed-token-is-not-found", await read("/garbage", { method: "POST" }), {
      status: 404,
      contentType: "text/plain",
      contentLength: String(new TextEncoder().encode("Not Found").byteLength),
      body: "Not Found",
    });

    const [payload, signature] = token.split(".");
    const tamperedSignature = `${payload}.${signature?.slice(0, -2)}aa`;
    check(
      "tampered-signature-is-not-found",
      await read(`/${tamperedSignature}`, { method: "POST" }),
      {
        status: 404,
        contentType: "text/plain",
        contentLength: String(new TextEncoder().encode("Not Found").byteLength),
        body: "Not Found",
      },
    );
    check("extra-token-segment-is-not-found", await read(`/${token}.extra`, { method: "POST" }), {
      status: 404,
      contentType: "text/plain",
      contentLength: String(new TextEncoder().encode("Not Found").byteLength),
      body: "Not Found",
    });
    const expiredToken = resignPayload(token, (claims) => {
      claims.expiresAt = 0;
    });
    check("expired-token-is-not-found", await read(`/${expiredToken}`, { method: "POST" }), {
      status: 404,
      contentType: "text/plain",
      contentLength: String(new TextEncoder().encode("Not Found").byteLength),
      body: "Not Found",
    });

    const mismatchMessage = "Content-Length must match the upload size.";
    check(
      "content-length-mismatch-is-rejected",
      await read(imagePath, {
        method: "POST",
        headers: { "content-length": "5" },
        body: streamBody(new Uint8Array([1, 2, 3, 4, 5])),
        duplex: "half",
      } as RequestInit),
      {
        status: 400,
        contentType: "text/plain",
        contentLength: String(new TextEncoder().encode(mismatchMessage).byteLength),
        body: mismatchMessage,
      },
    );
    check(
      "fractional-content-length-is-rejected",
      await read(imagePath, {
        method: "POST",
        headers: { "content-length": "6.5" },
        body: streamBody(new Uint8Array(6)),
        duplex: "half",
      } as RequestInit),
      {
        status: 400,
        contentType: "text/plain",
        contentLength: String(new TextEncoder().encode(mismatchMessage).byteLength),
        body: mismatchMessage,
      },
    );

    check(
      "exact-body-is-stored",
      await read(imagePath, {
        method: "POST",
        headers: { "content-length": "6" },
        body: new Uint8Array([1, 2, 3, 4, 5, 6]),
      }),
      {
        status: 204,
        contentType: null,
        contentLength: null,
        body: "",
      },
    );
    check(
      "exact-body-writes-one-complete-file",
      {
        files: await storedFiles(),
        bytes: await readBytes(`${issued.attachmentId}.png`),
      },
      {
        files: ["pending-<uuid>.png"],
        bytes: [1, 2, 3, 4, 5, 6],
      },
    );
    await NodeFSP.rm(NodePath.join(attachmentsDir, `${issued.attachmentId}.png`));

    const chunked = await issueToken(service, {
      name: "chunked.png",
      mimeType: "image/png",
      sizeBytes: 6,
    });
    check(
      "chunked-body-without-content-length-is-stored",
      await read(`/${tokenOf(chunked.relativeUrl)}`, {
        method: "POST",
        body: streamBody(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        duplex: "half",
      } as RequestInit),
      {
        status: 204,
        contentType: null,
        contentLength: null,
        body: "",
      },
    );
    check(
      "chunked-body-writes-concatenated-bytes",
      {
        bytes: await readBytes(`${chunked.attachmentId}.png`),
      },
      {
        bytes: [1, 2, 3, 4, 5, 6],
      },
    );
    await NodeFSP.rm(NodePath.join(attachmentsDir, `${chunked.attachmentId}.png`));

    const shortMessage = "Body was 3 bytes, expected 6.";
    check(
      "short-body-is-rejected",
      await read(imagePath, {
        method: "POST",
        body: streamBody(new Uint8Array([1, 2, 3])),
        duplex: "half",
      } as RequestInit),
      {
        status: 400,
        contentType: "text/plain",
        contentLength: String(new TextEncoder().encode(shortMessage).byteLength),
        body: shortMessage,
      },
    );
    const longMessage = "Body was 7 bytes, expected 6.";
    check(
      "long-body-is-rejected",
      await read(imagePath, {
        method: "POST",
        body: streamBody(new Uint8Array(7)),
        duplex: "half",
      } as RequestInit),
      {
        status: 400,
        contentType: "text/plain",
        contentLength: String(new TextEncoder().encode(longMessage).byteLength),
        body: longMessage,
      },
    );
    check("rejected-bodies-leave-no-files", await storedFiles(), []);

    const empty = await issueToken(service, {
      name: "empty.png",
      mimeType: "image/png",
      sizeBytes: 0,
    });
    check(
      "zero-size-upload-is-stored",
      await read(`/${tokenOf(empty.relativeUrl)}`, {
        method: "POST",
        headers: { "content-length": "0" },
        body: new Uint8Array(0),
      }),
      {
        status: 204,
        contentType: null,
        contentLength: null,
        body: "",
      },
    );
    check(
      "zero-size-upload-writes-empty-file",
      {
        files: await storedFiles(),
        bytes: await readBytes(`${empty.attachmentId}.png`),
      },
      {
        files: ["pending-<uuid>.png"],
        bytes: [],
      },
    );
    await NodeFSP.rm(NodePath.join(attachmentsDir, `${empty.attachmentId}.png`));

    const pdf = await issueToken(service, {
      type: "file",
      name: "report.PDF",
      mimeType: "application/pdf",
      sizeBytes: 6,
    });
    check(
      "file-upload-is-stored",
      await read(`/${tokenOf(pdf.relativeUrl)}`, {
        method: "POST",
        headers: { "content-length": "6" },
        body: new Uint8Array([1, 2, 3, 4, 5, 6]),
      }),
      {
        status: 204,
        contentType: null,
        contentLength: null,
        body: "",
      },
    );
    check(
      "file-upload-keeps-lowercased-extension",
      {
        files: await storedFiles(),
      },
      {
        files: ["pending-<uuid>-pdf.pdf"],
      },
    );

    check("get-is-not-served-by-this-route", await read(imagePath), {
      status: 404,
      contentType: null,
      contentLength: null,
      body: "",
    });
  } finally {
    await dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }

  return {
    interpretation:
      "Executed the real POST /api/attachments/upload/* handler through HttpRouter.toWebHandler with a fixed signing secret, a synthetic temporary attachments directory and the production issuance path for tokens. No listener, authentication middleware, provider attachment ingestion, real uploads or Rust implementation is exercised. Status codes and body texts characterize the source at this revision, not an approved contract.",
    fixturePolicy:
      "Attachment IDs are random UUIDs produced by issueAttachmentUploadUrl; file names are normalized to <uuid> so checks stay deterministic. Signed payloads are re-signed with the same fixed secret only to construct expired and tampered tokens.",
    knownLimitations: [
      "Token expiry is exercised by rewriting expiresAt and re-signing; no clock advance or TTL boundary is covered.",
      "Uploads are consumed from in-process streams; real network chunking, proxies, cancellation mid-body and slow clients are not covered.",
      "Replacing an existing attachment file is not exercised because rename-over-existing differs across platforms.",
      "Thread-owned attachment ingestion, attachment deletion and asset download of the stored file are not covered.",
    ],
    results,
  };
}
