import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDeviceToken from "../../app/DesktopDeviceToken.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getDeviceToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_DEVICE_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.deviceToken.get")(function* () {
    const deviceToken = yield* DesktopDeviceToken.DesktopDeviceToken;
    return yield* deviceToken.getToken;
  }),
});

export const regenerateDeviceToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REGENERATE_DEVICE_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.deviceToken.regenerate")(function* () {
    const deviceToken = yield* DesktopDeviceToken.DesktopDeviceToken;
    return yield* deviceToken.regenerateToken;
  }),
});
