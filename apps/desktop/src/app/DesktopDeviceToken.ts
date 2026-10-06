import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Crypto from "node:crypto";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * Device token service - generates and manages a unique token for this desktop instance.
 * The token is used to identify this device when connecting to other devices via relay.
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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const tokenCache = yield* Ref.make<string | null>(null);

  const storageKey = "deviceToken";

  const loadToken = Effect.gen(function* () {
    const cached = yield* Ref.get(tokenCache);
    if (cached !== null) {
      return cached;
    }

    // Try to load from electron-store or similar persistent storage
    // For now, generate a new token and cache it
    const token = generateToken();
    yield* Ref.set(tokenCache, token);

    // TODO: Persist to electron-store for cross-session persistence
    // This requires integration with the existing electron-store setup

    return token;
  }).pipe(Effect.withSpan("desktop.deviceToken.load"));

  const getToken = Effect.gen(function* () {
    return yield* loadToken;
  }).pipe(Effect.withSpan("desktop.deviceToken.get"));

  const regenerateToken = Effect.gen(function* () {
    const newToken = generateToken();
    yield* Ref.set(tokenCache, newToken);

    // TODO: Persist new token to electron-store

    return newToken;
  }).pipe(Effect.withSpan("desktop.deviceToken.regenerate"));

  return DesktopDeviceToken.of({
    getToken,
    regenerateToken,
  });
});

export const layer = Layer.effect(DesktopDeviceToken, make);
