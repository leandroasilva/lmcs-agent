import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Crypto from "node:crypto";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * Device token service - generates and manages a unique token for this desktop instance.
 * The token is used to identify this device when connecting to other devices via relay.
 * Persists to a JSON file in the user data directory for cross-session persistence.
 */

export class DeviceTokenStorageError extends Schema.TaggedError<DeviceTokenStorageError>()(
  "DeviceTokenStorageError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read/write device token.`;
  }
}

export class DesktopDeviceToken extends Context.Service<
  DesktopDeviceToken,
  {
    readonly getToken: Effect.Effect<string, DeviceTokenStorageError>;
    readonly regenerateToken: Effect.Effect<string, DeviceTokenStorageError>;
  }
>()("@lmcstools/desktop/app/DesktopDeviceToken") {}

const generateToken = (): string => {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
};

const TOKEN_FILE_NAME = "device-token.json";

interface DeviceTokenFile {
  readonly token: string;
}

const DeviceTokenFileSchema = Schema.Struct({
  token: Schema.String,
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tokenCache = yield* Ref.make<string | null>(null);

  const userDataPath = yield* Effect.tryPromise({
    try: () => electronApp.getPath("userData"),
    catch: (cause) => new DeviceTokenStorageError({ cause }),
  });

  const tokenFilePath = path.join(userDataPath, TOKEN_FILE_NAME);

  const loadTokenFromFile = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(tokenFilePath)
      .pipe(Effect.catch(() => Effect.succeed(false)));

    if (!exists) {
      return null;
    }

    const content = yield* fileSystem
      .readFileString(tokenFilePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));

    if (!content) {
      return null;
    }

    const parsed = Schema.decodeUnknownSync(DeviceTokenFileSchema)(JSON.parse(content));
    return parsed.token;
  }).pipe(Effect.withSpan("desktop.deviceToken.loadFromFile"));

  const saveTokenToFile = (token: string) =>
    Effect.gen(function* () {
      const data: DeviceTokenFile = { token };
      const content = JSON.stringify(data, null, 2);
      yield* fileSystem
        .writeFileString(tokenFilePath, content)
        .pipe(Effect.catch((cause) => new DeviceTokenStorageError({ cause })));
    }).pipe(Effect.withSpan("desktop.deviceToken.saveToFile"));

  const loadToken = Effect.gen(function* () {
    const cached = yield* Ref.get(tokenCache);
    if (cached !== null) {
      return cached;
    }

    // Try to load from file
    const fileToken = yield* loadTokenFromFile;

    if (fileToken) {
      yield* Ref.set(tokenCache, fileToken);
      return fileToken;
    }

    // Generate new token and save to file
    const token = generateToken();
    yield* saveTokenToFile(token);
    yield* Ref.set(tokenCache, token);

    return token;
  }).pipe(Effect.withSpan("desktop.deviceToken.load"));

  const getToken = Effect.gen(function* () {
    return yield* loadToken;
  }).pipe(Effect.withSpan("desktop.deviceToken.get"));

  const regenerateToken = Effect.gen(function* () {
    const newToken = generateToken();
    yield* saveTokenToFile(newToken);
    yield* Ref.set(tokenCache, newToken);

    return newToken;
  }).pipe(Effect.withSpan("desktop.deviceToken.regenerate"));

  return DesktopDeviceToken.of({
    getToken,
    regenerateToken,
  });
});

export const layer = Layer.effect(DesktopDeviceToken, make);
