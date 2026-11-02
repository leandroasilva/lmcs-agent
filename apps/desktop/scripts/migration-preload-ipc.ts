#!/usr/bin/env node
/**
 * Phase 0 baseline corpus for the Electron IPC boundary in both directions.
 *
 * The shipped preload guards are closures inside `contextBridge.exposeInMainWorld`, so they
 * cannot be imported directly: the module also touches `electron`, Clerk's preload bridge and
 * renderer globals. This script registers a Node module hook that substitutes an in-memory
 * `electron` stub, imports the real preload entry points (desktop bridge, PiP bridge and the macOS
 * permission panel), drives the captured listeners with synthetic payloads for the main -> renderer
 * direction, and calls every bridge request method to record the channel and argument envelope the
 * shipped wrapper hands to `ipcRenderer.invoke`/`sendSync` for the renderer -> main direction.
 * Because the stub only exists for Node's own loader, the corpus runs itself as a child process so
 * `node scripts/migration-baseline.ts` and Vitest get the same report.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

const EMIT_FLAG = "--emit-preload-ipc-corpus";
const STUB_MARK = "virtual:lmcs-migration-electron";
const root = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));

interface Registration {
  readonly channel: string;
  readonly handler: (event: unknown, ...args: unknown[]) => void;
}

interface Send {
  readonly channel: string;
  readonly args: unknown[];
}

interface Request {
  readonly kind: "invoke" | "sendSync";
  readonly channel: string;
  readonly args: unknown[];
}

interface DomListener {
  readonly target: string;
  readonly type: string;
  readonly handler: (event: SyntheticEvent) => void;
}

interface SyntheticEvent {
  readonly type: string;
  readonly key?: string;
  readonly preventDefault: () => void;
}

interface StubState {
  readonly registrations: Registration[];
  readonly bridges: Record<string, Record<string, unknown>>;
  readonly sends: Send[];
  readonly requests: Request[];
  readonly syncResults: Record<string, unknown>;
  readonly promiseResults: Record<string, unknown>;
  readonly domListeners: DomListener[];
  readonly elementLookups: string[];
}

declare global {
  var __lmcsMigrationPreloadIpc: StubState | undefined;
}

const electronStub = `
const state = globalThis.__lmcsMigrationPreloadIpc;
export const contextBridge = {
  exposeInMainWorld: (name, value) => {
    state.bridges[name] = value;
  },
};
export const ipcRenderer = {
  on: (channel, handler) => {
    state.registrations.push({ channel, handler });
    return ipcRenderer;
  },
  removeListener: (channel, handler) => {
    const index = state.registrations.findIndex(
      (entry) => entry.channel === channel && entry.handler === handler,
    );
    if (index >= 0) state.registrations.splice(index, 1);
    return ipcRenderer;
  },
  sendSync: (channel, ...args) => {
    state.requests.push({ kind: "sendSync", channel, args });
    return Object.prototype.hasOwnProperty.call(state.syncResults, channel)
      ? state.syncResults[channel]
      : null;
  },
  invoke: async (channel, ...args) => {
    state.requests.push({ kind: "invoke", channel, args });
    if (Object.prototype.hasOwnProperty.call(state.promiseResults, channel)) {
      return state.promiseResults[channel];
    }
    return null;
  },
  send: (channel, ...args) => {
    state.sends.push({ channel, args });
  },
};
export const webFrame = { getZoomFactor: () => 1, setZoomFactor: () => {} };
export const webUtils = { getPathForFile: () => "" };
`;

const clerkStub = `
export const exposeClerkBridge = () => {};
`;

const installStubLoader = () => {
  NodeModule.registerHooks({
    resolve(specifier, _context, nextResolve) {
      if (specifier === "electron" || specifier === "@clerk/electron/preload") {
        return {
          url: `${STUB_MARK}?name=${encodeURIComponent(specifier)}`,
          shortCircuit: true,
          format: "module",
        };
      }
      return nextResolve(specifier as string);
    },
    load(url, _context, nextLoad) {
      if (typeof url === "string" && url.startsWith(STUB_MARK)) {
        const name = new globalThis.URL(url).searchParams.get("name");
        return {
          format: "module",
          source: name === "electron" ? electronStub : clerkStub,
          shortCircuit: true,
        };
      }
      return nextLoad(url as string);
    },
  });
};

const installRendererGlobals = () => {
  const state = globalThis.__lmcsMigrationPreloadIpc!;
  const listen = (target: string) => (type: string, handler: (event: SyntheticEvent) => void) => {
    state.domListeners.push({ target, type, handler });
  };
  (globalThis as { document?: unknown }).document = {
    documentElement: { style: { setProperty: () => {} } },
    addEventListener: listen("document"),
    removeEventListener: () => {},
    getElementById: (id: string) => {
      state.elementLookups.push(id);
      // Only the panel's own buttons exist; anything else behaves like a missing element.
      return id === "app" || id === "close" ? { addEventListener: listen(`#${id}`) } : null;
    },
  };
  (globalThis as { window?: unknown }).window = {
    addEventListener: listen("window"),
    removeEventListener: () => {},
  };
};

/** Fires the listeners the shipped preloads registered on window/document/elements. */
const fire = (state: StubState, target: string, type: string, key?: string) => {
  const listeners = state.domListeners.filter(
    (entry) => entry.target === target && entry.type === type,
  );
  const preventDefaultCalls: string[] = [];
  for (const entry of listeners) {
    entry.handler({
      type,
      ...(key === undefined ? {} : { key }),
      preventDefault: () => preventDefaultCalls.push(type),
    });
  }
  return { fired: listeners.length, preventDefaultCalls, sends: [...state.sends] };
};

const decodeAccepted = (schema: Schema.Constraint, value: unknown) => Schema.is(schema)(value);

