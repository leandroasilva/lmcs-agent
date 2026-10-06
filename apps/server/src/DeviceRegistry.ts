/**
 * Device registry - tracks connected devices and their tokens for P2P relay.
 *
 * This is an in-memory registry for now. For production, this should be backed
 * by Redis or the database to support multi-instance deployments.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export interface DeviceInfo {
  readonly deviceId: string;
  readonly token: string;
  readonly name: string;
  readonly platform: string;
  readonly registeredAt: number;
  readonly lastSeenAt: number;
  readonly connected: boolean;
}

export class DeviceRegistry extends Context.Service<
  DeviceRegistry,
  {
    readonly registerDevice: (device: {
      deviceId: string;
      token: string;
      name: string;
      platform: string;
    }) => Effect.Effect<DeviceInfo>;
    readonly unregisterDevice: (deviceId: string) => Effect.Effect<void>;
    readonly getDevice: (deviceId: string) => Effect.Effect<DeviceInfo | null>;
    readonly getDeviceByToken: (token: string) => Effect.Effect<DeviceInfo | null>;
    readonly listDevices: () => Effect.Effect<readonly DeviceInfo[]>;
    readonly updateDevicePresence: (deviceId: string) => Effect.Effect<void>;
  }
>()("@lmcstools/server/DeviceRegistry") {}

export const make = Effect.gen(function* () {
  const devices = yield* Ref.make<Map<string, DeviceInfo>>(new Map());

  const registerDevice = Effect.fn("DeviceRegistry.registerDevice")(function* (device: {
    deviceId: string;
    token: string;
    name: string;
    platform: string;
  }) {
    const now = Date.now();
    const info: DeviceInfo = {
      deviceId: device.deviceId,
      token: device.token,
      name: device.name,
      platform: device.platform,
      registeredAt: now,
      lastSeenAt: now,
      connected: true,
    };

    yield* Ref.update(devices, (map) => {
      const newMap = new Map(map);
      newMap.set(device.deviceId, info);
      return newMap;
    });

    return info;
  });

  const unregisterDevice = Effect.fn("DeviceRegistry.unregisterDevice")(function* (
    deviceId: string,
  ) {
    yield* Ref.update(devices, (map) => {
      const newMap = new Map(map);
      newMap.delete(deviceId);
      return newMap;
    });
  });

  const getDevice = Effect.fn("DeviceRegistry.getDevice")(function* (deviceId: string) {
    const map = yield* Ref.get(devices);
    return map.get(deviceId) ?? null;
  });

  const getDeviceByToken = Effect.fn("DeviceRegistry.getDeviceByToken")(function* (token: string) {
    const map = yield* Ref.get(devices);
    for (const device of map.values()) {
      if (device.token === token) {
        return device;
      }
    }
    return null;
  });

  const listDevices = Effect.fn("DeviceRegistry.listDevices")(function* () {
    const map = yield* Ref.get(devices);
    return Array.from(map.values());
  });

  const updateDevicePresence = Effect.fn("DeviceRegistry.updateDevicePresence")(function* (
    deviceId: string,
  ) {
    yield* Ref.update(devices, (map) => {
      const device = map.get(deviceId);
      if (!device) return map;

      const newMap = new Map(map);
      newMap.set(deviceId, {
        ...device,
        lastSeenAt: Date.now(),
        connected: true,
      });
      return newMap;
    });
  });

  return DeviceRegistry.of({
    registerDevice,
    unregisterDevice,
    getDevice,
    getDeviceByToken,
    listDevices,
    updateDevicePresence,
  });
});

export const layer = Layer.effect(DeviceRegistry, make);
