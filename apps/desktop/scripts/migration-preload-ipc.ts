#!/usr/bin/env node
/**
 * Phase 0 baseline corpus for the Electron main -> renderer event boundary.
 *
 * The shipped preload guards are closures inside `contextBridge.exposeInMainWorld`, so they
 * cannot be imported directly: the module also touches `electron`, Clerk's preload bridge and
 * renderer globals. This script registers a Node module hook that substitutes an in-memory
 * `electron` stub, imports the real preload entry points (desktop bridge, PiP bridge and the macOS
 * permission panel), and drives the captured listeners with synthetic payloads. Because the stub
 * only exists for Node's own loader, the corpus runs itself as a child process so
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
  sendSync: () => null,
  invoke: async () => null,
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
    return { subject, channels, deliveries: received.length, args: received };
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
    onMenuAction: probe("desktopBridge.onMenuAction", menuAction, [["copy"]]).channels[0],
    onSnapShotEvent: probe("desktopBridge.onSnapShotEvent", snapShotEvent, [
      [{ type: "requested", id: "0a1b2c3d" }],
    ]).channels[0],
    onQuitShortcut: probe("desktopBridge.onQuitShortcut", quitShortcut, [[{ state: "up" }]])
      .channels[0],
    onTrackpadScrollEnd: probe("desktopBridge.onTrackpadScrollEnd", trackpadScrollEnd, [[]])
      .channels[0],
    onNotificationBadgeClear: probe(
      "desktopBridge.onNotificationBadgeClear",
      notificationBadgeClear,
      [[]],
    ).channels[0],
    onWindowFullscreenStateChange: probe(
      "desktopBridge.onWindowFullscreenStateChange",
      windowFullscreen,
      [[true]],
    ).channels[0],
    onSshPasswordPrompt: probe("desktopBridge.onSshPasswordPrompt", sshPasswordPrompt, [[{}]])
      .channels[0],
    onUpdateState: probe("desktopBridge.onUpdateState", updateState, [[{}]]).channels[0],
    "appActivation.onRequest": probe("desktopBridge.appActivation.onRequest", activationRequest, [
      [{}],
    ]).channels[0],
    "preview.onStateChange": probe("desktopBridge.preview.onStateChange", previewStateChange, [
      ["tab-1", {}],
    ]).channels[0],
    "preview.onPointerEvent": probe("desktopBridge.preview.onPointerEvent", previewPointerEvent, [
      [{}],
    ]).channels[0],
    "preview.recording.onInput": probe("desktopBridge.preview.recording.onInput", recordingInput, [
      [{}],
    ]).channels[0],
    "preview.recording.onFrame": probe("desktopBridge.preview.recording.onFrame", recordingFrame, [
      [{}],
    ]).channels[0],
    "previewPictureInPicture.onFrame": probe("previewPictureInPicture.onFrame", pipFrame, [[{}]])
      .channels[0],
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
  const coveredChannels = observedChannels
    .map((channel) => ({ channel, constant: constantByChannel.get(channel) ?? "" }))
    .sort((a, b) => (a.constant < b.constant ? -1 : a.constant > b.constant ? 1 : 0));
  check(
    "every-observed-channel-is-a-declared-constant",
    "desktop preload event channels",
    coveredChannels.filter((entry) => entry.constant === "").map((entry) => entry.channel),
    [],
  );

  return {
    interpretation:
      "Executed the real preload listeners captured from apps/desktop/src/preload.ts and apps/desktop/src/preview-pip-preload.ts, plus the macOS permission panel preload DOM bridge, inside a Node child process with an in-memory electron stub. Deliveries are what a renderer callback received and sends are what a panel posted to the main process; no Electron, BrowserWindow, ipcRenderer transport, main-process sender or Rust implementation is exercised. These snapshots characterize the shipped guards, not an approved contract.",
    fixturePolicy:
      "Payloads are synthetic literals. The stub records channel registrations and re-emits through the captured wrapper, so each check exercises the shipped typeof/object guard and any payload reconstruction. A missing payload entry in an emit array still calls the wrapper, which is how argument-count rejections are observed.",
    declaredSchemaComparison:
      "Where a runtime Schema exists (snap-shot event, update state, activation request, recording input), the same payload is checked with Schema.is. Divergences are recorded as-is: the port must reproduce the guard behavior unless the project decides to tighten it. Note that decoding ignores unknown properties, so a payload carrying an extra field can satisfy both the guard and the Schema while the Schema's Type does not include that field.",
    knownLimitations: [
      "The preload modules are evaluated outside a renderer, so document/window/webFrame/Clerk bridge behavior is stubbed; only the macOS permission panel's own element and key listeners are driven.",
      "Serialization boundaries of Electron IPC (structured clone, unsupported types, sender identity) are not modeled; the stub calls the wrapper with plain JavaScript values.",
      "Renderer->main invoke/sendSync methods, the preview pick preload and the guest preview channels are outside this corpus.",
      "The macOS permission helper is only covered on its preload send side; the main-process sender/frame checks and action validation are not executed here.",
      "No main-process producer is executed, so a payload the real main process can never send is still characterized by the guard.",
      "Interfaces without a runtime Schema (ssh prompt, preview frame, pointer event, tab state) cannot be compared against a declared contract here.",
    ],
    coveredChannels,
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
