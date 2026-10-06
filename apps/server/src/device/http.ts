/**
 * Device registry HTTP API - endpoints for registering and listing devices.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as DeviceRegistry from "../DeviceRegistry.ts";

/**
 * POST /api/devices - Register a device
 */
export const registerDeviceRouteLayer = HttpRouter.add(
  "POST",
  "/api/devices",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const registry = yield* DeviceRegistry.DeviceRegistry;

    const body = yield* request.json;
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({
        deviceId: Schema.String,
        token: Schema.String,
        name: Schema.String,
        platform: Schema.String,
      }),
    )(body);

    const device = yield* registry.registerDevice(parsed);
    return yield* HttpServerResponse.json(device);
  }),
);

/**
 * GET /api/devices - List all devices
 */
export const listDevicesRouteLayer = HttpRouter.add(
  "GET",
  "/api/devices",
  Effect.gen(function* () {
    const registry = yield* DeviceRegistry.DeviceRegistry;
    const devices = yield* registry.listDevices();
    return yield* HttpServerResponse.json({ devices });
  }),
);

/**
 * GET /api/devices/by-token/:token - Get device by token
 */
export const getDeviceByTokenRouteLayer = HttpRouter.add(
  "GET",
  "/api/devices/by-token/:token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const registry = yield* DeviceRegistry.DeviceRegistry;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return yield* HttpServerResponse.json({ error: "Bad Request" }, { status: 400 });
    }

    const parts = url.value.pathname.split("/");
    const token = parts[parts.length - 1] ?? "";

    const device = yield* registry.getDeviceByToken(token);
    if (!device) {
      return yield* HttpServerResponse.json({ error: "Device not found" }, { status: 404 });
    }
    return yield* HttpServerResponse.json(device);
  }),
);

/**
 * GET /api/devices/:deviceId - Get device by ID
 */
export const getDeviceRouteLayer = HttpRouter.add(
  "GET",
  "/api/devices/:deviceId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const registry = yield* DeviceRegistry.DeviceRegistry;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return yield* HttpServerResponse.json({ error: "Bad Request" }, { status: 400 });
    }

    const parts = url.value.pathname.split("/");
    const deviceId = parts[parts.length - 1] ?? "";

    const device = yield* registry.getDevice(deviceId);
    if (!device) {
      return yield* HttpServerResponse.json({ error: "Device not found" }, { status: 404 });
    }
    return yield* HttpServerResponse.json(device);
  }),
);

/**
 * Combined device routes layer
 */
export const deviceRoutesLayer = Layer.mergeAll(
  registerDeviceRouteLayer,
  listDevicesRouteLayer,
  getDeviceByTokenRouteLayer,
  getDeviceRouteLayer,
);