async function buildReport() {
  const results: {
    id: string;
    subject: string;
    passed: boolean;
    expected: unknown;
    actual: unknown;
  }[] = [];
  const check = (id: string, subject: string, actual: unknown, expected: unknown) => {
    results.push({
      id,
      subject,
      passed: NodeUtil.isDeepStrictEqual(actual, expected),
      expected,
      actual,
    });
  };

  globalThis.__lmcsMigrationPreloadIpc = {
    registrations: [],
    bridges: {},
    sends: [],
    requests: [],
    syncResults: {},
    promiseResults: {},
    domListeners: [],
    elementLookups: [],
  };
  installStubLoader();
  installRendererGlobals();

  await import("../src/preload.ts");
  await import("../src/preview-pip-preload.ts");
  await import("../src/mac-permission-preload.ts");

  const state = globalThis.__lmcsMigrationPreloadIpc!;
  const bridge = state.bridges.desktopBridge as Record<string, unknown>;
  const pipBridge = state.bridges.previewPictureInPicture as Record<string, unknown>;
  const IpcChannels = await import("../src/ipc/channels.ts");
  const constantByChannel = new Map<string, string>();
  for (const [name, channel] of Object.entries(IpcChannels as Record<string, unknown>)) {
    if (name.endsWith("_CHANNEL") && typeof channel === "string") {
      constantByChannel.set(channel, name);
    }
  }

  type Subscribe = (listener: (...args: unknown[]) => void) => () => void;

  /** Subscribes through the real preload method, emits the payload, and reports what arrived. */
  const probe = (
    subject: string,
    subscribe: Subscribe,
    payloads: unknown[][],
    options: { readonly disposeBeforeEmit?: boolean; readonly subscriptions?: number } = {},
  ) => {
    const received: unknown[][] = [];
    const listener = (...args: unknown[]) => {
      received.push(args);
    };
    const disposers: Array<() => void> = [];
    const start = state.registrations.length;
    for (let index = 0; index < (options.subscriptions ?? 1); index += 1) {
      const dispose = subscribe(listener);
      if (typeof dispose === "function") disposers.push(dispose);
    }
    const registered = state.registrations.slice(start).map((entry) => entry.channel);
    const channels = [...new Set(registered)];
    if (options.disposeBeforeEmit === true) {
      for (const dispose of disposers) dispose();
    }
    for (const payload of payloads) {
      for (const channel of channels) {
        for (const entry of state.registrations.filter((item) => item.channel === channel)) {
          entry.handler({ sender: null }, ...payload);
        }
      }
    }
    if (options.disposeBeforeEmit !== true) {
      for (const dispose of disposers) dispose();
    }
    return {
      subject,
      channel: channels[0] ?? "",
      channels,
      deliveries: received.length,
      args: received,
    };
  };

  const nested = (path: string[], method: string): Subscribe => {
    let target: unknown = bridge;
    for (const key of path) target = (target as Record<string, unknown>)[key];
    return (target as Record<string, Subscribe>)[method] as Subscribe;
  };

  const menuAction = bridge.onMenuAction as Subscribe;
  const snapShotEvent = bridge.onSnapShotEvent as Subscribe;
  const quitShortcut = bridge.onQuitShortcut as Subscribe;
  const trackpadScrollEnd = bridge.onTrackpadScrollEnd as Subscribe;
  const notificationBadgeClear = bridge.onNotificationBadgeClear as Subscribe;
  const windowFullscreen = bridge.onWindowFullscreenStateChange as Subscribe;
  const sshPasswordPrompt = bridge.onSshPasswordPrompt as Subscribe;
  const updateState = bridge.onUpdateState as Subscribe;
  const activationRequest = nested(["appActivation"], "onRequest");
  const previewStateChange = nested(["preview"], "onStateChange");
  const previewPointerEvent = nested(["preview"], "onPointerEvent");
  const recordingInput = nested(["preview", "recording"], "onInput");
  const recordingFrame = nested(["preview", "recording"], "onFrame");
  const pipFrame = pipBridge.onFrame as Subscribe;

  const channelMap = {
    onMenuAction: probe("desktopBridge.onMenuAction", menuAction, [["copy"]]).channel,
    onSnapShotEvent: probe("desktopBridge.onSnapShotEvent", snapShotEvent, [
      [{ type: "requested", id: "0a1b2c3d" }],
    ]).channel,
    onQuitShortcut: probe("desktopBridge.onQuitShortcut", quitShortcut, [[{ state: "up" }]])
      .channel,
    onTrackpadScrollEnd: probe("desktopBridge.onTrackpadScrollEnd", trackpadScrollEnd, [[]])
      .channel,
    onNotificationBadgeClear: probe(
      "desktopBridge.onNotificationBadgeClear",
      notificationBadgeClear,
      [[]],
    ).channel,
    onWindowFullscreenStateChange: probe(
      "desktopBridge.onWindowFullscreenStateChange",
      windowFullscreen,
      [[true]],
    ).channel,
    onSshPasswordPrompt: probe("desktopBridge.onSshPasswordPrompt", sshPasswordPrompt, [[{}]])
      .channel,
    onUpdateState: probe("desktopBridge.onUpdateState", updateState, [[{}]]).channel,
    "appActivation.onRequest": probe("desktopBridge.appActivation.onRequest", activationRequest, [
      [{}],
    ]).channel,
    "preview.onStateChange": probe("desktopBridge.preview.onStateChange", previewStateChange, [
      ["tab-1", {}],
    ]).channel,
    "preview.onPointerEvent": probe("desktopBridge.preview.onPointerEvent", previewPointerEvent, [
      [{}],
    ]).channel,
    "preview.recording.onInput": probe("desktopBridge.preview.recording.onInput", recordingInput, [
      [{}],
    ]).channel,
    "preview.recording.onFrame": probe("desktopBridge.preview.recording.onFrame", recordingFrame, [
      [{}],
    ]).channel,
    "previewPictureInPicture.onFrame": probe("previewPictureInPicture.onFrame", pipFrame, [[{}]])
      .channel,
  };
  check("event-channel-identity", "desktop preload event channels", channelMap, {
    onMenuAction: "desktop:menu-action",
    onSnapShotEvent: "desktop:snap-shot-event",
    onQuitShortcut: "desktop:quit-shortcut",
    onTrackpadScrollEnd: "desktop:trackpad-scroll-end",
    onNotificationBadgeClear: "desktop:set-notification-badge",
    onWindowFullscreenStateChange: "desktop:window-fullscreen-state",
    onSshPasswordPrompt: "desktop:ssh-password-prompt",
    onUpdateState: "desktop:update-state",
    "appActivation.onRequest": "desktop:app-activation-request",
    "preview.onStateChange": "desktop:preview-state-change",
    "preview.onPointerEvent": "desktop:preview-pointer-event",
    "preview.recording.onInput": "desktop:preview-recording-input",
    "preview.recording.onFrame": "desktop:preview-recording-frame",
    "previewPictureInPicture.onFrame": "desktop:preview-pip-frame",
  });
  check(
    "both-bridges-are-exposed",
    "desktop preload bridge names",
    Object.keys(state.bridges).sort(),
    ["desktopBridge", "previewPictureInPicture"],
  );

  const delivery = (subject: string, subscribe: Subscribe, payload: unknown[]) => {
    const observed = probe(subject, subscribe, [payload]);
    return { deliveries: observed.deliveries, args: observed.args };
  };

  check(
    "menu-action-forwards-strings",
    "desktopBridge.onMenuAction",
    delivery("desktopBridge.onMenuAction", menuAction, ["open-settings"]),
    { deliveries: 1, args: [["open-settings"]] },
  );
  for (const [id, value] of [
    ["menu-action-drops-numbers", 7],
    ["menu-action-drops-objects", { action: "open-settings" }],
    ["menu-action-drops-null", null],
    ["menu-action-drops-undefined", undefined],
  ] as const) {
    check(
      id,
      "desktopBridge.onMenuAction",
      delivery("desktopBridge.onMenuAction", menuAction, [value]),
      { deliveries: 0, args: [] },
    );
  }

  check(
    "snap-shot-forwards-schema-valid-event",
    "desktopBridge.onSnapShotEvent",
    delivery("desktopBridge.onSnapShotEvent", snapShotEvent, [
      { type: "ready", id: "0a1b2c3d-4e5f" },
    ]),
    { deliveries: 1, args: [[{ type: "ready", id: "0a1b2c3d-4e5f" }]] },
  );
  check(
    "snap-shot-forwards-payload-unchanged-with-extra-fields",
    "desktopBridge.onSnapShotEvent",
    delivery("desktopBridge.onSnapShotEvent", snapShotEvent, [
      { type: "shortcut-changed", id: "anything", extra: true },
    ]),
    {
      deliveries: 1,
      args: [[{ type: "shortcut-changed", id: "anything", extra: true }]],
    },
  );
  for (const [id, value] of [
    ["snap-shot-drops-unknown-type", { type: "cancelled", id: "0a1b2c3d" }],
    ["snap-shot-drops-non-string-id", { type: "ready", id: 42 }],
    ["snap-shot-drops-array", [1, 2]],
    ["snap-shot-drops-string", "ready"],
    ["snap-shot-drops-null", null],
  ] as const) {
    check(
      id,
      "desktopBridge.onSnapShotEvent",
      delivery("desktopBridge.onSnapShotEvent", snapShotEvent, [value]),
      { deliveries: 0, args: [] },
    );
  }
  check(
    "snap-shot-forwards-null-payload-shape",
    "desktopBridge.onSnapShotEvent",
    delivery("desktopBridge.onSnapShotEvent", snapShotEvent, [{ type: "failed" }]),
    { deliveries: 1, args: [[{ type: "failed" }]] },
  );

  check(
    "quit-shortcut-reconstructs-up-hint",
    "desktopBridge.onQuitShortcut",
    delivery("desktopBridge.onQuitShortcut", quitShortcut, [{ state: "up", extra: "dropped" }]),
    { deliveries: 1, args: [[{ state: "up" }]] },
  );
  check(
    "quit-shortcut-keeps-down-mode",
    "desktopBridge.onQuitShortcut",
    delivery("desktopBridge.onQuitShortcut", quitShortcut, [{ state: "down", mode: "hold" }]),
    { deliveries: 1, args: [[{ state: "down", mode: "hold" }]] },
  );
  for (const [id, value] of [
    ["quit-shortcut-drops-missing-state", { mode: "hold" }],
    ["quit-shortcut-drops-unknown-mode", { state: "down", mode: "triple-click" }],
    ["quit-shortcut-drops-down-without-mode", { state: "down" }],
    ["quit-shortcut-drops-string", "up"],
  ] as const) {
    check(
      id,
      "desktopBridge.onQuitShortcut",
      delivery("desktopBridge.onQuitShortcut", quitShortcut, [value]),
      { deliveries: 0, args: [] },
    );
  }

  check(
    "trackpad-scroll-end-invokes-zero-argument-listener",
    "desktopBridge.onTrackpadScrollEnd",
    delivery("desktopBridge.onTrackpadScrollEnd", trackpadScrollEnd, [[]]),
    { deliveries: 1, args: [[]] },
  );
  check(
    "trackpad-scroll-end-ignores-payload",
    "desktopBridge.onTrackpadScrollEnd",
    delivery("desktopBridge.onTrackpadScrollEnd", trackpadScrollEnd, [["ignored", { a: 1 }]]),
    { deliveries: 1, args: [[]] },
  );
  check(
    "notification-badge-clear-invokes-zero-argument-listener",
    "desktopBridge.onNotificationBadgeClear",
    delivery("desktopBridge.onNotificationBadgeClear", notificationBadgeClear, [[]]),
    { deliveries: 1, args: [[]] },
  );

  check(
    "window-fullscreen-forwards-booleans",
    "desktopBridge.onWindowFullscreenStateChange",
    delivery("desktopBridge.onWindowFullscreenStateChange", windowFullscreen, [false]),
    { deliveries: 1, args: [[false]] },
  );
  for (const [id, value] of [
    ["window-fullscreen-drops-strings", "true"],
    ["window-fullscreen-drops-numbers", 1],
    ["window-fullscreen-drops-null", null],
  ] as const) {
    check(
      id,
      "desktopBridge.onWindowFullscreenStateChange",
      delivery("desktopBridge.onWindowFullscreenStateChange", windowFullscreen, [value]),
      { deliveries: 0, args: [] },
    );
  }

  check(
    "ssh-password-prompt-forwards-any-object",
    "desktopBridge.onSshPasswordPrompt",
    delivery("desktopBridge.onSshPasswordPrompt", sshPasswordPrompt, [{ requestId: "req-1" }]),
    { deliveries: 1, args: [[{ requestId: "req-1" }]] },
  );
  check(
    "ssh-password-prompt-drops-empty-object",
    "desktopBridge.onSshPasswordPrompt",
    delivery("desktopBridge.onSshPasswordPrompt", sshPasswordPrompt, [{}]),
    { deliveries: 1, args: [[{}]] },
  );
  check(
    "ssh-password-prompt-drops-non-object",
    "desktopBridge.onSshPasswordPrompt",
    delivery("desktopBridge.onSshPasswordPrompt", sshPasswordPrompt, ["prompt"]),
    { deliveries: 0, args: [] },
  );

  check(
    "update-state-forwards-any-object",
    "desktopBridge.onUpdateState",
    delivery("desktopBridge.onUpdateState", updateState, [{}]),
    { deliveries: 1, args: [[{}]] },
  );
  check(
    "activation-request-forwards-any-object",
    "desktopBridge.appActivation.onRequest",
    delivery("desktopBridge.appActivation.onRequest", activationRequest, [{}]),
    { deliveries: 1, args: [[{}]] },
  );

  check(
    "preview-state-change-uses-two-positional-arguments",
    "desktopBridge.preview.onStateChange",
    delivery("desktopBridge.preview.onStateChange", previewStateChange, [
      "tab-1",
      { isLoading: true },
    ]),
    { deliveries: 1, args: [["tab-1", { isLoading: true }]] },
  );
  for (const [id, args] of [
    ["preview-state-change-drops-single-argument", [{ isLoading: true }]],
    ["preview-state-change-drops-non-string-tab", [1, {}]],
    ["preview-state-change-drops-missing-state", ["tab-1"]],
    ["preview-state-change-drops-null-state", ["tab-1", null]],
  ] as const) {
    check(
      id,
      "desktopBridge.preview.onStateChange",
      delivery("desktopBridge.preview.onStateChange", previewStateChange, [args]),
      { deliveries: 0, args: [] },
    );
  }

  check(
    "preview-pointer-event-forwards-any-object",
    "desktopBridge.preview.onPointerEvent",
    delivery("desktopBridge.preview.onPointerEvent", previewPointerEvent, [{}]),
    { deliveries: 1, args: [[{}]] },
  );
  check(
    "recording-input-forwards-any-object",
    "desktopBridge.preview.recording.onInput",
    delivery("desktopBridge.preview.recording.onInput", recordingInput, [{ type: "bogus" }]),
    { deliveries: 1, args: [[{ type: "bogus" }]] },
  );
  check(
    "recording-frame-forwards-any-object",
    "desktopBridge.preview.recording.onFrame",
    delivery("desktopBridge.preview.recording.onFrame", recordingFrame, [{}]),
    { deliveries: 1, args: [[{}]] },
  );
  check(
    "pip-frame-forwards-any-object",
    "previewPictureInPicture.onFrame",
    delivery("previewPictureInPicture.onFrame", pipFrame, [{}]),
    { deliveries: 1, args: [[{}]] },
  );
  check(
    "pip-frame-drops-non-object",
    "previewPictureInPicture.onFrame",
    delivery("previewPictureInPicture.onFrame", pipFrame, ["frame"]),
    { deliveries: 0, args: [] },
  );

  // The macOS permission panel preload is the one renderer->main half of a classified IPC surface:
  // it registers its DOM bridge on DOMContentLoaded and then sends erased action strings.
  fire(state, "window", "DOMContentLoaded");
  const macChannel = IpcChannels.MAC_PERMISSION_HELPER_CHANNEL;
  const sendProbe = (target: string, type: string, key?: string) => {
    const start = state.sends.length;
    const fired = fire(state, target, type, key);
    return {
      listeners: fired.fired,
      preventDefault: fired.preventDefaultCalls.length,
      sends: fired.sends.slice(start),
    };
  };
  check(
    "mac-permission-panel-only-looks-up-its-own-elements",
    "macPermissionHelperPreload",
    [...new Set(state.elementLookups)].sort(),
    ["app", "close"],
  );
  check(
    "mac-permission-preload-registers-its-dom-bridge",
    "macPermissionHelperPreload",
    state.domListeners
      .filter((entry) => entry.target !== "window")
      .map((entry) => `${entry.target}:${entry.type}`)
      .sort(),
    ["#app:click", "#app:dragstart", "#close:click", "document:keydown"],
  );
  check(
    "mac-permission-dragstart-sends-drag-and-prevents-default",
    "macPermissionHelperPreload",
    sendProbe("#app", "dragstart"),
    {
      listeners: 1,
      preventDefault: 1,
      sends: [{ channel: macChannel, args: ["drag"] }],
    },
  );
  check(
    "mac-permission-app-click-sends-finder",
    "macPermissionHelperPreload",
    sendProbe("#app", "click"),
    { listeners: 1, preventDefault: 0, sends: [{ channel: macChannel, args: ["finder"] }] },
  );
  check(
    "mac-permission-close-click-sends-close",
    "macPermissionHelperPreload",
    sendProbe("#close", "click"),
    { listeners: 1, preventDefault: 0, sends: [{ channel: macChannel, args: ["close"] }] },
  );
  check(
    "mac-permission-escape-sends-close",
    "macPermissionHelperPreload",
    sendProbe("document", "keydown", "Escape"),
    { listeners: 1, preventDefault: 0, sends: [{ channel: macChannel, args: ["close"] }] },
  );
  check(
    "mac-permission-other-key-sends-nothing",
    "macPermissionHelperPreload",
    sendProbe("document", "keydown", "a"),
    { listeners: 1, preventDefault: 0, sends: [] },
  );
  check(
    "mac-permission-sends-carry-only-declared-action-strings",
    "macPermissionHelperPreload",
    state.sends
      .filter((entry) => entry.channel === macChannel)
      .map((entry) => entry.args.join(","))
      .sort(),
    ["close", "close", "drag", "finder"],
  );

  const unsubscribe = probe(
    "desktopBridge.onSnapShotEvent",
    snapShotEvent,
    [[{ type: "ready", id: "0a1b2c3d" }]],
    { disposeBeforeEmit: true },
  );
  check("unsubscribe-stops-delivery", "desktopBridge.onSnapShotEvent", unsubscribe.deliveries, 0);
  const doubleSubscribe = probe("desktopBridge.onMenuAction", menuAction, [["copy"]], {
    subscriptions: 2,
  });
  check(
    "double-subscription-delivers-twice",
    "desktopBridge.onMenuAction",
    doubleSubscribe.deliveries,
    2,
  );

  // Declared contracts versus the shipped guards: the Rust port must reproduce the guard, not the
  // Schema, so every divergence here is recorded instead of normalized.
  const {
    DesktopSnapShotEvent,
    DesktopUpdateStateSchema,
    DesktopAppActivationRequest,
    DesktopPreviewRecordingInputSchema,
  } = await import("@lmcstools/core");
  const snapshotDrift = (payload: unknown, schema: Schema.Constraint) => ({
    guardAccepts: probe("desktopBridge.onSnapShotEvent", snapShotEvent, [[payload]]).deliveries > 0,
    schemaAccepts: decodeAccepted(schema, payload),
  });

  check(
    "snap-shot-accepts-ready-without-id-while-schema-rejects",
    "desktopBridge.onSnapShotEvent",
    snapshotDrift({ type: "ready" }, DesktopSnapShotEvent),
    { guardAccepts: true, schemaAccepts: false },
  );
  check(
    "snap-shot-keeps-id-on-shortcut-changed-and-schema-drops-it",
    "desktopBridge.onSnapShotEvent",
    snapshotDrift({ type: "shortcut-changed", id: "0a1b2c3d" }, DesktopSnapShotEvent),
    { guardAccepts: true, schemaAccepts: true },
  );
  check(
    "snap-shot-accepts-non-hex-id-while-schema-rejects",
    "desktopBridge.onSnapShotEvent",
    snapshotDrift({ type: "ready", id: "zzzz" }, DesktopSnapShotEvent),
    { guardAccepts: true, schemaAccepts: false },
  );
  check(
    "snap-shot-failed-without-id-agrees-with-schema",
    "desktopBridge.onSnapShotEvent",
    snapshotDrift({ type: "failed" }, DesktopSnapShotEvent),
    { guardAccepts: true, schemaAccepts: true },
  );

  const updateStateSample = {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "1.2.3",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  check(
    "update-state-forwards-schema-valid-state",
    "desktopBridge.onUpdateState",
    delivery("desktopBridge.onUpdateState", updateState, [updateStateSample]),
    { deliveries: 1, args: [[updateStateSample]] },
  );
  check(
    "update-state-accepts-empty-object-while-schema-rejects",
    "desktopBridge.onUpdateState",
    {
      guardAccepts: probe("desktopBridge.onUpdateState", updateState, [[{}]]).deliveries > 0,
      schemaAccepts: decodeAccepted(DesktopUpdateStateSchema, {}),
    },
    { guardAccepts: true, schemaAccepts: false },
  );
  check(
    "activation-request-accepts-empty-object-while-schema-rejects",
    "desktopBridge.appActivation.onRequest",
    {
      guardAccepts:
        probe("desktopBridge.appActivation.onRequest", activationRequest, [[{}]]).deliveries > 0,
      schemaAccepts: decodeAccepted(DesktopAppActivationRequest, {}),
    },
    { guardAccepts: true, schemaAccepts: false },
  );
  check(
    "activation-request-forwards-schema-valid-request",
    "desktopBridge.appActivation.onRequest",
    delivery("desktopBridge.appActivation.onRequest", activationRequest, [
      {
        version: 1,
        requestId: "req-1",
        type: "open-workspace",
        workspaceRoot: "/tmp/synthetic",
        platform: "darwin",
      },
    ]),
    {
      deliveries: 1,
      args: [
        [
          {
            version: 1,
            requestId: "req-1",
            type: "open-workspace",
            workspaceRoot: "/tmp/synthetic",
            platform: "darwin",
          },
        ],
      ],
    },
  );
  check(
    "recording-input-accepts-empty-object-while-schema-rejects",
    "desktopBridge.preview.recording.onInput",
    {
      guardAccepts:
        probe("desktopBridge.preview.recording.onInput", recordingInput, [[{}]]).deliveries > 0,
      schemaAccepts: decodeAccepted(DesktopPreviewRecordingInputSchema, {}),
    },
    { guardAccepts: true, schemaAccepts: false },
  );
  check(
    "recording-input-forwards-schema-valid-input",
    "desktopBridge.preview.recording.onInput",
    delivery("desktopBridge.preview.recording.onInput", recordingInput, [{ type: "clear" }]),
    {
      deliveries: 1,
      args: [[{ type: "clear" }]],
    },
  );

  const observedChannels = [...new Set([...Object.values(channelMap), macChannel])];
  const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const asConstants = (channels: readonly string[]) =>
    channels
      .map((channel) => ({ channel, constant: constantByChannel.get(channel) ?? "" }))
      .sort((a, b) => byString(a.constant, b.constant));

  // ---- renderer -> main request path ----
  // Every bridge function that reaches ipcRenderer is driven with `length` synthetic positional
  // arguments, so the recorded envelope is exactly what the shipped wrapper hands to the transport.
  const undefinedMarker = "__undefined__";
  const jsonSafe = (value: unknown): unknown => {
    if (value === undefined) return undefinedMarker;
    if (value === null || typeof value !== "object") {
      return typeof value === "function" ? "__function__" : value;
    }
    if (Array.isArray(value)) return value.map(jsonSafe);
    const record: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) record[key] = jsonSafe(member);
    return record;
  };

  interface RequestRow {
    readonly path: string;
    readonly kind: string;
    readonly channel: string;
    readonly args: unknown[];
  }

  const requestRows: RequestRow[] = [];
  const nonRequestPaths: { path: string; reason: string }[] = [];
  const walkBridge = (value: Record<string, unknown>, prefix: string) => {
    for (const [name, member] of Object.entries(value)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (typeof member !== "function") {
        if (member !== null && typeof member === "object") {
          walkBridge(member as Record<string, unknown>, path);
        }
        continue;
      }
      if (name.startsWith("on")) {
        nonRequestPaths.push({ path, reason: "event-subscription" });
        continue;
      }
      const start = state.requests.length;
      const arity = (member as (...args: unknown[]) => unknown).length;
      (member as (...args: unknown[]) => unknown)(
        ...Array.from({ length: arity }, (_unused, index) => `s${index}`),
      );
      const sent = state.requests.slice(start);
      if (sent.length === 0) {
        nonRequestPaths.push({ path, reason: "no-ipc-call" });
        continue;
      }
      for (const entry of sent) {
        requestRows.push({
          path,
          kind: entry.kind,
          channel: entry.channel,
          args: entry.args.map(jsonSafe),
        });
      }
    }
  };
  walkBridge(bridge, "");

  const sortedRows = [...requestRows].sort((a, b) => byString(a.path, b.path));
  const requestChannelByPath: Record<string, string> = {};
  for (const row of sortedRows) {
    requestChannelByPath[row.path] = `${row.kind} ${row.channel}`;
  }
  const requestIdentitySubset = (paths: readonly string[]) =>
    Object.fromEntries(paths.map((path) => [path, requestChannelByPath[path] ?? "missing"]));

  check(
    "request-channel-identity",
    "desktop preload request channels",
    requestIdentitySubset([
      "getAppBranding",
      "getSystemLocale",
      "getLocalEnvironmentBootstraps",
      "getLocalEnvironmentEnabled",
      "getWindowFullscreenState",
      "setNotificationBadge",
      "getUpdateState",
      "setUpdateChannel",
      "checkForUpdate",
      "issueSshWebSocketTicket",
      "showContextMenu",
      "ensureSshEnvironment",
      "pickThemeFiles",
      "probeRemoteEditors",
      "pasteAsText",
      "appActivation.setReady",
      "preview.createTab",
      "preview.registerWebview",
      "preview.clearCookies",
      "preview.getPreviewConfig",
      "preview.copyArtifactToClipboard",
      "preview.revealArtifact",
      "preview.pictureInPicture.open",
      "preview.pictureInPicture.close",
      "preview.recording.save",
      "preview.automation.waitFor",
    ]),
    {
      getAppBranding: "sendSync desktop:get-app-branding",
      getSystemLocale: "sendSync desktop:get-system-locale",
      getLocalEnvironmentBootstraps: "sendSync desktop:get-local-environment-bootstraps",
      getLocalEnvironmentEnabled: "sendSync desktop:get-local-environment-enabled",
      getWindowFullscreenState: "sendSync desktop:get-window-fullscreen-state",
      setNotificationBadge: "invoke desktop:set-notification-badge",
      getUpdateState: "invoke desktop:update-get-state",
      setUpdateChannel: "invoke desktop:update-set-channel",
      checkForUpdate: "invoke desktop:update-check",
      issueSshWebSocketTicket: "invoke desktop:issue-ssh-websocket-token",
      showContextMenu: "invoke desktop:context-menu",
      ensureSshEnvironment: "invoke desktop:ensure-ssh-environment",
      pickThemeFiles: "invoke desktop:pick-theme-files",
      probeRemoteEditors: "invoke desktop:probe-remote-editors",
      pasteAsText: "invoke desktop:paste-as-text",
      "appActivation.setReady": "invoke desktop:app-activation-ready",
      "preview.createTab": "invoke desktop:preview-create-tab",
      "preview.registerWebview": "invoke desktop:preview-register-webview",
      "preview.clearCookies": "invoke desktop:preview-clear-cookies",
      "preview.getPreviewConfig": "invoke desktop:preview-get-config",
      "preview.copyArtifactToClipboard": "invoke desktop:preview-copy-artifact",
      "preview.revealArtifact": "invoke desktop:preview-reveal-artifact",
      "preview.pictureInPicture.open": "invoke desktop:preview-pip-open",
      "preview.pictureInPicture.close": "invoke desktop:preview-pip-close",
      "preview.recording.save": "invoke desktop:preview-recording-save",
      "preview.automation.waitFor": "invoke desktop:preview-automation-wait-for",
    },
  );

  const argsFor = (path: string) => {
    const rows = sortedRows.filter((row) => row.path === path);
    return rows.length === 1 ? rows[0]!.args : rows.map((row) => row.args);
  };

  check(
    "request-envelopes-are-rebuilt-objects",
    "desktopBridge rebuilt request envelopes",
    Object.fromEntries(
      [
        "preview.createTab",
        "preview.closeTab",
        "preview.registerWebview",
        "preview.navigate",
        "preview.setColorScheme",
        "preview.clearCookies",
        "preview.getPreviewConfig",
        "preview.setAnnotationTheme",
        "preview.captureScreenshot",
        "preview.revealArtifact",
        "preview.copyArtifactToClipboard",
        "preview.pictureInPicture.open",
        "preview.recording.save",
        "preview.automation.click",
        "preview.automation.evaluate",
        "showContextMenu",
        "ensureSshEnvironment",
        "bootstrapSshBearerSession",
        "fetchSshSessionState",
        "issueSshWebSocketTicket",
        "resolveSshPasswordPrompt",
        "fetchSshEnvironmentDescriptor",
      ].map((path) => [path, argsFor(path)]),
    ),
    {
      "preview.createTab": [
        { tabId: "s0", zoomFactor: undefinedMarker, colorScheme: undefinedMarker },
      ],
      "preview.closeTab": [{ tabId: "s0" }],
      "preview.registerWebview": [{ tabId: "s0", webContentsId: "s1" }],
      "preview.navigate": [{ tabId: "s0", url: "s1" }],
      "preview.setColorScheme": [{ tabId: "s0", colorScheme: "s1" }],
      "preview.clearCookies": [{ environmentId: "s0", profileId: "s1" }],
      "preview.getPreviewConfig": [{ environmentId: "s0", profileId: "s1" }],
      "preview.setAnnotationTheme": [{ theme: "s0" }],
      "preview.captureScreenshot": [{ tabId: "s0" }],
      "preview.revealArtifact": [{ path: "s0" }],
      "preview.copyArtifactToClipboard": [{ path: "s0" }],
      "preview.pictureInPicture.open": [{ tabId: "s0" }],
      "preview.recording.save": [{ tabId: "s0", mimeType: "s1", data: "s2" }],
      "preview.automation.click": [{ tabId: "s0", input: "s1" }],
      "preview.automation.evaluate": [{ tabId: "s0", input: "s1" }],
      showContextMenu: [{ items: "s0", position: "s1" }],
      ensureSshEnvironment: [{ target: "s0", options: "s1" }],
      bootstrapSshBearerSession: [{ httpBaseUrl: "s0", credential: "s1" }],
      fetchSshSessionState: [{ httpBaseUrl: "s0", bearerToken: "s1" }],
      issueSshWebSocketTicket: [{ httpBaseUrl: "s0", bearerToken: "s1" }],
      resolveSshPasswordPrompt: [{ requestId: "s0", password: "s1" }],
      fetchSshEnvironmentDescriptor: [{ httpBaseUrl: "s0" }],
    },
  );

  check(
    "request-arguments-are-passed-through-positionally",
    "desktopBridge positional request arguments",
    Object.fromEntries(
      [
        "setNotificationBadge",
        "setClientSettings",
        "setupSnapShot",
        "requestSnapShotPermissions",
        "readSnapShot",
        "acknowledgeSnapShot",
        "setTheme",
        "pickFolder",
        "pickProjectFavicon",
        "openExternal",
        "checkSystemPermission",
        "openSystemSettings",
        "setWslDistro",
        "setWslOnly",
        "setServerExposureMode",
        "appActivation.complete",
        "disconnectSshEnvironment",
        "resolveSshHost",
      ].map((path) => [path, argsFor(path)]),
    ),
    {
      setNotificationBadge: ["s0"],
      setClientSettings: ["s0"],
      setupSnapShot: ["s0"],
      requestSnapShotPermissions: ["s0"],
      readSnapShot: ["s0"],
      acknowledgeSnapShot: ["s0"],
      setTheme: ["s0"],
      pickFolder: ["s0"],
      pickProjectFavicon: ["s0"],
      openExternal: ["s0"],
      checkSystemPermission: ["s0"],
      openSystemSettings: ["s0"],
      setWslDistro: ["s0"],
      setWslOnly: ["s0"],
      setServerExposureMode: ["s0"],
      "appActivation.complete": ["s0"],
      disconnectSshEnvironment: ["s0"],
      resolveSshHost: ["s0"],
    },
  );

  check(
    "zero-arity-requests-either-send-nothing-or-explicit-undefined",
    "desktopBridge zero-arity requests",
    Object.fromEntries(
      [
        "getSnapShotState",
        "listPendingSnapShots",
        "getConnectionCatalog",
        "getWslState",
        "getDeviceToken",
        "pickThemeFiles",
        "probeRemoteEditors",
        "pasteAsText",
      ].map((path) => [path, argsFor(path)]),
    ),
    {
      getSnapShotState: [],
      listPendingSnapShots: [],
      getConnectionCatalog: [],
      getWslState: [],
      getDeviceToken: [],
      pickThemeFiles: [undefinedMarker],
      probeRemoteEditors: [undefinedMarker],
      pasteAsText: [undefinedMarker],
    },
  );

  const requestChannels = [...new Set(sortedRows.map((row) => row.channel))].sort(byString);
  const eventChannels = [...new Set(observedChannels)].sort(byString);
  const declaredChannels = [...constantByChannel.keys()];
  const macChannelConstant = constantByChannel.get(macChannel) ?? "";
  check(
    "every-declared-channel-is-exercised-by-the-shipped-preload",
    "desktop ipc channel closure",
    {
      declaredCount: declaredChannels.length,
      requestChannelCount: requestChannels.length,
      eventChannelCount: eventChannels.length,
      unexercised: declaredChannels
        .filter(
          (channel) =>
            channel !== macChannel &&
            !requestChannels.includes(channel) &&
            !eventChannels.includes(channel),
        )
        .sort(byString),
      usedByBothRoles: requestChannels
        .filter((channel) => eventChannels.includes(channel))
        .sort(byString),
      macChannelConstant,
    },
    {
      declaredCount: 113,
      requestChannelCount: 99,
      eventChannelCount: 15,
      unexercised: [],
      usedByBothRoles: ["desktop:set-notification-badge"],
      macChannelConstant: "MAC_PERMISSION_HELPER_CHANNEL",
    },
  );

  check(
    "non-request-bridge-members",
    "desktopBridge members that do not reach the main process",
    [...nonRequestPaths].sort((a, b) => byString(a.path, b.path)),
    [
      { path: "appActivation.onRequest", reason: "event-subscription" },
      { path: "getClientPlatform", reason: "no-ipc-call" },
      { path: "getPathForFile", reason: "no-ipc-call" },
      { path: "onMenuAction", reason: "event-subscription" },
      { path: "onNotificationBadgeClear", reason: "event-subscription" },
      { path: "onQuitShortcut", reason: "event-subscription" },
      { path: "onSnapShotEvent", reason: "event-subscription" },
      { path: "onSshPasswordPrompt", reason: "event-subscription" },
      { path: "onTrackpadScrollEnd", reason: "event-subscription" },
      { path: "onUpdateState", reason: "event-subscription" },
      { path: "onWindowFullscreenStateChange", reason: "event-subscription" },
      { path: "preview.onPointerEvent", reason: "event-subscription" },
      { path: "preview.onStateChange", reason: "event-subscription" },
      { path: "preview.recording.onFrame", reason: "event-subscription" },
      { path: "preview.recording.onInput", reason: "event-subscription" },
    ],
  );

  const callOnce = (run: () => unknown) => {
    const start = state.requests.length;
    run();
    const entry = state.requests[start];
    return entry === undefined ? null : jsonSafe(entry.args[0]);
  };
  const previewTabMethods = bridge.preview as {
    createTab: (tabId: string, defaults?: unknown) => unknown;
  };
  check(
    "single-argument-calls-separate-omitted-from-undefined-keys",
    "desktopBridge optional request fields",
    {
      ensureSshEnvironment: callOnce(() =>
        (bridge.ensureSshEnvironment as (target: string) => unknown)("s0"),
      ),
      showContextMenu: callOnce(() => (bridge.showContextMenu as (items: string) => unknown)("s0")),
      "preview.createTab without defaults": callOnce(() => previewTabMethods.createTab("s0")),
    },
    {
      ensureSshEnvironment: { target: "s0" },
      showContextMenu: { items: "s0" },
      "preview.createTab without defaults": {
        tabId: "s0",
        zoomFactor: undefinedMarker,
        colorScheme: undefinedMarker,
      },
    },
  );
  check(
    "preview-create-tab-drops-unknown-default-fields",
    "desktopBridge.preview.createTab",
    callOnce(() =>
      previewTabMethods.createTab("s0", { zoomFactor: 1.5, colorScheme: "dark", extra: "dropped" }),
    ),
    { tabId: "s0", zoomFactor: 1.5, colorScheme: "dark" },
  );

  const syncProbe = (channel: string, value: unknown, run: () => unknown) => {
    state.syncResults[channel] = value;
    const result = jsonSafe(run());
    delete state.syncResults[channel];
    return result;
  };
  const brandingChannel = "desktop:get-app-branding";
  const runGetAppBranding = () => (bridge.getAppBranding as () => unknown)();
  const localeChannel = "desktop:get-system-locale";
  const bootstrapsChannel = "desktop:get-local-environment-bootstraps";
  const localEnabledChannel = "desktop:get-local-environment-enabled";
  const fullscreenChannel = "desktop:get-window-fullscreen-state";
  check(
    "get-app-branding-nullifies-non-object-results",
    "desktopBridge.getAppBranding",
    {
      object: syncProbe(brandingChannel, { name: "LMCS" }, runGetAppBranding),
      array: syncProbe(brandingChannel, [1, 2], runGetAppBranding),
      string: syncProbe(brandingChannel, "LMCS", runGetAppBranding),
      number: syncProbe(brandingChannel, 42, runGetAppBranding),
      null: syncProbe(brandingChannel, null, runGetAppBranding),
      undefined: syncProbe(brandingChannel, undefined, runGetAppBranding),
    },
    {
      object: { name: "LMCS" },
      array: [1, 2],
      string: null,
      number: null,
      null: null,
      undefined: null,
    },
  );
  const runGetSystemLocale = () => {
    const run = bridge.getSystemLocale as () => unknown;
    return run();
  };
  check(
    "get-system-locale-forwards-strings-only",
    "desktopBridge.getSystemLocale",
    {
      string: syncProbe(localeChannel, "pt-BR", runGetSystemLocale),
      null: syncProbe(localeChannel, null, runGetSystemLocale),
      object: syncProbe(localeChannel, { locale: "pt-BR" }, runGetSystemLocale),
      number: syncProbe(localeChannel, 7, runGetSystemLocale),
    },
    { string: "pt-BR", null: null, object: null, number: null },
  );
  const runGetBootstraps = () => (bridge.getLocalEnvironmentBootstraps as () => unknown)();
  check(
    "get-local-environment-bootstraps-nullifies-non-arrays",
    "desktopBridge.getLocalEnvironmentBootstraps",
    {
      array: syncProbe(bootstrapsChannel, [{ id: "env-1" }], runGetBootstraps),
      empty: syncProbe(bootstrapsChannel, [], runGetBootstraps),
      object: syncProbe(bootstrapsChannel, { id: "env-1" }, runGetBootstraps),
      null: syncProbe(bootstrapsChannel, null, runGetBootstraps),
    },
    { array: [{ id: "env-1" }], empty: [], object: [], null: [] },
  );
  const runLocalEnabled = () => (bridge.getLocalEnvironmentEnabled as () => unknown)();
  check(
    "get-local-environment-enabled-uses-loose-not-false",
    "desktopBridge.getLocalEnvironmentEnabled",
    {
      false: syncProbe(localEnabledChannel, false, runLocalEnabled),
      true: syncProbe(localEnabledChannel, true, runLocalEnabled),
      null: syncProbe(localEnabledChannel, null, runLocalEnabled),
      undefined: syncProbe(localEnabledChannel, undefined, runLocalEnabled),
      string: syncProbe(localEnabledChannel, "s0", runLocalEnabled),
      object: syncProbe(localEnabledChannel, {}, runLocalEnabled),
    },
    {
      false: false,
      true: true,
      null: true,
      undefined: true,
      string: true,
      object: true,
    },
  );
  const runFullscreen = () => (bridge.getWindowFullscreenState as () => unknown)();
  check(
    "get-window-fullscreen-state-requires-strict-true",
    "desktopBridge.getWindowFullscreenState",
    {
      true: syncProbe(fullscreenChannel, true, runFullscreen),
      false: syncProbe(fullscreenChannel, false, runFullscreen),
      string: syncProbe(fullscreenChannel, "true", runFullscreen),
      number: syncProbe(fullscreenChannel, 1, runFullscreen),
      null: syncProbe(fullscreenChannel, null, runFullscreen),
    },
    { true: true, false: false, string: false, number: false, null: false },
  );

  const ensureChannel = "desktop:ensure-ssh-environment";
  const sshUnwrap = async (value: unknown) => {
    state.promiseResults[ensureChannel] = value;
    try {
      const resolved = await (bridge.ensureSshEnvironment as (target: string) => Promise<unknown>)(
        "s0",
      );
      return { thrown: null, value: jsonSafe(resolved) };
    } catch (error) {
      return { thrown: (error as Error).message, value: null };
    } finally {
      delete state.promiseResults[ensureChannel];
    }
  };
  check(
    "ensure-ssh-environment-converts-cancellation-into-a-rejection",
    "desktopBridge.ensureSshEnvironment",
    {
      cancelledWithMessage: await sshUnwrap({
        type: "ssh-password-prompt-cancelled",
        message: "no credentials",
      }),
      cancelledWithoutMessage: await sshUnwrap({ type: "ssh-password-prompt-cancelled" }),
      cancelledWithNonStringMessage: await sshUnwrap({
        type: "ssh-password-prompt-cancelled",
        message: 42,
      }),
      passthrough: await sshUnwrap({ status: "connected" }),
      nullResult: await sshUnwrap(null),
    },
    {
      cancelledWithMessage: { thrown: "no credentials", value: null },
      cancelledWithoutMessage: { thrown: "SSH authentication cancelled.", value: null },
      cancelledWithNonStringMessage: { thrown: "SSH authentication cancelled.", value: null },
      passthrough: { thrown: null, value: { status: "connected" } },
      nullResult: { thrown: null, value: null },
    },
  );

  const coveredEventChannels = asConstants(eventChannels);
  const coveredRequestChannels = asConstants(requestChannels);
  check(
    "every-observed-channel-is-a-declared-constant",
    "desktop preload event and request channels",
    [...coveredEventChannels, ...coveredRequestChannels]
      .filter((entry) => entry.constant === "")
      .map((entry) => entry.channel),
    [],
  );

  return {
    interpretation:
      "Executed the real preload listeners captured from apps/desktop/src/preload.ts and apps/desktop/src/preview-pip-preload.ts, plus the macOS permission panel preload DOM bridge, inside a Node child process with an in-memory electron stub. Deliveries are what a renderer callback received, sends are what a panel posted to the main process, and requests are the channel plus argument envelope each bridge method hands to ipcRenderer.invoke or sendSync. No Electron, BrowserWindow, ipcRenderer transport, main-process sender, registered main handler, Schema decoding or Rust implementation is exercised. These snapshots characterize the shipped guards and wrappers, not an approved contract.",
    fixturePolicy:
      "Payloads are synthetic literals. The stub records channel registrations and re-emits through the captured wrapper, so each check exercises the shipped typeof/object guard and any payload reconstruction. A missing payload entry in an emit array still calls the wrapper, which is how argument-count rejections are observed. Request methods are driven with `length` positional `s0/s1/...` strings, and sendSync/invoke return values are scripted per channel to observe the wrapper's own result conversion.",
    declaredSchemaComparison:
      "Where a runtime Schema exists (snap-shot event, update state, activation request, recording input), the same payload is checked with Schema.is. Divergences are recorded as-is: the port must reproduce the guard behavior unless the project decides to tighten it. Note that decoding ignores unknown properties, so a payload carrying an extra field can satisfy both the guard and the Schema while the Schema's Type does not include that field.",
    knownLimitations: [
      "The preload modules are evaluated outside a renderer, so document/window/webFrame/Clerk bridge behavior is stubbed; only the macOS permission panel's own element and key listeners are driven.",
      "Serialization boundaries of Electron IPC (structured clone, unsupported types, sender identity) are not modeled; the stub calls the wrapper with plain JavaScript values, and `__undefined__` marks an `undefined` value that JSON could not carry.",
      "Requests are observed at the renderer edge only. The registered main-side handler, its payload/result codecs and required services are never executed, so an envelope that the shipped codec would reject still passes here.",
      "The macOS permission helper is only covered on its preload send side; the main-process sender/frame checks and action validation are not executed here.",
      "No main-process producer is executed, so a payload the real main process can never send is still characterized by the guard.",
      "Interfaces without a runtime Schema (ssh prompt, preview frame, pointer event, tab state) cannot be compared against a declared contract here.",
      "The preview pick preload and the guest preview channels are outside this corpus.",
    ],
    coveredEventChannels,
    coveredRequestChannels,
    requestMethods: sortedRows,
    results,
  };
}

if (process.argv.includes(EMIT_FLAG)) {
  const report = await buildReport();
  process.stdout.write(JSON.stringify(report));
  process.exit(0);
}

export async function runMigrationPreloadIpc() {
  const entry = NodeURL.fileURLToPath(import.meta.url);
  const child = NodeChildProcess.spawnSync(process.execPath, [entry, EMIT_FLAG], {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(
      `Preload IPC corpus failed (exit ${String(child.status)}): ${child.stderr.slice(-4000)}`,
    );
  }
  return JSON.parse(child.stdout) as Awaited<ReturnType<typeof buildReport>>;
}
