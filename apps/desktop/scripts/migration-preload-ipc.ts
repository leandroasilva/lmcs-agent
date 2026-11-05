#!/usr/bin/env node
/**
 * Phase 0 baseline corpus for the Electron IPC boundary in both directions.
 *
 * The shipped preload guards are closures inside `contextBridge.exposeInMainWorld`, so they
 * cannot be imported directly: the module also touches `electron`, Clerk's preload bridge and
 * renderer globals. This script registers a Node module hook that substitutes an in-memory
 * `electron` stub, imports the real preload entry points (desktop bridge, PiP bridge, the macOS
 * permission panel and the preview pick guest), drives the captured listeners with synthetic payloads
 * for the main -> renderer direction, and calls every bridge request method to record the channel and
 * argument envelope the
 * shipped wrapper hands to `ipcRenderer.invoke`/`sendSync` for the renderer -> main direction. The * payload contract each shipped main-process factory declares for those channels is captured by
 * recording the codecs at `makeIpcMethod`/`makeSyncIpcMethod` time, so the envelopes can be audited
 * against the codecs instead of only against the wrapper. Service-free codecs are then registered
 * through the shipped `DesktopIpc.make(ipcMain)` itself, so the main-process framing of a request —
 * decode before the handler, handler input, result encode, listener replacement and release — runs
 * here instead of being only described, and `installNotificationBadge` runs for real because its
 * payload codec is built inside that installer and is unreachable otherwise. `MacPermissionHelper`
 * also runs for real: it is the one classified IPC surface whose main-process half is a plain
 * `ipcMain.on` listener, so the panel preload's own sends are delivered into that live listener.
 * The pick preload speaks a separate `preview:*` guest protocol that the desktop channel inventory
 * does not cover, so its recording cursor also runs for real against a stubbed DOM with captured
 * timers and animation frames: the `preview:recording-input` payloads pinned here are the ones the
 * shipped guest emits, and they are compared against the schema the host validates them with.
 * Because the stub only exists for Node's own loader, the corpus runs itself as a child process so
 * `node scripts/migration-baseline.ts` and Vitest get the same report.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const EMIT_FLAG = "--emit-preload-ipc-corpus";
const STUB_MARK = "virtual:lmcs-migration-electron";
const desktopRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const desktopIpcUrl = NodeURL.pathToFileURL(
  NodePath.join(desktopRoot, "src/ipc/DesktopIpc.ts"),
).href;
const macPermissionHelperUrl = NodeURL.pathToFileURL(
  NodePath.join(desktopRoot, "src/permissions/MacPermissionHelper.ts"),
).href;
const macSettingsWindowUrl = NodeURL.pathToFileURL(
  NodePath.join(desktopRoot, "src/permissions/MacSettingsWindow.ts"),
).href;

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
  readonly capture: boolean;
}

interface SyntheticEvent {
  readonly type: string;
  readonly key?: string;
  readonly code?: string;
  readonly isTrusted?: boolean;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly button?: number;
  readonly pointerType?: string;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
  readonly relatedTarget?: unknown;
  readonly preventDefault: () => void;
  readonly stopImmediatePropagation?: () => void;
}

/** One node the recording cursor builds through the stubbed `document.createElement`. */
interface GuestElement {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  removed: boolean;
}

/**
 * Recorders the preview pick preload drives through the stubbed DOM. Timers and animation frames
 * are captured instead of scheduled, so the cursor's 700ms agent-cursor reset and its pointer
 * coalescing frame only run when the corpus flushes them.
 */
interface GuestStub {
  readonly effects: string[];
  readonly elements: GuestElement[];
  readonly frames: { id: number; callback: () => void; cancelled: boolean }[];
  readonly timers: { id: number; ms: number; callback: () => void; cleared: boolean }[];
  activeElement: unknown;
  platform: string;
  innerWidth: number;
  innerHeight: number;
}

interface CapturedCodec {
  readonly kind: "invoke" | "sync";
  readonly channel: string;
  readonly payload: unknown;
  readonly result: unknown;
}

interface BadgeStub {
  readonly effects: string[];
  windows: number[];
  focused: boolean;
  emptyImage: boolean;
  destroyed: boolean;
  failing: boolean;
}

/** Recorders the shipped `MacPermissionHelper` drives through the Electron stub. */
interface HelperStub {
  readonly effects: string[];
  readonly loadedUrls: string[];
  readonly windowOptions: unknown[];
  readonly windows: unknown[];
  readonly windowEvents: { type: string; handler: () => void }[];
  readonly webContentsEvents: string[];
  readonly windowOpenHandlers: unknown[];
  readonly listeners: {
    channel: string;
    handler: (event: unknown, ...args: unknown[]) => void;
  }[];
  readonly watchers: { onChange: (settings: unknown) => void; onUnavailable: () => void }[];
  exePath: string;
  mediaAccessStatus: string;
  accessibilityTrusted: boolean;
  iconEmpty: boolean;
  dragFails: boolean;
  loadFails: boolean;
  deliver: boolean;
  untrustedSender: boolean;
  untrustedFrame: boolean;
  visible: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

interface StubState {
  readonly registrations: Registration[];
  readonly bridges: Record<string, Record<string, unknown>>;
  readonly sends: Send[];
  readonly requests: Request[];
  readonly syncResults: Record<string, unknown>;
  readonly promiseResults: Record<string, unknown>;
  readonly codecs: CapturedCodec[];
  readonly domListeners: DomListener[];
  readonly elementLookups: string[];
  readonly badge: BadgeStub;
  readonly helper: HelperStub;
  readonly guest: GuestStub;
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
    if (!state.helper.deliver) return;
    for (const entry of state.helper.listeners.slice()) {
      if (entry.channel === channel) entry.handler(helperEvent(), ...args);
    }
  },
};
export const webFrame = { getZoomFactor: () => 1, setZoomFactor: () => {} };
export const webUtils = { getPathForFile: () => "" };
// Mostly inert shapes so the main-process modules can be imported. The corpus reads the codecs
// those modules declare, and the badge members below are called for real by installNotificationBadge.
const inert = () => {};
const badgeWindow = (id) => ({
  isDestroyed: () => state.badge.destroyed,
  setOverlayIcon: (icon, description) => {
    if (state.badge.failing) throw new Error("synthetic overlay failure");
    state.badge.effects.push(
      "window " + id + " overlay " + (icon === null ? "null" : "image") + " description " + JSON.stringify(description),
    );
  },
  webContents: {
    send: (channel, ...args) =>
      state.badge.effects.push("send " + channel + " " + JSON.stringify(args)),
  },
});
export const app = { on: inert, once: inert, getPath: (name) => (name === "exe" ? state.helper.exePath : "/tmp"), setPath: inert, getAppPath: () => "/tmp", isReady: () => true, whenReady: async () => {}, quit: inert, setBadgeCount: (count) => {
  if (state.badge.failing) throw new Error("synthetic badge failure");
  state.badge.effects.push("setBadgeCount " + count);
  return true;
} };
export const dialog = { showOpenDialog: async () => ({}) };
export const shell = { openExternal: async () => {}, showItemInFolder: (path) => state.helper.effects.push("showItemInFolder " + path), trashItem: async () => {} };
export const Menu = { buildFromTemplate: () => ({ popup: inert }), setApplicationMenu: inert };
// The permission helper registers its own listener on the real ipcMain object it imports, so this
// one records registrations and delivers the preload's sends straight into them.
export const ipcMain = {
  on: (channel, handler) => {
    state.helper.listeners.push({ channel, handler });
    state.helper.effects.push("ipcMain.on " + channel);
  },
  removeListener: (channel, handler) => {
    const index = state.helper.listeners.findIndex(
      (entry) => entry.channel === channel && entry.handler === handler,
    );
    if (index >= 0) state.helper.listeners.splice(index, 1);
    state.helper.effects.push("ipcMain.removeListener " + channel);
  },
};
// Only the helper's own window identity may drive its actions, so the corpus chooses which half of
// the gate fails here.
const helperEvent = () => {
  const window = state.helper.windows[state.helper.windows.length - 1];
  return {
    sender: state.helper.untrustedSender || !window ? {} : window.webContents,
    senderFrame: state.helper.untrustedFrame || !window ? {} : window.webContents.mainFrame,
  };
};
export const BrowserWindow = class {
  constructor(options) {
    this.destroyed = false;
    this.listeners = [];
    this.webContents = {
      mainFrame: { frameId: state.helper.windows.length },
      send: (channel, ...args) =>
        state.helper.effects.push("webContents.send " + channel + " " + JSON.stringify(args)),
      startDrag: (drag) => {
        if (state.helper.dragFails) throw new Error("synthetic drag failure");
        state.helper.effects.push("startDrag " + drag.file);
      },
      setWindowOpenHandler: (handler) => state.helper.windowOpenHandlers.push(handler),
      on: (type) => state.helper.webContentsEvents.push(type),
    };
    state.helper.windowOptions.push(options);
    state.helper.windows.push(this);
  }
  on(type, handler) {
    this.listeners.push({ type, handler });
    state.helper.windowEvents.push({ type, handler });
    state.helper.effects.push("window.on " + type);
  }
  once(type, handler) {
    this.listeners.push({ type, handler });
    state.helper.windowEvents.push({ type, handler });
    state.helper.effects.push("window.once " + type);
  }
  removeListener(type, handler) {
    const index = this.listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  emitClosed() {
    for (const entry of this.listeners.slice()) {
      if (entry.type === "closed") entry.handler();
    }
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    state.helper.effects.push("window.destroy");
    this.emitClosed();
  }
  close() {
    state.helper.effects.push("window.close");
    this.destroy();
  }
  show() {
    state.helper.effects.push("window.show");
  }
  focus() {
    state.helper.effects.push("window.focus");
  }
  hide() {
    state.helper.effects.push("window.hide");
  }
  showInactive() {
    state.helper.effects.push("window.showInactive");
  }
  isVisible() {
    return state.helper.visible;
  }
  isFocused() {
    return state.helper.focused;
  }
  getBounds() {
    return state.helper.bounds;
  }
  setBounds(bounds, animate) {
    state.helper.effects.push("setBounds " + JSON.stringify(bounds) + " animate " + animate);
  }
  loadURL(url) {
    state.helper.loadedUrls.push(String(url));
    if (state.helper.loadFails) return Promise.reject(new Error("synthetic load failure"));
    return Promise.resolve();
  }
  static getFocusedWindow() {
    return state.badge.focused ? badgeWindow(state.badge.windows[0] ?? 1) : null;
  }
  static getAllWindows() {
    return state.badge.windows.map(badgeWindow);
  }
};
export const ClipboardItem = class {};
export const WebContentsView = class {};
export const View = class {};
export const webContents = { fromId: () => undefined, getAllWebContents: () => [] };
export const screen = { on: inert, getPrimaryDisplay: () => ({}) };
export const nativeTheme = { on: inert, shouldStartInDarkMode: async () => false, themeSource: "system" };
export const session = { defaultSession: { on: inert, clearStorageData: async () => {}, getCookieString: async () => "" } };
export const powerMonitor = { on: inert };
export const powerSaveBlocker = { start: () => 0, stop: inert, isStarted: () => false };
export const Tray = class {};
export const nativeImage = {
  createFromPath: (iconPath) => {
    state.helper.effects.push("createFromPath " + iconPath);
    return {
      isEmpty: () => state.helper.iconEmpty,
      resize: (size) => {
        state.helper.effects.push("resize " + JSON.stringify(size));
        return { toDataURL: () => "data:image/png;base64,AAAA" };
      },
    };
  },
  createFromDataURL: (dataUrl) => {
    state.badge.effects.push("createFromDataURL " + String(dataUrl).slice(0, 24));
    return { isEmpty: () => state.badge.emptyImage };
  },
};
export const protocol = { handle: inert, registerFileProtocol: inert };
export const clipboard = { readText: () => "", writeText: inert, write: inert };
export const globalShortcut = { register: () => true, unregisterAll: inert };
export const systemPreferences = {
  getMediaAccessStatus: (kind) => {
    state.helper.effects.push("getMediaAccessStatus " + kind);
    return state.helper.mediaAccessStatus;
  },
  isTrustedAccessibilityClient: (prompt) => {
    state.helper.effects.push("isTrustedAccessibilityClient " + prompt);
    return state.helper.accessibilityTrusted;
  },
  askForMediaAccess: async () => false,
};
export const desktopCapturer = { getSources: async () => [] };
export const net = { request: () => ({}) };
`;

const clerkStub = `
export const exposeClerkBridge = () => {};
`;

/**
 * `watchMacSettingsWindow` spawns a long-lived `osascript` process, which a report cannot depend
 * on. The shipped geometry helper is re-exported from the real module so its constants still run.
 */
const macSettingsWindowStub = `
const state = globalThis.__lmcsMigrationPreloadIpc;
export { settingsHelperBounds } from "${macSettingsWindowUrl}";
export const watchMacSettingsWindow = (onChange, onUnavailable) => {
  state.helper.watchers.push({ onChange, onUnavailable });
  state.helper.effects.push("watchMacSettingsWindow");
  return () => state.helper.effects.push("stopTracking");
};
`;

const updaterStub = `
export const autoUpdater = {
  on: () => {},
  checkForUpdates: async () => ({}),
  downloadUpdate: async () => {},
  quitAndInstall: () => {},
  autoDownload: false,
  autoInstallOnAppQuit: true,
  channel: "latest",
};
`;

/**
 * The declared main-side codecs are closed over inside `makeIpcMethod`, so the corpus records them
 * when the shipped factories run. Only these two capture statements are added to the module source;
 * the registration behaviour itself is untouched, and a missing anchor fails the corpus loudly.
 */
const captureInvoke =
  'globalThis.__lmcsMigrationPreloadIpc?.codecs.push({ kind: "invoke", channel: method.channel, payload: method.payload, result: method.result });';
const captureSync =
  'globalThis.__lmcsMigrationPreloadIpc?.codecs.push({ kind: "sync", channel: method.channel, payload: undefined, result: method.result });';
const invokeAnchor =
  "  const decode = Schema.decodeUnknownEffect(method.payload);\n  const encode = Schema.encodeUnknownEffect(method.result);";
const syncAnchor =
  "  const encode = Schema.encodeUnknownEffect(method.result);\n\n  return {\n    channel: method.channel,\n    handler: () =>";

const patchDesktopIpcSource = (source: string): string => {
  const withInvoke = source.replace(invokeAnchor, `${captureInvoke}\n${invokeAnchor}`);
  const withBoth = withInvoke.replace(syncAnchor, `${captureSync}\n${syncAnchor}`);
  const captures = withBoth.split("?.codecs.push").length - 1;
  if (captures !== 2) {
    throw new Error(
      `Could not instrument src/ipc/DesktopIpc.ts to capture declared codecs (found ${captures} of 2 anchors).`,
    );
  }
  return withBoth;
};

const installStubLoader = () => {
  NodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === "electron" ||
        specifier === "@clerk/electron/preload" ||
        specifier === "electron-updater"
      ) {
        return {
          url: `${STUB_MARK}?name=${encodeURIComponent(specifier)}`,
          shortCircuit: true,
          format: "module",
        };
      }
      if (specifier === "./MacSettingsWindow.ts" && context?.parentURL === macPermissionHelperUrl) {
        return {
          url: `${STUB_MARK}?name=macSettingsWindow`,
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
          source:
            name === "electron"
              ? electronStub
              : name === "electron-updater"
                ? updaterStub
                : name === "macSettingsWindow"
                  ? macSettingsWindowStub
                  : clerkStub,
          shortCircuit: true,
        };
      }
      if (typeof url === "string" && url.startsWith(desktopIpcUrl)) {
        return {
          format: "module-typescript",
          source: patchDesktopIpcSource(NodeFS.readFileSync(NodeURL.fileURLToPath(url), "utf8")),
          shortCircuit: true,
        };
      }
      return nextLoad(url as string);
    },
  });
};

const installRendererGlobals = () => {
  const state = globalThis.__lmcsMigrationPreloadIpc!;
  const listen =
    (target: string) =>
    (type: string, handler: (event: SyntheticEvent) => void, capture?: unknown) => {
      state.domListeners.push({ target, type, handler, capture: capture === true });
    };
  const unlisten = (target: string) => (type: string, handler: unknown) => {
    const index = state.domListeners.findIndex(
      (entry) => entry.target === target && entry.type === type && entry.handler === handler,
    );
    if (index >= 0) state.domListeners.splice(index, 1);
    state.guest.effects.push(`removeEventListener ${type}`);
  };
  // The recording cursor writes through `style.setProperty`, `setAttribute` and `remove`; those stay
  // off the enumerable surface so the pinned element snapshots read as plain data.
  const makeElement = (tag: string) => {
    const element: GuestElement = {
      tag,
      attrs: {},
      style: {},
      textContent: "",
      innerHTML: "",
      removed: false,
    };
    Object.defineProperty(element.style, "setProperty", {
      value: (name: string, value: string) => {
        element.style[name] = value;
      },
    });
    Object.defineProperty(element, "setAttribute", {
      value: (name: string, value: string) => {
        element.attrs[name] = value;
      },
    });
    Object.defineProperty(element, "remove", {
      value: () => {
        element.removed = true;
        state.guest.effects.push(`remove ${tag}`);
      },
    });
    state.guest.elements.push(element);
    return element;
  };
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      tag: "html",
      style: { setProperty: () => {} },
      append: (...elements: GuestElement[]) => {
        state.guest.effects.push(`append ${elements.map((element) => element.tag).join(",")}`);
      },
    },
    addEventListener: listen("document"),
    removeEventListener: unlisten("document"),
    get activeElement() {
      return state.guest.activeElement;
    },
    createElement: makeElement,
    getElementById: (id: string) => {
      state.elementLookups.push(id);
      // Only the panel's own buttons exist; anything else behaves like a missing element.
      return id === "app" || id === "close" ? { addEventListener: listen(`#${id}`) } : null;
    },
  };
  const windowStub = {
    addEventListener: listen("window"),
    removeEventListener: unlisten("window"),
    get innerWidth() {
      return state.guest.innerWidth;
    },
    get innerHeight() {
      return state.guest.innerHeight;
    },
    navigator: {
      get platform() {
        return state.guest.platform;
      },
    },
    requestAnimationFrame: (callback: () => void) => {
      const id = state.guest.frames.length + 1;
      state.guest.frames.push({ id, callback, cancelled: false });
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      const frame = state.guest.frames.find((entry) => entry.id === id);
      if (frame !== undefined) frame.cancelled = true;
    },
    setTimeout: (callback: () => void, ms: number) => {
      const id = state.guest.timers.length + 1;
      state.guest.timers.push({ id, ms, callback, cleared: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const timer = state.guest.timers.find((entry) => entry.id === id);
      if (timer !== undefined) timer.cleared = true;
    },
  };
  (globalThis as { window?: unknown }).window = windowStub;
  // `react-grab`'s freeze-updates module, which the pick preload pulls in for its React context
  // lookup, captures `Object.getOwnPropertyDescriptor(Window.prototype, "requestAnimationFrame")?.value
  // ?? window.requestAnimationFrame` at import time and then overwrites both window hooks with
  // wrappers around what it captured. The prototype therefore has to hold the stub's own functions by
  // value: a method that delegated back to `windowStub` would recurse into react-grab's wrapper.
  const WindowStub = function Window() {
    throw new Error("The preload IPC corpus never constructs a Window.");
  };
  Object.assign(WindowStub.prototype, {
    requestAnimationFrame: windowStub.requestAnimationFrame,
    cancelAnimationFrame: windowStub.cancelAnimationFrame,
  });
  (globalThis as { Window?: unknown }).Window ??= WindowStub;
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
    codecs: [],
    badge: {
      effects: [],
      windows: [1],
      focused: false,
      emptyImage: false,
      destroyed: false,
      failing: false,
    },
    helper: {
      effects: [],
      loadedUrls: [],
      windowOptions: [],
      windows: [],
      windowEvents: [],
      webContentsEvents: [],
      windowOpenHandlers: [],
      listeners: [],
      watchers: [],
      exePath: "/Applications/LMCS Code (Nightly).app/Contents/MacOS/LMCS Code",
      mediaAccessStatus: "denied",
      accessibilityTrusted: false,
      iconEmpty: false,
      dragFails: false,
      loadFails: false,
      deliver: false,
      untrustedSender: false,
      untrustedFrame: false,
      visible: false,
      focused: false,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    },
    domListeners: [],
    elementLookups: [],
    guest: {
      effects: [],
      elements: [],
      frames: [],
      timers: [],
      activeElement: null,
      platform: "MacIntel",
      innerWidth: 1440,
      innerHeight: 900,
    },
  };
  installStubLoader();
  installRendererGlobals();

  await import("../src/preload.ts");
  await import("../src/preview-pip-preload.ts");
  await import("../src/mac-permission-preload.ts");
  // Evaluating the shipped method factories records the codecs the main process declares for each
  // channel; the factories run at module scope, so nothing here needs an Electron service.
  await Promise.all(
    [
      "../src/ipc/methods/appActivation.ts",
      "../src/ipc/methods/clientSettings.ts",
      "../src/ipc/methods/connectionCatalog.ts",
      "../src/ipc/methods/deviceToken.ts",
      "../src/ipc/methods/localEnvironment.ts",
      "../src/ipc/methods/notificationBadge.ts",
      "../src/ipc/methods/preview.ts",
      "../src/ipc/methods/serverExposure.ts",
      "../src/ipc/methods/snapShot.ts",
      "../src/ipc/methods/sshEnvironment.ts",
      "../src/ipc/methods/updates.ts",
      "../src/ipc/methods/window.ts",
      "../src/ipc/methods/wsl.ts",
    ].map((specifier) => import(specifier)),
  );

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
  const rawRequestArgs: unknown[][] = [];
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
        rawRequestArgs.push(entry.args);
      }
    }
  };
  walkBridge(bridge, "");

  const sortedEntries = requestRows
    .map((row, index) => ({ row, rawArgs: rawRequestArgs[index] ?? [] }))
    .sort((a, b) => byString(a.row.path, b.row.path));
  const sortedRows = sortedEntries.map((entry) => entry.row);
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

  // The shipped registration pipeline runs here too, against an in-memory `DesktopIpcMain`, so the
  // main-process framing of a request is executed rather than only described. It is also the only
  // way to reach `desktop:set-notification-badge`, whose payload codec is built inside its installer:
  // installing it here puts that codec in the index before the descriptors below are computed.
  const DesktopIpcModule = await import("../src/ipc/DesktopIpc.ts");
  interface FramingEvent {
    readonly sender: { readonly id: number };
  }

  const framingCalls: string[] = [];
  const invokeListeners = new Map<string, (event: FramingEvent, raw: unknown) => unknown>();
  const syncListeners = new Map<string, (event: { returnValue: unknown }) => void>();
  const ipcMainStub = {
    removeHandler: (channel: string) => {
      framingCalls.push(`removeHandler ${channel}`);
      invokeListeners.delete(channel);
    },
    handle: (channel: string, listener: (event: FramingEvent, raw: unknown) => unknown) => {
      framingCalls.push(`handle ${channel}`);
      invokeListeners.set(channel, listener);
    },
    removeAllListeners: (channel: string) => {
      framingCalls.push(`removeAllListeners ${channel}`);
      syncListeners.delete(channel);
    },
    on: (channel: string, listener: (event: { returnValue: unknown }) => void) => {
      framingCalls.push(`on ${channel}`);
      syncListeners.set(channel, listener);
    },
  };
  const ipcService = DesktopIpcModule.make(ipcMainStub);

  const firstFailureLine = (error: unknown) =>
    String((error as { message?: unknown } | undefined)?.message ?? error).split("\n")[0] ?? "";
  /** Effect's default logger prefixes each line with a timestamp and fiber id, so only the message is pinned. */
  const logMessage = (line: string) =>
    (line.split("\n")[0] ?? "").replace(/^\[[^\]]*\]\s*/, "").replace(/^[A-Z]+ \(#\d+\):\s*/, "");
  const framingState = () => framingCalls.length;
  type FramingCodec = Schema.Codec<unknown, unknown, never, never>;

  /**
   * Settles the listener's promise in the same tick it is created. Attaching the rejection handler
   * any later lets Node's default `--unhandled-rejections=throw` kill the process first.
   */
  const settle = (returned: unknown) =>
    Promise.resolve(returned as Promise<unknown>).then(
      (value) => ({ outcome: "resolved" as const, value: jsonSafe(value) }),
      (error: unknown) => ({ outcome: "rejected" as const, message: firstFailureLine(error) }),
    );

  // `applyNotificationBadge` logs through the default Effect logger, whose output would corrupt the
  // JSON this process writes to stdout, so anything that can log runs with stdout captured here.
  const runQuiet = async <A>(effect: Effect.Effect<A, never, never>) => {
    const original = process.stdout.write;
    const lines: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      return { value: await Effect.runPromise(effect), lines };
    } finally {
      process.stdout.write = original;
    }
  };

  const BadgeModule = await import("../src/ipc/methods/notificationBadge.ts");
  const ElectronAppModule = await import("../src/electron/ElectronApp.ts");
  const { HostProcessPlatform } = await import("@lmcstools/core/hostProcess");
  const badgeChannel = IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL;
  const appEvents: { event: string; listener: () => void }[] = [];
  const electronAppStub = {
    on: (event: string, listener: () => void) =>
      Effect.sync(() => {
        appEvents.push({ event, listener });
      }),
  } as unknown as Parameters<typeof ElectronAppModule.ElectronApp.of>[0];

  const resetBadgeStub = (
    setup: Partial<Pick<BadgeStub, "windows" | "focused" | "emptyImage" | "destroyed" | "failing">>,
  ) => {
    state.badge.effects.length = 0;
    Object.assign(
      state.badge,
      { windows: [1], focused: false, emptyImage: false, destroyed: false, failing: false },
      setup,
    );
  };
  const driveBadge = (
    raw: unknown,
    setup: Partial<
      Pick<BadgeStub, "windows" | "focused" | "emptyImage" | "destroyed" | "failing">
    > = {},
  ) => {
    resetBadgeStub(setup);
    const listener = invokeListeners.get(badgeChannel);
    if (listener === undefined) {
      return Effect.succeed({ raw: jsonSafe(raw), outcome: "noListener" as const, effects: [] });
    }
    return Effect.map(
      Effect.promise(() => settle(listener({ sender: { id: 1 } }, raw))),
      (settled) => ({ raw: jsonSafe(raw), ...settled, effects: [...state.badge.effects] }),
    );
  };

  const badgePayloads: unknown[] = [
    { count: 3, image: null },
    { count: 0, image: null },
    { count: 3, image: "data:image/png;base64,AAAA" },
    { count: 3, image: "data:image/png;base64,not base64!!" },
    { count: 3, image: 42 },
    { count: -1, image: null },
    { count: 1.5, image: null },
    { count: 2_147_483_648, image: null },
    { count: 3 },
    {},
    "s0",
    undefined,
  ];
  const badgeOutcomes: Record<string, unknown>[] = [];
  const badgeInstall = await runQuiet(
    Effect.scoped(
      Effect.gen(function* () {
        const before = framingState();
        yield* BadgeModule.installNotificationBadge().pipe(
          Effect.provideService(DesktopIpcModule.DesktopIpc, ipcService),
          Effect.provideService(ElectronAppModule.ElectronApp, electronAppStub),
          Effect.provideService(HostProcessPlatform, "darwin" as NodeJS.Platform),
          Effect.orDie,
        );
        for (const raw of badgePayloads) badgeOutcomes.push(yield* driveBadge(raw));
        const focused = yield* driveBadge({ count: 5, image: null }, { focused: true });
        const failing = yield* driveBadge({ count: 5, image: null }, { failing: true });
        const focusEffects: string[][] = [];
        for (const entry of appEvents) {
          resetBadgeStub({});
          entry.listener();
          focusEffects.push([...state.badge.effects]);
        }
        const result = {
          installCalls: framingCalls.slice(before),
          events: appEvents.map((entry) => entry.event),
          focused,
          focusEffects,
          failing,
        };
        // The scope's finalizer clears the badge only after this body returns, so the recorder is
        // emptied here to keep those effects separate from the ones observed above.
        state.badge.effects.length = 0;
        return result;
      }),
    ),
  );
  const finalizerEffects = [...state.badge.effects];
  state.badge.effects.length = 0;

  // `applyNotificationBadge` is exported and takes the platform as an argument, so the per-platform
  // branches can be driven directly instead of through another installer.
  const applyBranch = (
    platform: NodeJS.Platform,
    badge: { count: number; image: string | null },
    setup: Partial<Pick<BadgeStub, "windows" | "focused" | "emptyImage" | "destroyed">>,
  ) => {
    resetBadgeStub(setup);
    BadgeModule.applyNotificationBadge(platform, badge);
    return [...state.badge.effects];
  };
  const badgeBranches = {
    "darwin count 3": applyBranch("darwin", { count: 3, image: null }, {}),
    "win32 count 3 without image": applyBranch("win32", { count: 3, image: null }, {}),
    "win32 count 3 with image": applyBranch(
      "win32",
      { count: 3, image: "data:image/png;base64,AAAA" },
      {},
    ),
    "win32 empty image": applyBranch(
      "win32",
      { count: 3, image: "data:image/png;base64,AAAA" },
      { emptyImage: true },
    ),
    "win32 count 0 with image": applyBranch(
      "win32",
      { count: 0, image: "data:image/png;base64,AAAA" },
      {},
    ),
    "win32 two windows": applyBranch("win32", { count: 2, image: null }, { windows: [1, 2] }),
    "win32 destroyed windows": applyBranch("win32", { count: 2, image: null }, { destroyed: true }),
    "linux count 4": applyBranch("linux", { count: 4, image: null }, {}),
    "freebsd count 4": applyBranch("freebsd", { count: 4, image: null }, {}),
    "darwin focused zeroes the count": applyBranch(
      "darwin",
      { count: 5, image: null },
      { focused: true },
    ),
  };

  check(
    "notification-badge-installer-registers-on-the-shipped-path",
    "desktop ipc notification badge installation",
    {
      installCalls: badgeInstall.value.installCalls,
      appEvents: badgeInstall.value.events,
      loggedLines: badgeInstall.lines.map(logMessage),
    },
    {
      installCalls: [
        "removeHandler desktop:set-notification-badge",
        "handle desktop:set-notification-badge",
      ],
      appEvents: ["browser-window-focus", "before-quit"],
      loggedLines: ["Could not update notification badge Error: synthetic badge failure"],
    },
  );
  check(
    "notification-badge-payload-validation-and-badge-effects",
    "desktop:set-notification-badge payload validation",
    badgeOutcomes,
    [
      {
        raw: { count: 3, image: null },
        outcome: "resolved",
        value: undefinedMarker,
        effects: ["setBadgeCount 3"],
      },
      {
        raw: { count: 0, image: null },
        outcome: "resolved",
        value: undefinedMarker,
        effects: ["setBadgeCount 0"],
      },
      {
        raw: { count: 3, image: "data:image/png;base64,AAAA" },
        outcome: "resolved",
        value: undefinedMarker,
        effects: ["setBadgeCount 3"],
      },
      {
        raw: { count: 3, image: "data:image/png;base64,not base64!!" },
        outcome: "rejected",
        message:
          "Expected a string matching the RegExp ^data:image\\/png;base64,[a-z0-9+/]+={0,2}$",
        effects: [],
      },
      {
        raw: { count: 3, image: 42 },
        outcome: "rejected",
        message: "Expected string | null",
        effects: [],
      },
      {
        raw: { count: -1, image: null },
        outcome: "rejected",
        message: "Expected a value between 0 and 2147483647",
        effects: [],
      },
      {
        raw: { count: 1.5, image: null },
        outcome: "rejected",
        message: "Expected an integer",
        effects: [],
      },
      {
        raw: { count: 2_147_483_648, image: null },
        outcome: "rejected",
        message: "Expected a value between 0 and 2147483647",
        effects: [],
      },
      { raw: { count: 3 }, outcome: "rejected", message: "Missing key", effects: [] },
      { raw: {}, outcome: "rejected", message: "Missing key", effects: [] },
      { raw: "s0", outcome: "rejected", message: "Expected object", effects: [] },
      { raw: undefinedMarker, outcome: "rejected", message: "Expected object", effects: [] },
    ],
  );
  check(
    "notification-badge-clears-when-a-window-is-focused",
    "desktop:set-notification-badge focused window",
    { focused: badgeInstall.value.focused, failing: badgeInstall.value.failing },
    {
      focused: {
        raw: { count: 5, image: null },
        outcome: "resolved",
        value: undefinedMarker,
        effects: ["setBadgeCount 0", "send desktop:set-notification-badge []"],
      },
      failing: {
        raw: { count: 5, image: null },
        outcome: "resolved",
        value: undefinedMarker,
        effects: [],
      },
    },
  );
  check(
    "notification-badge-platform-branches",
    "desktop ipc notification badge platform branches",
    badgeBranches,
    {
      "darwin count 3": ["setBadgeCount 3"],
      "win32 count 3 without image": [
        'window 1 overlay null description "3 threads with new notifications"',
      ],
      "win32 count 3 with image": [
        "createFromDataURL data:image/png;base64,AA",
        'window 1 overlay image description "3 threads with new notifications"',
      ],
      "win32 empty image": [
        "createFromDataURL data:image/png;base64,AA",
        'window 1 overlay null description "3 threads with new notifications"',
      ],
      "win32 count 0 with image": ['window 1 overlay null description ""'],
      "win32 two windows": [
        'window 1 overlay null description "2 threads with new notifications"',
        'window 2 overlay null description "2 threads with new notifications"',
      ],
      "win32 destroyed windows": [],
      "linux count 4": ["setBadgeCount 4"],
      "freebsd count 4": [],
      "darwin focused zeroes the count": ["setBadgeCount 0"],
    },
  );
  check(
    "notification-badge-focus-listener-and-scope-close-clear-the-badge",
    "desktop ipc notification badge clearing",
    {
      focusEffects: badgeInstall.value.focusEffects,
      finalizerEffects,
    },
    {
      focusEffects: [
        ["setBadgeCount 0", "send desktop:set-notification-badge []"],
        ["setBadgeCount 0", "send desktop:set-notification-badge []"],
      ],
      finalizerEffects: ["setBadgeCount 0", "send desktop:set-notification-badge []"],
    },
  );

  // The macOS permission panel is the one classified IPC surface whose main-process half is a plain
  // `ipcMain.on` listener instead of a `DesktopIpc` method, so the shipped helper runs here: its
  // permission probe, its panel window and HTML, its identity gate, its Settings tracking and its
  // release path. Only the `osascript` watcher is replaced, and the real bounds maths is re-exported.
  const HelperModule = await import("../src/permissions/MacPermissionHelper.ts");
  const helperDefaults = {
    exePath: "/Applications/LMCS Code (Nightly).app/Contents/MacOS/LMCS Code",
    mediaAccessStatus: "denied",
    accessibilityTrusted: false,
    iconEmpty: false,
    dragFails: false,
    loadFails: false,
    deliver: false,
    untrustedSender: false,
    untrustedFrame: false,
    visible: false,
    focused: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  };
  const resetHelper = (setup: Partial<typeof helperDefaults> = {}) => {
    for (const key of [
      "effects",
      "loadedUrls",
      "windowOptions",
      "windows",
      "windowEvents",
      "webContentsEvents",
      "windowOpenHandlers",
      "listeners",
      "watchers",
    ] as const) {
      state.helper[key].length = 0;
    }
    Object.assign(state.helper, helperDefaults, setup);
  };

  const makeOwner = () => {
    const events: { type: string; handler: () => void }[] = [];
    return {
      events,
      isDestroyed: () => false,
      show: () => {
        state.helper.effects.push("owner.show");
      },
      focus: () => {
        state.helper.effects.push("owner.focus");
      },
      once: (type: string, handler: () => void) => {
        events.push({ type, handler });
      },
      removeListener: (type: string, handler: () => void) => {
        const index = events.findIndex((entry) => entry.type === type && entry.handler === handler);
        if (index >= 0) events.splice(index, 1);
        state.helper.effects.push("owner.removeListener " + type);
      },
    };
  };

  type HelperPermission = "screen-recording" | "accessibility" | "full-disk-access";
  const openPanel = async (
    permission: HelperPermission,
    setup: Partial<typeof helperDefaults> = {},
    isGranted?: () => boolean | Promise<boolean>,
  ) => {
    resetHelper(setup);
    const helper = new HelperModule.MacPermissionHelper();
    const owner = makeOwner();
    let thrown: string | null = null;
    try {
      await helper.show(
        permission,
        "/bundle/mac-permission-preload.cjs",
        owner as unknown as Parameters<typeof helper.show>[2],
        ["/bundle/resources/app.asar/icon.png", "/bundle/prod-resources/icon.png"],
        isGranted,
      );
    } catch (error) {
      thrown = firstFailureLine(error);
    }
    return {
      helper,
      owner,
      thrown,
      effects: [...state.helper.effects],
      windows: state.helper.windows.length,
      listeners: state.helper.listeners.length,
      watchers: state.helper.watchers.length,
      html: panelHtml(),
      windowOptions: JSON.parse(JSON.stringify(state.helper.windowOptions)) as Record<
        string,
        unknown
      >[],
      webContentsEvents: [...state.helper.webContentsEvents],
      windowEvents: state.helper.windowEvents.map((entry) => entry.type),
      windowOpenHandlers: state.helper.windowOpenHandlers.length,
    };
  };

  /** Pulls the shipped panel HTML back out of the `data:` URL the helper loaded. */
  const panelHtml = () => {
    const url = state.helper.loadedUrls[state.helper.loadedUrls.length - 1] ?? "";
    const html = decodeURIComponent(url.replace("data:text/html;charset=utf-8,", ""));
    const match = (pattern: RegExp) => pattern.exec(html)?.[1] ?? null;
    return {
      prefix: url.slice(0, 29),
      csp: match(/Content-Security-Policy" content="([^"]+)"/),
      title: match(/<title>([^<]+)<\/title>/),
      header: match(/<header>([^<]+)<\/header>/),
      icon: match(/<img src="([^"]*)"/),
      closeLabel: match(/aria-label="([^"]*)"/),
      draggable: html.includes('id="app" draggable="true"'),
      scripts: (html.match(/<script/g) ?? []).length,
    };
  };

  const lastHelperWindow = () =>
    state.helper.windows[state.helper.windows.length - 1] as
      | { webContents: { mainFrame: unknown } }
      | undefined;

  /** A frame that is a real object but never the panel's own, so the gate has something to reject. */
  const helperDecoyFrame = { frameId: "decoy" };

  const drivePanelAction = (
    raw: unknown,
    identity: {
      sender: "own" | "other";
      senderFrame: "own" | "other" | "missing";
    } = { sender: "own", senderFrame: "own" },
    extraArgs: unknown[] = [],
  ) => {
    state.helper.effects.length = 0;
    const listener = state.helper.listeners[0];
    if (listener === undefined) return { outcome: "noListener" as const, effects: [] };
    const event = {
      sender: identity.sender === "own" ? lastHelperWindow()?.webContents : {},
      senderFrame:
        identity.senderFrame === "own"
          ? lastHelperWindow()?.webContents.mainFrame
          : identity.senderFrame === "other"
            ? helperDecoyFrame
            : undefined,
    };
    try {
      listener.handler(event, raw, ...extraArgs);
      return { outcome: "returned" as const, effects: [...state.helper.effects] };
    } catch (error) {
      return {
        outcome: "threw" as const,
        message: firstFailureLine(error),
        effects: [...state.helper.effects],
      };
    }
  };

  /** Drives the shipped panel preload, whose sends the stub delivers into the live helper listener. */
  const drivePanelDom = async (target: string, type: string, key?: string) => {
    const panel = await openPanel("screen-recording");
    state.helper.deliver = true;
    const start = state.sends.length;
    state.helper.effects.length = 0;
    fire(state, target, type, key);
    state.helper.deliver = false;
    return {
      opened: panel.windows,
      sends: state.sends.slice(start).map((entry) => entry.args.join(",")),
      effects: [...state.helper.effects],
    };
  };

  const driveWatcher = (drive: "settings" | "unavailable", settings?: unknown) => {
    state.helper.effects.length = 0;
    const watcher = state.helper.watchers[state.helper.watchers.length - 1];
    if (watcher === undefined) return { outcome: "noWatcher" as const, effects: [] };
    if (drive === "settings") watcher.onChange(settings);
    else watcher.onUnavailable();
    return { outcome: "returned" as const, effects: [...state.helper.effects] };
  };

  const fireWindowEvent = (type: string) => {
    state.helper.effects.length = 0;
    for (const entry of state.helper.windowEvents) {
      if (entry.type === type) entry.handler();
    }
    return [...state.helper.effects];
  };

  const sendsBeforeHelper = state.sends.length;
  const helperOpen = await openPanel("screen-recording");
  const helperTitles: Record<string, unknown> = {};
  for (const permission of ["screen-recording", "accessibility", "full-disk-access"] as const) {
    const panel = await openPanel(permission);
    helperTitles[permission] = {
      title: panel.html.title,
      probe: panel.effects.filter(
        (effect) =>
          effect.startsWith("getMediaAccessStatus") ||
          effect.startsWith("isTrustedAccessibilityClient"),
      ),
    };
  }
  const summarizePanel = (panel: Awaited<ReturnType<typeof openPanel>>) => ({
    thrown: panel.thrown,
    effects: panel.effects,
    windows: panel.windows,
    listeners: panel.listeners,
    watchers: panel.watchers,
  });
  const helperShortCircuits = {
    "screen recording granted": summarizePanel(
      await openPanel("screen-recording", { mediaAccessStatus: "granted" }),
    ),
    "accessibility granted": summarizePanel(
      await openPanel("accessibility", { accessibilityTrusted: true }),
    ),
    "accessibility probe": summarizePanel(await openPanel("accessibility")),
    "non bundle executable": summarizePanel(
      await openPanel("screen-recording", { exePath: "/usr/local/bin/electron" }),
    ),
    "missing packaged icon": summarizePanel(
      await openPanel("screen-recording", { iconEmpty: true }),
    ),
    "panel page fails to load": summarizePanel(
      await openPanel("screen-recording", { loadFails: true }),
    ),
  };

  // The shipped guard closes over the helper's own generation counter: a panel whose initial probe
  // resolves after `close()` must not open.
  const helperSuperseded = await (async () => {
    resetHelper({});
    const helper = new HelperModule.MacPermissionHelper();
    let releaseProbe = () => {};
    const pending = helper.show(
      "screen-recording",
      "/bundle/mac-permission-preload.cjs",
      null,
      ["/bundle/prod-resources/icon.png"],
      () =>
        new Promise<boolean>((resolve) => {
          releaseProbe = () => {
            resolve(false);
          };
        }),
    );
    helper.close();
    releaseProbe();
    let thrown: string | null = null;
    try {
      await pending;
    } catch (error) {
      thrown = firstFailureLine(error);
    }
    return {
      thrown,
      effects: [...state.helper.effects],
      windows: state.helper.windows.length,
      listeners: state.helper.listeners.length,
    };
  })();

  const helperDomActions = {
    dragstart: await drivePanelDom("#app", "dragstart"),
    click: await drivePanelDom("#app", "click"),
    close: await drivePanelDom("#close", "click"),
    escape: await drivePanelDom("document", "keydown", "Escape"),
    otherKey: await drivePanelDom("document", "keydown", "a"),
  };

  const helperIdentityGate = await (async () => {
    const rows: Record<string, unknown> = {};
    const drive = async (
      label: string,
      raw: unknown,
      identity?: Parameters<typeof drivePanelAction>[1],
      extraArgs?: unknown[],
    ) => {
      await openPanel("screen-recording");
      rows[label] = drivePanelAction(raw, identity, extraArgs);
    };
    await drive("own sender and own frame", "drag");
    await drive("other sender", "drag", { sender: "other", senderFrame: "own" });
    await drive("other frame", "drag", { sender: "own", senderFrame: "other" });
    await drive("missing frame", "drag", { sender: "own", senderFrame: "missing" });
    await drive("both other", "drag", { sender: "other", senderFrame: "other" });
    await drive("finder through the gate", "finder");
    await drive("extra positional arguments", "close", undefined, ["drag", {}]);
    await drive("close through the gate", "close");
    // No re-arm here: the row above closed the panel, so this is what a stale send looks like.
    rows["action after the panel closed"] = drivePanelAction("drag");
    await openPanel("screen-recording", { dragFails: true });
    rows["native drag throwing"] = drivePanelAction("drag");
    state.helper.dragFails = false;
    return rows;
  })();

  const helperMalformed = await (async () => {
    const rows: Record<string, unknown> = {};
    for (const raw of [
      "drag",
      "finder",
      "close",
      "DRAG",
      "drag ",
      "",
      "close all",
      42,
      0,
      true,
      false,
      null,
      undefined,
      {},
      { action: "close" },
      ["close"],
    ]) {
      await openPanel("screen-recording");
      rows[JSON.stringify(raw) ?? "undefined"] = drivePanelAction(raw);
    }
    return rows;
  })();

  await openPanel("screen-recording");
  const helperTracking = {
    "settings window in front": driveWatcher("settings", {
      x: 100,
      y: 200,
      width: 1200,
      height: 900,
      frontmost: true,
    }),
    "settings window not frontmost": driveWatcher("settings", {
      x: 100,
      y: 200,
      width: 1200,
      height: 900,
      frontmost: false,
    }),
    "panel focused while settings is not": (() => {
      state.helper.focused = true;
      const row = driveWatcher("settings", {
        x: 100,
        y: 200,
        width: 1200,
        height: 900,
        frontmost: false,
      });
      state.helper.focused = false;
      return row;
    })(),
    "narrow settings window": driveWatcher("settings", {
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      frontmost: true,
    }),
    "already at the target bounds": (() => {
      const row = driveWatcher("settings", {
        x: 100,
        y: 200,
        width: 1200,
        height: 900,
        frontmost: true,
      });
      state.helper.bounds = { x: 528, y: 944, width: 560, height: 140 };
      const settled = driveWatcher("settings", {
        x: 100,
        y: 200,
        width: 1200,
        height: 900,
        frontmost: true,
      });
      state.helper.bounds = helperDefaults.bounds;
      return { moved: row, settled };
    })(),
    "already visible": (() => {
      state.helper.visible = true;
      const row = driveWatcher("settings", {
        x: 100,
        y: 200,
        width: 1200,
        height: 900,
        frontmost: true,
      });
      state.helper.visible = false;
      return row;
    })(),
    "blur resyncs while the panel is alive": fireWindowEvent("blur"),
    "tracking unavailable": driveWatcher("unavailable"),
    "settings window disappeared": driveWatcher("settings", null),
    "blur after the panel closed": fireWindowEvent("blur"),
  };

  const helperClose = await (async () => {
    const panel = await openPanel("screen-recording");
    const ownerClosed = (() => {
      state.helper.effects.length = 0;
      for (const entry of panel.owner.events) {
        if (entry.type === "closed") entry.handler();
      }
      return [...state.helper.effects];
    })();
    const afterOwnerClose = drivePanelAction("close");
    const reopened = await openPanel("screen-recording");
    const closed = (() => {
      state.helper.effects.length = 0;
      reopened.helper.close();
      return [...state.helper.effects];
    })();
    return {
      ownerClosed,
      afterOwnerClose,
      reopenedWindows: reopened.windows,
      closed,
      afterClose: drivePanelAction("close"),
      listeners: state.helper.listeners.length,
    };
  })();
  state.sends.length = sendsBeforeHelper;

  check(
    "mac-permission-helper-opens-one-panel-and-arms-its-listener",
    "mac permission helper panel",
    {
      effects: helperOpen.effects,
      html: helperOpen.html,
      window: helperOpen.windowOptions,
      webContentsEvents: helperOpen.webContentsEvents,
      windowEvents: helperOpen.windowEvents,
      windowOpenHandlers: helperOpen.windowOpenHandlers,
      titles: helperTitles,
    },
    {
      effects: [
        "getMediaAccessStatus screen",
        "createFromPath /bundle/resources/app.asar/icon.png",
        "createFromPath /bundle/prod-resources/icon.png",
        'resize {"width":64,"height":64}',
        "window.on blur",
        "ipcMain.on desktop:mac-permission-helper",
        "window.once closed",
        "watchMacSettingsWindow",
      ],
      html: {
        prefix: "data:text/html;charset=utf-8,",
        csp: "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        title: "Set up Screen Recording",
        header: "↑ Drag LMCS Code into the list above",
        icon: "data:image/png;base64,AAAA",
        closeLabel: "Close permission helper",
        draggable: true,
        scripts: 0,
      },
      window: [
        {
          width: 560,
          height: 140,
          show: false,
          frame: false,
          transparent: true,
          roundedCorners: false,
          backgroundColor: "#00000000",
          hasShadow: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          title: "Set up Screen Recording",
          webPreferences: {
            preload: "/bundle/mac-permission-preload.cjs",
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      ],
      webContentsEvents: ["will-navigate"],
      windowEvents: ["blur", "closed"],
      windowOpenHandlers: 1,
      titles: {
        "screen-recording": {
          title: "Set up Screen Recording",
          probe: ["getMediaAccessStatus screen"],
        },
        accessibility: {
          title: "Set up Accessibility",
          probe: ["isTrustedAccessibilityClient false"],
        },
        "full-disk-access": { title: "Set up Full Disk Access", probe: [] },
      },
    },
  );
  check(
    "mac-permission-helper-short-circuits-before-opening-a-panel",
    "mac permission helper gates",
    helperShortCircuits,
    {
      "screen recording granted": {
        thrown: null,
        effects: ["getMediaAccessStatus screen"],
        windows: 0,
        listeners: 0,
        watchers: 0,
      },
      "accessibility granted": {
        thrown: null,
        effects: ["isTrustedAccessibilityClient false"],
        windows: 0,
        listeners: 0,
        watchers: 0,
      },
      "accessibility probe": {
        thrown: null,
        effects: [
          "isTrustedAccessibilityClient false",
          "createFromPath /bundle/resources/app.asar/icon.png",
          "createFromPath /bundle/prod-resources/icon.png",
          'resize {"width":64,"height":64}',
          "window.on blur",
          "ipcMain.on desktop:mac-permission-helper",
          "window.once closed",
          "watchMacSettingsWindow",
        ],
        windows: 1,
        listeners: 1,
        watchers: 1,
      },
      "non bundle executable": {
        thrown: null,
        effects: ["getMediaAccessStatus screen"],
        windows: 0,
        listeners: 0,
        watchers: 0,
      },
      "missing packaged icon": {
        thrown: "The packaged LMCS Code icon is missing.",
        effects: [
          "getMediaAccessStatus screen",
          "createFromPath /bundle/resources/app.asar/icon.png",
          "createFromPath /bundle/prod-resources/icon.png",
        ],
        windows: 0,
        listeners: 0,
        watchers: 0,
      },
      "panel page fails to load": {
        thrown: "synthetic load failure",
        effects: [
          "getMediaAccessStatus screen",
          "createFromPath /bundle/resources/app.asar/icon.png",
          "createFromPath /bundle/prod-resources/icon.png",
          'resize {"width":64,"height":64}',
          "window.on blur",
          "ipcMain.on desktop:mac-permission-helper",
          "window.once closed",
          "window.destroy",
          "ipcMain.removeListener desktop:mac-permission-helper",
          "owner.removeListener closed",
        ],
        windows: 1,
        listeners: 0,
        watchers: 0,
      },
    },
  );
  check(
    "mac-permission-helper-does-not-reopen-a-superseded-panel",
    "mac permission helper generation",
    helperSuperseded,
    { thrown: null, effects: [], windows: 0, listeners: 0 },
  );
  check(
    "mac-permission-preload-actions-reach-the-real-handler",
    "mac permission helper actions",
    helperDomActions,
    {
      dragstart: {
        opened: 1,
        sends: ["drag"],
        effects: ["startDrag /Applications/LMCS Code (Nightly).app"],
      },
      click: {
        opened: 1,
        sends: ["finder"],
        effects: ["showItemInFolder /Applications/LMCS Code (Nightly).app"],
      },
      close: {
        opened: 1,
        sends: ["close"],
        effects: [
          "window.close",
          "window.destroy",
          "stopTracking",
          "ipcMain.removeListener desktop:mac-permission-helper",
          "owner.removeListener closed",
          "owner.show",
          "owner.focus",
        ],
      },
      escape: {
        opened: 1,
        sends: ["close"],
        effects: [
          "window.close",
          "window.destroy",
          "stopTracking",
          "ipcMain.removeListener desktop:mac-permission-helper",
          "owner.removeListener closed",
          "owner.show",
          "owner.focus",
        ],
      },
      otherKey: { opened: 1, sends: [], effects: [] },
    },
  );
  check(
    "mac-permission-helper-identity-gate-drops-other-renderers",
    "mac permission helper sender gate",
    helperIdentityGate,
    {
      "own sender and own frame": {
        outcome: "returned",
        effects: ["startDrag /Applications/LMCS Code (Nightly).app"],
      },
      "other sender": { outcome: "returned", effects: [] },
      "other frame": { outcome: "returned", effects: [] },
      "missing frame": { outcome: "returned", effects: [] },
      "both other": { outcome: "returned", effects: [] },
      "finder through the gate": {
        outcome: "returned",
        effects: ["showItemInFolder /Applications/LMCS Code (Nightly).app"],
      },
      "extra positional arguments": {
        outcome: "returned",
        effects: [
          "window.close",
          "window.destroy",
          "stopTracking",
          "ipcMain.removeListener desktop:mac-permission-helper",
          "owner.removeListener closed",
          "owner.show",
          "owner.focus",
        ],
      },
      "close through the gate": {
        outcome: "returned",
        effects: [
          "window.close",
          "window.destroy",
          "stopTracking",
          "ipcMain.removeListener desktop:mac-permission-helper",
          "owner.removeListener closed",
          "owner.show",
          "owner.focus",
        ],
      },
      "action after the panel closed": { outcome: "noListener", effects: [] },
      "native drag throwing": {
        outcome: "returned",
        effects: ["showItemInFolder /Applications/LMCS Code (Nightly).app"],
      },
    },
  );
  check(
    "mac-permission-helper-ignores-actions-outside-its-three-strings",
    "mac permission helper action validation",
    helperMalformed,
    {
      '"drag"': {
        outcome: "returned",
        effects: ["startDrag /Applications/LMCS Code (Nightly).app"],
      },
      '"finder"': {
        outcome: "returned",
        effects: ["showItemInFolder /Applications/LMCS Code (Nightly).app"],
      },
      '"close"': {
        outcome: "returned",
        effects: [
          "window.close",
          "window.destroy",
          "stopTracking",
          "ipcMain.removeListener desktop:mac-permission-helper",
          "owner.removeListener closed",
          "owner.show",
          "owner.focus",
        ],
      },
      '"DRAG"': { outcome: "returned", effects: [] },
      '"drag "': { outcome: "returned", effects: [] },
      '""': { outcome: "returned", effects: [] },
      '"close all"': { outcome: "returned", effects: [] },
      "42": { outcome: "returned", effects: [] },
      "0": { outcome: "returned", effects: [] },
      true: { outcome: "returned", effects: [] },
      false: { outcome: "returned", effects: [] },
      null: { outcome: "returned", effects: [] },
      undefined: { outcome: "returned", effects: [] },
      "{}": { outcome: "returned", effects: [] },
      '{"action":"close"}': { outcome: "returned", effects: [] },
      '["close"]': { outcome: "returned", effects: [] },
    },
  );
  check(
    "mac-permission-helper-tracks-the-settings-window",
    "mac permission helper tracking",
    helperTracking,
    {
      "settings window in front": {
        outcome: "returned",
        effects: [
          'setBounds {"x":528,"y":944,"width":560,"height":140} animate false',
          "window.showInactive",
        ],
      },
      "settings window not frontmost": { outcome: "returned", effects: ["window.hide"] },
      "panel focused while settings is not": {
        outcome: "returned",
        effects: [
          'setBounds {"x":528,"y":944,"width":560,"height":140} animate false',
          "window.showInactive",
        ],
      },
      "narrow settings window": {
        outcome: "returned",
        effects: [
          'setBounds {"x":232,"y":244,"width":352,"height":140} animate false',
          "window.showInactive",
        ],
      },
      "already at the target bounds": {
        moved: {
          outcome: "returned",
          effects: [
            'setBounds {"x":528,"y":944,"width":560,"height":140} animate false',
            "window.showInactive",
          ],
        },
        settled: { outcome: "returned", effects: ["window.showInactive"] },
      },
      "already visible": {
        outcome: "returned",
        effects: ['setBounds {"x":528,"y":944,"width":560,"height":140} animate false'],
      },
      "blur resyncs while the panel is alive": [
        'setBounds {"x":528,"y":944,"width":560,"height":140} animate false',
        "window.showInactive",
      ],
      "tracking unavailable": { outcome: "returned", effects: ["window.hide"] },
      "settings window disappeared": {
        outcome: "returned",
        effects: [
          "window.close",
          "window.destroy",
          "stopTracking",
          "ipcMain.removeListener desktop:mac-permission-helper",
          "owner.removeListener closed",
          "owner.show",
          "owner.focus",
        ],
      },
      "blur after the panel closed": [],
    },
  );
  check(
    "mac-permission-helper-releases-its-listener-when-the-panel-closes",
    "mac permission helper release",
    helperClose,
    {
      ownerClosed: [
        "window.destroy",
        "stopTracking",
        "ipcMain.removeListener desktop:mac-permission-helper",
        "owner.removeListener closed",
      ],
      afterOwnerClose: { outcome: "noListener", effects: [] },
      reopenedWindows: 1,
      closed: [
        "window.destroy",
        "stopTracking",
        "ipcMain.removeListener desktop:mac-permission-helper",
        "owner.removeListener closed",
      ],
      afterClose: { outcome: "noListener", effects: [] },
      listeners: 0,
    },
  );

  // The main process registers `(event, raw) => handler(raw, event)`, so only the first positional
  // argument of a request ever reaches the declared payload codec.
  const codecsByChannel = new Map<string, CapturedCodec>();
  const duplicateCodecChannels: string[] = [];
  for (const codec of state.codecs) {
    if (codecsByChannel.has(codec.channel)) duplicateCodecChannels.push(codec.channel);
    else codecsByChannel.set(codec.channel, codec);
  }

  interface PayloadDescriptor {
    readonly channel: string;
    readonly constant: string;
    readonly kind: "invoke" | "sync" | "none";
    readonly astTag: string;
    readonly shape:
      | "array"
      | "notCaptured"
      | "object"
      | "other"
      | "primitive"
      | "sync"
      | "undefinedPayload"
      | "union"
      | "void";
    readonly requiredKeys: string[];
    readonly optionalKeys: string[];
    readonly acceptsNoPayload: boolean;
  }

  const decodesFromTheWire = (schema: unknown, value: unknown) =>
    Schema.decodeUnknownOption(schema as Schema.ConstraintDecoder<unknown, never>)(value)._tag ===
    "Some";

  const shapeOfTag = (astTag: string): PayloadDescriptor["shape"] => {
    if (astTag === "Objects") return "object";
    if (astTag === "Void") return "void";
    if (astTag === "Undefined") return "undefinedPayload";
    if (astTag === "Arrays") return "array";
    if (astTag === "Union") return "union";
    if (astTag === "String" || astTag === "Number" || astTag === "Boolean") return "primitive";
    return "other";
  };

  const describePayload = (channel: string): PayloadDescriptor => {
    const codec = codecsByChannel.get(channel);
    const base = {
      channel,
      constant: constantByChannel.get(channel) ?? "",
      requiredKeys: [] as string[],
      optionalKeys: [] as string[],
    };
    if (codec === undefined) {
      return {
        ...base,
        kind: "none",
        astTag: "notCaptured",
        shape: "notCaptured",
        acceptsNoPayload: false,
      };
    }
    if (codec.kind === "sync") {
      return { ...base, kind: "sync", astTag: "noPayload", shape: "sync", acceptsNoPayload: true };
    }
    const ast = (codec.payload as { ast?: unknown } | undefined)?.ast as
      | { _tag?: unknown; propertySignatures?: unknown }
      | undefined;
    const astTag = typeof ast?._tag === "string" ? ast._tag : "missing";
    const shape = shapeOfTag(astTag);
    const requiredKeys: string[] = [];
    const optionalKeys: string[] = [];
    if (shape === "object") {
      for (const signature of Array.isArray(ast?.propertySignatures)
        ? ast.propertySignatures
        : []) {
        const entry = signature as {
          name?: unknown;
          type?: { context?: { isOptional?: unknown } };
        };
        if (typeof entry.name !== "string") continue;
        (entry.type?.context?.isOptional === true ? optionalKeys : requiredKeys).push(entry.name);
      }
    }
    return {
      ...base,
      kind: "invoke",
      astTag,
      shape,
      requiredKeys: requiredKeys.sort(byString),
      optionalKeys: optionalKeys.sort(byString),
      acceptsNoPayload: decodesFromTheWire(codec.payload, undefined),
    };
  };

  const requestPayloadCodecs = requestChannels.map(describePayload);
  const descriptorByChannel = new Map(
    requestPayloadCodecs.map((descriptor) => [descriptor.channel, descriptor]),
  );

  check(
    "main-process-codecs-are-declared-for-every-request-channel",
    "desktop ipc declared request payload codecs",
    {
      capturedCodecs: state.codecs.length,
      distinctCodecChannels: codecsByChannel.size,
      duplicateCodecChannels: [...new Set(duplicateCodecChannels)].sort(byString),
      requestChannelsWithoutCodec: requestChannels.filter(
        (channel) => !codecsByChannel.has(channel),
      ),
      codecChannelsNeverRequested: [...codecsByChannel.keys()]
        .filter((channel) => !requestChannels.includes(channel))
        .sort(byString),
      requestChannelCount: requestChannels.length,
    },
    {
      capturedCodecs: 99,
      distinctCodecChannels: 99,
      duplicateCodecChannels: [],
      requestChannelsWithoutCodec: [],
      codecChannelsNeverRequested: [],
      requestChannelCount: 99,
    },
  );

  const shapeCounts = requestPayloadCodecs.reduce<Record<string, number>>((counts, descriptor) => {
    counts[descriptor.shape] = (counts[descriptor.shape] ?? 0) + 1;
    return counts;
  }, {});
  check(
    "declared-request-payload-codec-shapes",
    "desktop ipc request payload shapes",
    {
      shapeCounts,
      shapesTotal: requestPayloadCodecs.length,
      unclassifiedAstTags: requestPayloadCodecs
        .filter((descriptor) => descriptor.shape === "other")
        .map((descriptor) => `${descriptor.channel} ${descriptor.astTag}`)
        .sort(byString),
    },
    {
      shapeCounts: {
        primitive: 13,
        union: 11,
        object: 50,
        void: 17,
        sync: 5,
        undefinedPayload: 3,
      },
      shapesTotal: 99,
      unclassifiedAstTags: [],
    },
  );

  const payloadFreeRows = sortedEntries.filter(
    (entry) =>
      entry.row.kind === "invoke" && (entry.rawArgs.length === 0 || entry.rawArgs[0] === undefined),
  );
  check(
    "payload-free-request-envelopes-decode-under-the-declared-codec",
    "desktop ipc zero-payload requests",
    {
      auditedCount: payloadFreeRows.length,
      rejectedPaths: payloadFreeRows
        .filter((entry) => {
          const codec = codecsByChannel.get(entry.row.channel);
          return codec === undefined || !decodesFromTheWire(codec.payload, undefined);
        })
        .map((entry) => entry.row.path),
    },
    { auditedCount: 20, rejectedPaths: [] },
  );

  interface EnvelopeAudit {
    readonly path: string;
    readonly channel: string;
    readonly bucket: string;
    readonly envelope: string;
    readonly missingRequired?: string[];
    readonly undeclaredKeys?: string[];
  }

  const envelopeAudits = sortedEntries
    .filter((entry) => entry.row.kind === "invoke")
    .map((entry): EnvelopeAudit => {
      const descriptor = descriptorByChannel.get(entry.row.channel);
      const raw = entry.rawArgs[0];
      const isPlainObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
      if (descriptor === undefined || descriptor.shape !== "object") {
        return {
          path: entry.row.path,
          channel: entry.row.channel,
          bucket: descriptor === undefined ? "noCodec" : `${descriptor.shape}Codec`,
          envelope: isPlainObject ? "object" : raw === undefined ? "undefined" : typeof raw,
        };
      }
      if (!isPlainObject) {
        return {
          path: entry.row.path,
          channel: entry.row.channel,
          bucket: "forwardedUntouched",
          envelope: raw === undefined ? "undefined" : typeof raw,
        };
      }
      const sentKeys = Object.keys(raw);
      const missingRequired = descriptor.requiredKeys.filter((key) => !sentKeys.includes(key));
      const undeclaredKeys = sentKeys.filter(
        (key) => !descriptor.requiredKeys.includes(key) && !descriptor.optionalKeys.includes(key),
      );
      return {
        path: entry.row.path,
        channel: entry.row.channel,
        bucket: "rebuilt",
        envelope: "object",
        ...(missingRequired.length > 0 ? { missingRequired } : {}),
        ...(undeclaredKeys.length > 0 ? { undeclaredKeys } : {}),
      };
    });
  const bucketCount = (bucket: string) =>
    envelopeAudits.filter((audit) => audit.bucket === bucket).length;
  check(
    "request-envelope-keys-match-the-declared-payload-codec",
    "desktop ipc request envelope keys",
    {
      rebuiltEnvelopes: bucketCount("rebuilt"),
      mismatches: envelopeAudits
        .filter(
          (audit) => audit.missingRequired !== undefined || audit.undeclaredKeys !== undefined,
        )
        .map((audit) => ({
          path: audit.path,
          missingRequired: audit.missingRequired ?? [],
          undeclaredKeys: audit.undeclaredKeys ?? [],
        })),
    },
    { rebuiltEnvelopes: 43, mismatches: [] },
  );
  check(
    "request-envelopes-by-declared-codec-shape",
    "desktop ipc request envelope buckets",
    {
      buckets: envelopeAudits
        .map((audit) => `${audit.bucket} ${audit.envelope}`)
        .sort(byString)
        .reduce<Record<string, number>>((counts, key) => {
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {}),
      forwardedUntouched: envelopeAudits
        .filter((audit) => audit.bucket === "forwardedUntouched")
        .map((audit) => audit.path)
        .sort(byString),
    },
    {
      buckets: {
        "forwardedUntouched string": 7,
        "primitiveCodec string": 13,
        "rebuilt object": 43,
        "undefinedPayloadCodec undefined": 3,
        "unionCodec string": 11,
        "voidCodec undefined": 17,
      },
      forwardedUntouched: [
        "disconnectSshEnvironment",
        "preview.importBrowserCookies",
        "previewSnapShotConfig",
        "setClientSettings",
        "setNotificationBadge",
        "setSnapShotAnimationDestination",
        "setTailscaleServeEnabled",
      ],
    },
  );

  check(
    "every-request-channel-carries-a-single-payload-argument",
    "desktop ipc positional request arguments",
    sortedEntries
      .filter((entry) => entry.row.kind === "invoke" && entry.rawArgs.length > 1)
      .map((entry) => ({ path: entry.row.path, channel: entry.row.channel })),
    [],
  );

  // The framing fixtures below reuse the in-memory `DesktopIpcMain` harness declared ahead of the
  // codec index, because the real badge handler installs into that same service.

  /** Registers one synthetic invoke method, drives its shipped listener, and reports the wire view. */
  const frameInvoke = async (options: {
    readonly channel: string;
    readonly payload: unknown;
    readonly result: unknown;
    readonly handlerValue?: unknown;
    readonly raws: unknown[];
  }) => {
    const handlerInputs: unknown[] = [];
    const method = DesktopIpcModule.makeIpcMethod({
      channel: options.channel,
      payload: options.payload as FramingCodec,
      result: options.result as FramingCodec,
      handler: (input: unknown) => {
        handlerInputs.push(jsonSafe(input));
        return Effect.succeed("handlerValue" in options ? options.handlerValue : (input as never));
      },
    });
    const outcomes: Record<string, unknown>[] = [];
    const before = framingState();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ipcService.handle(method);
          for (const raw of options.raws) {
            const listener = invokeListeners.get(options.channel);
            if (listener === undefined) {
              outcomes.push({ raw: jsonSafe(raw), outcome: "noListener" });
              continue;
            }
            const settled = yield* Effect.promise(() =>
              settle(listener({ sender: { id: 1 } }, raw)),
            );
            outcomes.push({ raw: jsonSafe(raw), ...settled });
          }
        }),
      ),
    );
    return { handlerInputs, outcomes, calls: framingCalls.slice(before) };
  };

  /** Drives the shipped sync listener and reports what landed on `event.returnValue`. */
  const frameSync = async (options: {
    readonly channel: string;
    readonly result: unknown;
    readonly handlerValue: unknown;
    readonly drives: number;
  }) => {
    const method = DesktopIpcModule.makeSyncIpcMethod({
      channel: options.channel,
      result: options.result as FramingCodec,
      handler: () => Effect.succeed(options.handlerValue),
    });
    const events: Record<string, unknown>[] = [];
    const before = framingState();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ipcService.handleSync(method);
          for (let index = 0; index < options.drives; index += 1) {
            const event = { returnValue: "untouched" };
            const listener = syncListeners.get(options.channel);
            let thrown: string | null = null;
            if (listener === undefined) {
              thrown = "noListener";
            } else {
              // The shipped sync listener lets a failed result encode escape; catching it here is
              // what shows that `event.returnValue` is never written in that case.
              try {
                listener(event);
              } catch (error) {
                thrown = firstFailureLine(error);
              }
            }
            events.push({
              outcome: thrown === null ? "returned" : "threw",
              returnValue: jsonSafe(event.returnValue),
              thrown,
            });
          }
        }),
      ),
    );
    return { events, calls: framingCalls.slice(before) };
  };

  const tabIdPayload = Schema.Struct({ tabId: Schema.String });
  const decodeFraming = await frameInvoke({
    channel: "desktop:framing-decode",
    payload: tabIdPayload,
    result: tabIdPayload,
    raws: [{ tabId: "t" }, { tabId: "t", extra: "dropped" }, { tabId: 42 }, {}, "s0", undefined],
  });
  check(
    "main-listener-decodes-the-payload-before-the-handler-runs",
    "desktop ipc main listener payload decoding",
    decodeFraming.outcomes,
    [
      { raw: { tabId: "t" }, outcome: "resolved", value: { tabId: "t" } },
      { raw: { tabId: "t", extra: "dropped" }, outcome: "resolved", value: { tabId: "t" } },
      { raw: { tabId: 42 }, outcome: "rejected", message: "Expected string" },
      { raw: {}, outcome: "rejected", message: "Missing key" },
      { raw: "s0", outcome: "rejected", message: "Expected object" },
      { raw: undefinedMarker, outcome: "rejected", message: "Expected object" },
    ],
  );
  check(
    "main-listener-hands-the-handler-a-decoded-not-a-raw-object",
    "desktop ipc main listener decoded input",
    decodeFraming.handlerInputs,
    [{ tabId: "t" }, { tabId: "t" }],
  );

  const encodeFraming = await frameInvoke({
    channel: "desktop:framing-encode",
    payload: Schema.Boolean,
    result: Schema.Boolean,
    handlerValue: "yes",
    raws: [true],
  });
  const voidFraming = await frameInvoke({
    channel: "desktop:framing-void",
    payload: Schema.Boolean,
    result: Schema.Void,
    handlerValue: "ignored",
    raws: [true],
  });
  check(
    "main-listener-encodes-the-handler-result-through-the-declared-codec",
    "desktop ipc main listener result encoding",
    {
      invalidResult: encodeFraming.outcomes,
      voidResult: voidFraming.outcomes,
    },
    {
      invalidResult: [{ raw: true, outcome: "rejected", message: "Expected boolean" }],
      voidResult: [{ raw: true, outcome: "resolved", value: undefinedMarker }],
    },
  );

  const okSync = await frameSync({
    channel: "desktop:framing-sync",
    result: Schema.String,
    handlerValue: "ok",
    drives: 1,
  });
  const badSync = await frameSync({
    channel: "desktop:framing-sync-bad",
    result: Schema.String,
    handlerValue: 42,
    drives: 2,
  });
  check(
    "sync-listener-writes-the-encoded-result-to-the-return-value",
    "desktop ipc sync listener return value",
    { ok: okSync.events, invalid: badSync.events },
    {
      ok: [{ outcome: "returned", returnValue: "ok", thrown: null }],
      invalid: [
        { outcome: "threw", returnValue: "untouched", thrown: "Expected string" },
        { outcome: "threw", returnValue: "untouched", thrown: "Expected string" },
      ],
    },
  );
  check(
    "registration-replaces-the-listener-and-releases-it-when-the-scope-closes",
    "desktop ipc registration lifecycle",
    {
      invoke: decodeFraming.calls,
      sync: okSync.calls,
      syncAgain: badSync.calls,
    },
    {
      invoke: [
        "removeHandler desktop:framing-decode",
        "handle desktop:framing-decode",
        "removeHandler desktop:framing-decode",
      ],
      sync: [
        "removeAllListeners desktop:framing-sync",
        "on desktop:framing-sync",
        "removeAllListeners desktop:framing-sync",
      ],
      syncAgain: [
        "removeAllListeners desktop:framing-sync-bad",
        "on desktop:framing-sync-bad",
        "removeAllListeners desktop:framing-sync-bad",
      ],
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

  // The preview pick preload is the fourth entry point and speaks a separate `preview:*` guest
  // protocol that the desktop channel inventory does not cover at all. Its recording cursor runs for
  // real against the stubbed DOM, so the `preview:recording-input` payloads pinned below are the ones
  // the shipped guest emits, not fixtures the corpus invented.
  const GuestProtocol = await import("../src/preview/GuestProtocol.ts");
  const guestConstantByChannel = new Map<string, string>();
  for (const [name, channel] of Object.entries(GuestProtocol as Record<string, unknown>)) {
    if (name.endsWith("_CHANNEL") && typeof channel === "string") {
      guestConstantByChannel.set(channel, name);
    }
  }
  const guestChannel = (name: string): string => {
    const channel = (GuestProtocol as Record<string, string>)[name];
    if (channel === undefined) throw new Error(`Missing guest channel constant: ${name}`);
    return channel;
  };
  const guestConstant = (channel: string) => guestConstantByChannel.get(channel) ?? channel;
  const recordingInputChannel = guestChannel("RECORDING_INPUT_CHANNEL");
  const guestSends = (start: number, only?: string) =>
    state.sends
      .slice(start)
      .filter((entry) => only === undefined || entry.channel === only)
      .map((entry) => ({ channel: guestConstant(entry.channel), args: jsonSafe(entry.args) }));
  const driveGuestWindow = (type: string, event: Record<string, unknown> = {}) => {
    const sends = state.sends.length;
    const effects = state.guest.effects.length;
    const listeners = state.domListeners.filter(
      (entry) => entry.target === "window" && entry.type === type,
    );
    const prevented: string[] = [];
    const stopped: string[] = [];
    for (const entry of listeners) {
      entry.handler({
        preventDefault: () => prevented.push(type),
        stopImmediatePropagation: () => stopped.push(type),
        ...event,
        type,
      });
    }
    return {
      listeners: listeners.length,
      prevented: prevented.length,
      stopped: stopped.length,
      sends: guestSends(sends),
      effects: state.guest.effects.slice(effects),
    };
  };
  const driveGuestChannel = (name: string, args: unknown[]) => {
    const channel = guestChannel(name);
    const sends = state.sends.length;
    const effects = state.guest.effects.length;
    const entries = state.registrations.filter((entry) => entry.channel === channel);
    for (const entry of entries) entry.handler({ sender: null }, ...args);
    return {
      listeners: entries.length,
      sends: guestSends(sends),
      effects: state.guest.effects.slice(effects),
    };
  };
  const flushGuestFrames = () => {
    const pending = state.guest.frames.filter((frame) => !frame.cancelled);
    state.guest.frames.length = 0;
    const sends = state.sends.length;
    for (const frame of pending) frame.callback();
    return { ran: pending.length, sends: guestSends(sends, recordingInputChannel) };
  };
  const cursorElements = () =>
    state.guest.elements.slice(-3).map((element) => ({
      tag: element.tag,
      attrs: jsonSafe(element.attrs),
      style: jsonSafe(element.style),
      textContent: element.textContent,
      svg: element.innerHTML.startsWith("<svg"),
      removed: element.removed,
    }));
  const cursorProjection = () =>
    state.guest.elements.slice(-3).map((element) => ({
      tag: element.tag,
      display: element.style.display ?? "",
      opacity: element.style.opacity ?? "",
      transform: element.style.transform ?? "",
      removed: element.removed,
    }));

  const registrationsBeforeGuest = state.registrations.length;
  const listenersBeforeGuest = state.domListeners.length;
  const sendsBeforeGuest = state.sends.length;
  await import("../src/preview-pick-preload.ts");
  check(
    "preview-pick-preload-registers-its-guest-channels",
    "previewPickPreload",
    {
      channels: state.registrations
        .slice(registrationsBeforeGuest)
        .map((entry) => guestConstant(entry.channel)),
      window: state.domListeners
        .slice(listenersBeforeGuest)
        .map((entry) => `${entry.type} capture ${entry.capture}`),
      declared: [...guestConstantByChannel.values()].sort(byString),
    },
    {
      channels: [
        "RECORDING_CURSOR_CHANNEL",
        "RECORDING_CONTROLLER_CHANNEL",
        "RECORDING_KEY_CHANNEL",
        "RECORDING_POINTER_CHANNEL",
        "START_PICK_CHANNEL",
        "ANNOTATION_THEME_CHANNEL",
        "CANCEL_PICK_CHANNEL",
      ],
      window: [
        "pointerdown capture true",
        "keydown capture true",
        "mousedown capture true",
        "mouseup capture true",
        "auxclick capture true",
      ],
      declared: [
        "ANNOTATION_CAPTURED_CHANNEL",
        "ANNOTATION_THEME_CHANNEL",
        "CANCEL_PICK_CHANNEL",
        "ELEMENT_PICKED_CHANNEL",
        "HUMAN_INPUT_CHANNEL",
        "MOUSE_NAVIGATE_CHANNEL",
        "RECORDING_CONTROLLER_CHANNEL",
        "RECORDING_CURSOR_CHANNEL",
        "RECORDING_INPUT_CHANNEL",
        "RECORDING_KEY_CHANNEL",
        "RECORDING_POINTER_CHANNEL",
        "START_PICK_CHANNEL",
      ],
    },
  );

  const installed = driveGuestChannel("RECORDING_CURSOR_CHANNEL", [
    true,
    { showKeyPresses: true, showMousePresses: true },
    "none",
  ]);
  const installedElements = cursorElements();
  // `recordingCursor ??=` keeps the first installation, so a later activation with different options
  // does not reinstall — but the controller and theme it carries are still applied to the live one.
  const reactivated = driveGuestChannel("RECORDING_CURSOR_CHANNEL", [
    true,
    "not-an-object",
    "agent",
  ]);
  const reactivatedElements = cursorElements();
  const disposed = driveGuestChannel("RECORDING_CURSOR_CHANNEL", [false]);
  const disposedElements = cursorElements();
  check(
    "preview-recording-cursor-channel-installs-reuses-and-disposes-its-cursor",
    "previewPickPreload",
    {
      installed,
      installedElements,
      reactivated,
      reactivatedElements,
      disposed,
      disposedElements,
      timers: state.guest.timers.map((timer) => ({ ms: timer.ms, cleared: timer.cleared })),
      frames: state.guest.frames.length,
    },
    {
      installed: { listeners: 1, sends: [], effects: ["append style,div,div"] },
      installedElements: [
        {
          tag: "style",
          attrs: {},
          style: {},
          textContent:
            "html, html * { cursor: none !important; } @media (prefers-reduced-motion: reduce) { [data-t3code-recording-agent-cursor] { transition: none !important; } }",
          svg: false,
          removed: false,
        },
        {
          tag: "div",
          attrs: { "aria-hidden": "true", "data-t3code-recording-cursor": "" },
          style: {
            cssText:
              "position:fixed;left:0;top:0;width:16px;height:24px;pointer-events:none;z-index:2147483647;display:none;",
          },
          textContent: "",
          svg: true,
          removed: false,
        },
        {
          tag: "div",
          attrs: { "aria-hidden": "true", "data-t3code-recording-agent-cursor": "" },
          style: {
            cssText:
              "position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:2147483647;display:none;filter:drop-shadow(0 1px 2px #0003);transition:transform 150ms ease-out,opacity 150ms ease-out;",
            "--recording-cursor-primary": "#2563eb",
            "--recording-cursor-background": "white",
            opacity: "0.35",
          },
          textContent: "",
          svg: true,
          removed: false,
        },
      ],
      reactivated: { listeners: 1, sends: [], effects: [] },
      reactivatedElements: [
        {
          tag: "style",
          attrs: {},
          style: {},
          textContent:
            "html, html * { cursor: none !important; } @media (prefers-reduced-motion: reduce) { [data-t3code-recording-agent-cursor] { transition: none !important; } }",
          svg: false,
          removed: false,
        },
        {
          tag: "div",
          attrs: { "aria-hidden": "true", "data-t3code-recording-cursor": "" },
          style: {
            cssText:
              "position:fixed;left:0;top:0;width:16px;height:24px;pointer-events:none;z-index:2147483647;display:none;",
            display: "none",
          },
          textContent: "",
          svg: true,
          removed: false,
        },
        {
          tag: "div",
          attrs: { "aria-hidden": "true", "data-t3code-recording-agent-cursor": "" },
          style: {
            cssText:
              "position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:2147483647;display:none;filter:drop-shadow(0 1px 2px #0003);transition:transform 150ms ease-out,opacity 150ms ease-out;",
            "--recording-cursor-primary": "#2563eb",
            "--recording-cursor-background": "white",
            opacity: "0.35",
          },
          textContent: "",
          svg: true,
          removed: false,
        },
      ],
      disposed: {
        listeners: 1,
        sends: [],
        effects: [
          "removeEventListener pointermove",
          "removeEventListener pointerdown",
          "removeEventListener pointerup",
          "removeEventListener pointercancel",
          "removeEventListener keydown",
          "removeEventListener keyup",
          "removeEventListener pointerout",
          "removeEventListener blur",
          "remove div",
          "remove div",
          "remove style",
        ],
      },
      disposedElements: [
        {
          tag: "style",
          attrs: {},
          style: {},
          textContent:
            "html, html * { cursor: none !important; } @media (prefers-reduced-motion: reduce) { [data-t3code-recording-agent-cursor] { transition: none !important; } }",
          svg: false,
          removed: true,
        },
        {
          tag: "div",
          attrs: { "aria-hidden": "true", "data-t3code-recording-cursor": "" },
          style: {
            cssText:
              "position:fixed;left:0;top:0;width:16px;height:24px;pointer-events:none;z-index:2147483647;display:none;",
            display: "none",
          },
          textContent: "",
          svg: true,
          removed: true,
        },
        {
          tag: "div",
          attrs: { "aria-hidden": "true", "data-t3code-recording-agent-cursor": "" },
          style: {
            cssText:
              "position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:2147483647;display:none;filter:drop-shadow(0 1px 2px #0003);transition:transform 150ms ease-out,opacity 150ms ease-out;",
            "--recording-cursor-primary": "#2563eb",
            "--recording-cursor-background": "white",
            opacity: "0.35",
          },
          textContent: "",
          svg: true,
          removed: true,
        },
      ],
      timers: [],
      frames: 0,
    },
  );

  // Reinstall with both options on and the human controller, then drive the real DOM listeners.
  driveGuestChannel("RECORDING_CURSOR_CHANNEL", [
    true,
    { showKeyPresses: true, showMousePresses: true },
    "human",
  ]);
  const recordingPayloads: unknown[] = [];
  const keyRow = (event: Record<string, unknown>, activeElement: unknown, platform: string) => {
    state.guest.activeElement = activeElement;
    state.guest.platform = platform;
    const sendsStart = state.sends.length;
    const driven = driveGuestWindow("keydown", { isTrusted: true, ...event });
    const recording = guestSends(sendsStart, recordingInputChannel);
    for (const send of recording) recordingPayloads.push(...(send.args as unknown[]));
    return {
      listeners: driven.listeners,
      humanInputSends: driven.sends.length - recording.length,
      recording,
    };
  };
  const plainElement = null;
  const passwordElement = {
    tagName: "INPUT",
    getAttribute: (name: string) => (name === "type" ? "password" : null),
  };
  const customElement = { tagName: "MY-EDITOR", getAttribute: () => null };
  const frameElement = { tagName: "IFRAME", getAttribute: () => null };
  const shadowElement = { tagName: "DIV", shadowRoot: { activeElement: passwordElement } };
  const keyRows = {
    macPlainKey: keyRow({ key: "k", code: "KeyK" }, plainElement, "MacIntel"),
    macControlChord: keyRow({ key: "k", code: "KeyK", ctrlKey: true }, plainElement, "MacIntel"),
    macMetaAlone: keyRow({ key: "Meta", code: "MetaLeft" }, plainElement, "MacIntel"),
    macEnter: keyRow({ key: "Enter", code: "Enter" }, plainElement, "MacIntel"),
    deadKey: keyRow({ key: "Dead", code: "Backquote" }, plainElement, "MacIntel"),
    windowsControlChord: keyRow({ key: "k", code: "KeyK", ctrlKey: true }, plainElement, "Win32"),
    windowsMetaChord: keyRow({ key: "k", code: "KeyK", metaKey: true }, plainElement, "Win32"),
    passwordField: keyRow({ key: "s", code: "KeyS" }, passwordElement, "MacIntel"),
    customElementFocus: keyRow({ key: "s", code: "KeyS" }, customElement, "MacIntel"),
    iframeFocus: keyRow({ key: "s", code: "KeyS" }, frameElement, "MacIntel"),
    shadowPasswordFocus: keyRow({ key: "s", code: "KeyS" }, shadowElement, "MacIntel"),
    composing: keyRow({ key: "k", code: "KeyK", isComposing: true }, plainElement, "MacIntel"),
    repeat: keyRow({ key: "k", code: "KeyK", repeat: true }, plainElement, "MacIntel"),
    // The cursor's own keydown listener does not gate on isTrusted, so a synthetic key event is
    // still recorded even though the human-input reporter drops it.
    untrusted: keyRow({ key: "k", code: "KeyK", isTrusted: false }, plainElement, "MacIntel"),
  };
  state.guest.activeElement = plainElement;
  state.guest.platform = "MacIntel";
  // `keyup` reports the last label it computed, or null when focus is sensitive at release time.
  const keyUpRow = (activeElement: unknown) => {
    state.guest.activeElement = activeElement;
    const sendsStart = state.sends.length;
    driveGuestWindow("keyup", {});
    const recording = guestSends(sendsStart, recordingInputChannel);
    for (const send of recording) recordingPayloads.push(...(send.args as unknown[]));
    return recording;
  };
  const keyUpRows = {
    released: keyUpRow(plainElement),
    releasedOverPassword: keyUpRow(passwordElement),
  };
  state.guest.activeElement = plainElement;
  const pointerRows = {
    down: driveGuestWindow("pointerdown", {
      isTrusted: true,
      clientX: 10,
      clientY: 20,
      button: 0,
      pointerType: "mouse",
    }),
    // Two moves before the frame coalesce into one emit carrying the last coordinates.
    firstMove: driveGuestWindow("pointermove", {
      isTrusted: true,
      clientX: 11,
      clientY: 21,
      pointerType: "mouse",
    }),
    secondMove: driveGuestWindow("pointermove", {
      isTrusted: true,
      clientX: 12,
      clientY: 22,
      pointerType: "mouse",
    }),
    flushedMoves: flushGuestFrames(),
    touchMove: driveGuestWindow("pointermove", {
      isTrusted: true,
      clientX: 13,
      clientY: 23,
      pointerType: "touch",
    }),
    up: driveGuestWindow("pointerup", {
      isTrusted: true,
      clientX: 12,
      clientY: 22,
      pointerType: "mouse",
    }),
    moveAfterRelease: driveGuestWindow("pointermove", {
      isTrusted: true,
      clientX: 30,
      clientY: 40,
      pointerType: "mouse",
    }),
    blur: driveGuestWindow("blur", {}),
    pointerOutWithRelatedTarget: driveGuestWindow("pointerout", { relatedTarget: {} }),
    pointerOutToNull: driveGuestWindow("pointerout", { relatedTarget: null }),
  };
  for (const send of [
    ...pointerRows.down.sends,
    ...pointerRows.flushedMoves.sends,
    ...pointerRows.up.sends,
    ...pointerRows.blur.sends,
    ...pointerRows.pointerOutToNull.sends,
  ]) {
    if (send.channel === "RECORDING_INPUT_CHANNEL")
      recordingPayloads.push(...(send.args as unknown[]));
  }
  check(
    "preview-recording-input-payloads-are-what-the-guest-emits",
    "previewPickPreload",
    jsonSafe({ keyRows, keyUpRows, pointerRows }),
    jsonSafe({
      keyRows: {
        macPlainKey: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: "K", held: true, width: 1440 }],
            },
          ],
        },
        macControlChord: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: "⌃K", held: true, width: 1440 }],
            },
          ],
        },
        macMetaAlone: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: "⌘", held: true, width: 1440 }],
            },
          ],
        },
        macEnter: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: "↵", held: true, width: 1440 }],
            },
          ],
        },
        deadKey: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: null, held: true, width: 1440 }],
            },
          ],
        },
        windowsControlChord: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: "Ctrl + K", held: true, width: 1440 }],
            },
          ],
        },
        windowsMetaChord: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: "Win + K", held: true, width: 1440 }],
            },
          ],
        },
        passwordField: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: null, held: true, width: 1440 }],
            },
          ],
        },
        customElementFocus: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: null, held: true, width: 1440 }],
            },
          ],
        },
        iframeFocus: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: null, held: true, width: 1440 }],
            },
          ],
        },
        shadowPasswordFocus: {
          listeners: 2,
          humanInputSends: 1,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: null, held: true, width: 1440 }],
            },
          ],
        },
        composing: { listeners: 2, humanInputSends: 1, recording: [] },
        repeat: { listeners: 2, humanInputSends: 1, recording: [] },
        untrusted: {
          listeners: 2,
          humanInputSends: 0,
          recording: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "key", label: "K", held: true, width: 1440 }],
            },
          ],
        },
      },
      keyUpRows: {
        released: [
          {
            channel: "RECORDING_INPUT_CHANNEL",
            args: [{ type: "key", label: "K", held: false, width: 1440 }],
          },
        ],
        releasedOverPassword: [
          {
            channel: "RECORDING_INPUT_CHANNEL",
            args: [{ type: "key", label: null, held: false, width: 1440 }],
          },
        ],
      },
      pointerRows: {
        down: {
          listeners: 2,
          prevented: 0,
          stopped: 0,
          effects: [],
          sends: [
            {
              channel: "HUMAN_INPUT_CHANNEL",
              args: [{ kind: "pointer", x: 10, y: 20, button: 0 }],
            },
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "pointer", phase: "down", x: 10, y: 20, width: 1440, height: 900 }],
            },
          ],
        },
        firstMove: { listeners: 1, prevented: 0, stopped: 0, effects: [], sends: [] },
        secondMove: { listeners: 1, prevented: 0, stopped: 0, effects: [], sends: [] },
        flushedMoves: {
          ran: 1,
          sends: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "pointer", phase: "move", x: 12, y: 22, width: 1440, height: 900 }],
            },
          ],
        },
        touchMove: { listeners: 1, prevented: 0, stopped: 0, effects: [], sends: [] },
        up: {
          listeners: 1,
          prevented: 0,
          stopped: 0,
          effects: [],
          sends: [
            {
              channel: "RECORDING_INPUT_CHANNEL",
              args: [{ type: "pointer", phase: "up", x: 12, y: 22, width: 1440, height: 900 }],
            },
          ],
        },
        moveAfterRelease: { listeners: 1, prevented: 0, stopped: 0, effects: [], sends: [] },
        blur: {
          listeners: 1,
          prevented: 0,
          stopped: 0,
          effects: [],
          sends: [{ channel: "RECORDING_INPUT_CHANNEL", args: [{ type: "clear" }] }],
        },
        pointerOutWithRelatedTarget: {
          listeners: 1,
          prevented: 0,
          stopped: 0,
          effects: [],
          sends: [],
        },
        pointerOutToNull: {
          listeners: 1,
          prevented: 0,
          stopped: 0,
          effects: [],
          sends: [{ channel: "RECORDING_INPUT_CHANNEL", args: [{ type: "clear" }] }],
        },
      },
    }),
  );
  check(
    "preview-recording-input-payloads-satisfy-the-declared-schema",
    "previewPickPreload",
    {
      payloads: recordingPayloads.length,
      rejectedBySchema: recordingPayloads
        .map((payload, index) => ({
          index,
          schemaAccepts: decodeAccepted(DesktopPreviewRecordingInputSchema, payload),
        }))
        .filter((row) => !row.schemaAccepts),
    },
    { payloads: 19, rejectedBySchema: [] },
  );

  const guardRow = (name: string, args: unknown[]) => {
    const before = cursorProjection();
    const driven = driveGuestChannel(name, args);
    return {
      listeners: driven.listeners,
      sends: driven.sends,
      effects: driven.effects,
      cursorChanged: JSON.stringify(before) !== JSON.stringify(cursorProjection()),
    };
  };
  check(
    "preview-recording-guards-reject-malformed-guest-payloads",
    "previewPickPreload",
    jsonSafe({
      controllerAgentWithPoint: guardRow("RECORDING_CONTROLLER_CHANNEL", ["agent", { x: 1, y: 2 }]),
      controllerHumanWithoutPoint: guardRow("RECORDING_CONTROLLER_CHANNEL", ["human"]),
      controllerUnknownString: guardRow("RECORDING_CONTROLLER_CHANNEL", ["robot"]),
      controllerNonFinitePoint: guardRow("RECORDING_CONTROLLER_CHANNEL", [
        "human",
        { x: Number.NaN, y: 2 },
      ]),
      controllerPointMissingY: guardRow("RECORDING_CONTROLLER_CHANNEL", ["human", { x: 1 }]),
      keyValid: guardRow("RECORDING_KEY_CHANNEL", [{ key: "a", shiftKey: true }]),
      keyMissingKey: guardRow("RECORDING_KEY_CHANNEL", [{ shiftKey: true }]),
      keyNonStringKey: guardRow("RECORDING_KEY_CHANNEL", [{ key: 7 }]),
      keyNonObject: guardRow("RECORDING_KEY_CHANNEL", ["a"]),
      keyNull: guardRow("RECORDING_KEY_CHANNEL", [null]),
      pointerClick: guardRow("RECORDING_POINTER_CHANNEL", [{ x: 3, y: 4, phase: "click" }]),
      pointerUnknownPhase: guardRow("RECORDING_POINTER_CHANNEL", [{ x: 3, y: 4, phase: "drag" }]),
      pointerInfiniteX: guardRow("RECORDING_POINTER_CHANNEL", [
        { x: Number.POSITIVE_INFINITY, y: 4 },
      ]),
      pointerStringCoordinates: guardRow("RECORDING_POINTER_CHANNEL", [{ x: "3", y: "4" }]),
      // Any first argument that is not the literal `true` takes the disposal branch.
      cursorUnknownActivation: guardRow("RECORDING_CURSOR_CHANNEL", ["true"]),
      cursorDeactivation: guardRow("RECORDING_CURSOR_CHANNEL", [false]),
    }),
    jsonSafe({
      controllerAgentWithPoint: { listeners: 1, sends: [], effects: [], cursorChanged: true },
      controllerHumanWithoutPoint: { listeners: 1, sends: [], effects: [], cursorChanged: true },
      controllerUnknownString: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      controllerNonFinitePoint: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      controllerPointMissingY: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      keyValid: {
        listeners: 1,
        sends: [
          {
            channel: "RECORDING_INPUT_CHANNEL",
            args: [{ type: "key", label: "⇧A", held: false, width: 1440 }],
          },
        ],
        effects: [],
        cursorChanged: false,
      },
      keyMissingKey: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      keyNonStringKey: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      keyNonObject: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      keyNull: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      pointerClick: {
        listeners: 1,
        sends: [
          {
            channel: "RECORDING_INPUT_CHANNEL",
            args: [{ type: "pointer", phase: "click", x: 3, y: 4, width: 1440, height: 900 }],
          },
        ],
        effects: [],
        cursorChanged: true,
      },
      // An unknown phase is coerced to "move", which the cursor then drops because no button is held.
      pointerUnknownPhase: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      pointerInfiniteX: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      pointerStringCoordinates: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      cursorUnknownActivation: {
        listeners: 1,
        sends: [],
        effects: [
          "removeEventListener pointermove",
          "removeEventListener pointerdown",
          "removeEventListener pointerup",
          "removeEventListener pointercancel",
          "removeEventListener keydown",
          "removeEventListener keyup",
          "removeEventListener pointerout",
          "removeEventListener blur",
          "remove div",
          "remove div",
          "remove style",
        ],
        cursorChanged: true,
      },
      cursorDeactivation: { listeners: 1, sends: [], effects: [], cursorChanged: false },
    }),
  );

  const themed = driveGuestChannel("ANNOTATION_THEME_CHANNEL", [
    { primary: "#ff0000", background: "#00ff00" },
  ]);
  const themedWithoutCursor = (() => {
    const before = cursorProjection();
    const driven = driveGuestChannel("ANNOTATION_THEME_CHANNEL", [
      { primary: "#123456", background: "#654321" },
    ]);
    return {
      listeners: driven.listeners,
      sends: driven.sends,
      effects: driven.effects,
      cursorChanged: JSON.stringify(before) !== JSON.stringify(cursorProjection()),
    };
  })();
  check(
    "preview-annotation-theme-and-cancel-pick-reach-the-guest",
    "previewPickPreload",
    jsonSafe({
      // No cursor is installed here: the theme is stored and only reaches CSS variables through the
      // cursor installed by the next activation.
      themed,
      themedWithoutCursor,
      cancelWithoutSession: driveGuestChannel("CANCEL_PICK_CHANNEL", []),
      reactivateAppliesStoredTheme: driveGuestChannel("RECORDING_CURSOR_CHANNEL", [
        true,
        { showKeyPresses: false, showMousePresses: false },
        "none",
      ]),
      reactivatedAgentCursorStyle: state.guest.elements.slice(-1)[0]?.style,
      defaultOptionsEmitNothing: (() => {
        const sendsStart = state.sends.length;
        driveGuestWindow("keydown", { isTrusted: true, key: "k", code: "KeyK" });
        driveGuestWindow("pointerdown", {
          isTrusted: true,
          clientX: 1,
          clientY: 2,
          button: 0,
          pointerType: "mouse",
        });
        driveGuestWindow("blur", {});
        return guestSends(sendsStart);
      })(),
    }),
    jsonSafe({
      themed: { listeners: 1, sends: [], effects: [] },
      themedWithoutCursor: { listeners: 1, sends: [], effects: [], cursorChanged: false },
      cancelWithoutSession: { listeners: 1, sends: [], effects: [] },
      reactivateAppliesStoredTheme: { listeners: 1, sends: [], effects: ["append style,div,div"] },
      reactivatedAgentCursorStyle: {
        cssText:
          "position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:2147483647;display:none;filter:drop-shadow(0 1px 2px #0003);transition:transform 150ms ease-out,opacity 150ms ease-out;",
        "--recording-cursor-primary": "#123456",
        "--recording-cursor-background": "#654321",
        opacity: "0.35",
      },
      defaultOptionsEmitNothing: [
        { channel: "HUMAN_INPUT_CHANNEL", args: [{ kind: "key", key: "k", code: "KeyK" }] },
        { channel: "HUMAN_INPUT_CHANNEL", args: [{ kind: "pointer", x: 1, y: 2, button: 0 }] },
      ],
    }),
  );

  // With the cursor disposed only the pick preload's own window listeners remain, so the trusted-event
  // gate and the thumb-button navigation are visible on their own.
  driveGuestChannel("RECORDING_CURSOR_CHANNEL", [false]);
  state.guest.effects.length = 0;
  const trustedRow = (type: string, event: Record<string, unknown>) => {
    const driven = driveGuestWindow(type, event);
    return {
      listeners: driven.listeners,
      prevented: driven.prevented,
      stopped: driven.stopped,
      sends: driven.sends,
    };
  };
  check(
    "preview-guest-human-input-and-navigation-sends-require-trusted-events",
    "previewPickPreload",
    jsonSafe({
      untrustedPointer: trustedRow("pointerdown", {
        isTrusted: false,
        clientX: 5,
        clientY: 6,
        button: 0,
      }),
      trustedPointer: trustedRow("pointerdown", {
        isTrusted: true,
        clientX: 5,
        clientY: 6,
        button: 1,
      }),
      untrustedKey: trustedRow("keydown", { isTrusted: false, key: "a", code: "KeyA" }),
      trustedKey: trustedRow("keydown", { isTrusted: true, key: "a", code: "KeyA" }),
      leftMouseDown: trustedRow("mousedown", { isTrusted: true, button: 0 }),
      backButtonDown: trustedRow("mousedown", { isTrusted: true, button: 3 }),
      forwardButtonUp: trustedRow("mouseup", { isTrusted: true, button: 4 }),
      backButtonUp: trustedRow("mouseup", { isTrusted: true, button: 3 }),
      middleButtonUp: trustedRow("mouseup", { isTrusted: true, button: 1 }),
      untrustedThumbUp: trustedRow("mouseup", { isTrusted: false, button: 4 }),
      auxclickThumb: trustedRow("auxclick", { isTrusted: true, button: 4 }),
    }),
    jsonSafe({
      untrustedPointer: { listeners: 1, prevented: 0, stopped: 0, sends: [] },
      trustedPointer: {
        listeners: 1,
        prevented: 0,
        stopped: 0,
        sends: [
          { channel: "HUMAN_INPUT_CHANNEL", args: [{ kind: "pointer", x: 5, y: 6, button: 1 }] },
        ],
      },
      untrustedKey: { listeners: 1, prevented: 0, stopped: 0, sends: [] },
      trustedKey: {
        listeners: 1,
        prevented: 0,
        stopped: 0,
        sends: [
          { channel: "HUMAN_INPUT_CHANNEL", args: [{ kind: "key", key: "a", code: "KeyA" }] },
        ],
      },
      leftMouseDown: { listeners: 1, prevented: 0, stopped: 0, sends: [] },
      backButtonDown: { listeners: 1, prevented: 1, stopped: 1, sends: [] },
      forwardButtonUp: {
        listeners: 1,
        prevented: 1,
        stopped: 1,
        sends: [{ channel: "MOUSE_NAVIGATE_CHANNEL", args: [{ direction: "forward" }] }],
      },
      backButtonUp: {
        listeners: 1,
        prevented: 1,
        stopped: 1,
        sends: [{ channel: "MOUSE_NAVIGATE_CHANNEL", args: [{ direction: "back" }] }],
      },
      middleButtonUp: { listeners: 1, prevented: 0, stopped: 0, sends: [] },
      untrustedThumbUp: { listeners: 1, prevented: 0, stopped: 0, sends: [] },
      auxclickThumb: { listeners: 1, prevented: 1, stopped: 1, sends: [] },
    }),
  );
  state.sends.length = sendsBeforeGuest;

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
      "Executed the real preload listeners captured from apps/desktop/src/preload.ts, apps/desktop/src/preview-pip-preload.ts and apps/desktop/src/preview-pick-preload.ts, plus the macOS permission panel preload DOM bridge, inside a Node child process with an in-memory electron stub. Deliveries are what a renderer callback received, sends are what a panel or guest posted to the main process, requests are the channel plus argument envelope each bridge method hands to ipcRenderer.invoke or sendSync, requestPayloadCodecs is the payload contract the shipped main-process factories declare for all 99 request channels, the framing checks drive synthetic methods through the shipped DesktopIpc registration so main-side decode, handler input, result encode and listener replacement are executed rather than only described, the badge checks run the one real main-process installer whose codec cannot be reached any other way, the permission checks run the shipped MacPermissionHelper end to end so the panel preload's own sends are delivered into its live ipcMain listener, and the guest checks run the shipped preview pick preload and its real recording cursor against a stubbed DOM so the separate `preview:*` guest protocol is pinned from the emitting side and compared against the schema the host validates it with. No BrowserWindow, real ipcRenderer transport, real DOM, main-process sender, handler service, osascript Settings watcher or Rust implementation is exercised. These snapshots characterize the shipped guards, wrappers, declared contracts, request framing, the permission panel's main-process handler and the recording guest's own emits, not an approved contract.",
    fixturePolicy:
      "Payloads are synthetic literals. The stub records channel registrations and re-emits through the captured wrapper, so each check exercises the shipped typeof/object guard and any payload reconstruction. A missing payload entry in an emit array still calls the wrapper, which is how argument-count rejections are observed. Request methods are driven with `length` positional `s0/s1/...` strings, and sendSync/invoke return values are scripted per channel to observe the wrapper's own result conversion. The declared payload and result codecs are captured by inserting two `codecs.push` statements into src/ipc/DesktopIpc.ts at load time; the corpus fails if either anchor is missing. Framing fixtures register service-free codecs of the author's choosing (a `{tabId: string}` struct, booleans, a string, `Schema.Void`) through `DesktopIpc.make(ipcMainStub)` and call the listener the shipped registration installed; each listener promise is settled in the tick it is created so a rejected request is recorded instead of killing the child. The badge fixtures install `installNotificationBadge` for real over that same in-memory `ipcMain`, with the platform pinned through `HostProcessPlatform`, an `ElectronApp` stub whose only implemented member is `on`, and the electron stub's window/badge members recording their calls as strings; their logger output is captured because the shipped error path only logs, and the logger's timestamp and fiber id are stripped from what is pinned. The permission fixtures construct the real `MacPermissionHelper` against electron stubs whose members record their calls as strings: `app.getPath('exe')` returns a packaged bundle, `nativeImage` returns a non-empty resizable icon, `shell.showItemInFolder` and `webContents.startDrag` record, and `systemPreferences` answers the shipped probe. `./MacSettingsWindow.ts` is replaced only for `watchMacSettingsWindow`, which would spawn a long-lived `osascript` here; the stub re-exports the shipped `settingsHelperBounds`, so the panel geometry constants are still computed by production code. Each action row re-opens the panel first, because closing it removes the listener the next row needs. The guest fixtures install the shipped recording cursor against a stubbed `document`/`window` whose `setTimeout` and `requestAnimationFrame` are captured instead of scheduled, so the 700ms agent-cursor reset and the pointer coalescing frame only run when the corpus flushes them; `document.activeElement` and `navigator.platform` are set per row because the shipped key labeller and its sensitive-focus check read both. Window listeners are driven with the union of the fields the shipped handlers read, `stopImmediatePropagation` is counted rather than honored, and a `keydown` row driven while the cursor is installed reports the recording send separately from the human-input send the same event also produces.",
    declaredSchemaComparison:
      "Where a runtime Schema exists (snap-shot event, update state, activation request, recording input), the same payload is checked with Schema.is. Divergences are recorded as-is: the port must reproduce the guard behavior unless the project decides to tighten it. Note that decoding ignores unknown properties, so a payload carrying an extra field can satisfy both the guard and the Schema while the Schema's Type does not include that field. On the request side every channel now has a declared payload codec, so the shipped envelope is compared with that contract structurally: required and optional keys of the shipped `Objects` AST against the keys the wrapper actually builds. Framing then shows what that structural claim is worth at runtime: an unknown key is silently dropped by the decode, a wrong-typed key rejects the whole request before the handler runs, and the handler result is encoded back through the declared result codec, so a value outside that codec rejects the reply too.",
    knownLimitations: [
      "The preload modules are evaluated outside a renderer, so document/window/webFrame/Clerk bridge behavior is stubbed; the only listeners driven are the macOS permission panel's own element and key listeners and the preview pick guest's window listeners.",
      "Serialization boundaries of Electron IPC (structured clone, unsupported types, sender identity) are not modeled; the stub calls the wrapper with plain JavaScript values, and `__undefined__` marks an `undefined` value that JSON could not carry.",
      "Framing is exercised with synthetic service-free codecs, not with the 98 captured per-channel codecs: those codecs are still read rather than run through their real handler, and the registered business handler and its services never execute.",
      "Object envelopes are audited by key set, not by value. Driving each bridge method with `s0` placeholder strings means field types cannot be decoded against the codec without inventing the renderer's real arguments, so a wrong-typed field value would not be caught by this corpus.",
      "desktop:set-notification-badge is the one request channel whose real installer and handler run here, because its payload codec is built inside the installer. The other 98 channels contribute their declared codecs only; their handlers, the services those handlers need and the main-process producers that call them are not executed.",
      "The macOS permission helper runs here, but against stubbed Electron and a stubbed Settings watcher: no real drag image, no real System Tracking window, no `osascript`, and the sender/frame gate is judged by object identity the corpus builds rather than by Electron's own webContents identity. The onboarding callers that decide which permission to show, and the Full Disk Access probe that the shipped `permissionGranted` leaves as a constant false, are not covered.",
      "No main-process producer is executed, so a payload the real main process can never send is still characterized by the guard.",
      "Interfaces without a runtime Schema (ssh prompt, preview frame, pointer event, tab state) cannot be compared against a declared contract here.",
      "The preview pick preload runs here against a stubbed document/window: no layout, no real events, `setTimeout` and `requestAnimationFrame` are captured rather than scheduled, and `stopImmediatePropagation` is counted rather than honored. Its `preview:start-pick` handler and the annotation overlay it builds are never driven, so the cursor guards and the human-input reporters are the only guest paths executed. No host-side producer runs either, so `preview/Manager`'s `isRecordingInput` gate and its forwarding to `desktop:preview-recording-input` are characterized by the schema comparison alone, and `react-grab`'s React-context lookup is not reached.",
    ],
    coveredEventChannels,
    coveredRequestChannels,
    requestMethods: sortedRows,
    requestPayloadCodecs,
    results,
  };
}

if (process.argv.includes(EMIT_FLAG)) {
  const report = await buildReport();
  // stdout is a pipe here and the report is larger than its buffer: a `writeSync` would fail with
  // EAGAIN once the pipe is full, while writing without waiting for the drain lets `process.exit`
  // truncate the JSON. The callback only fires after the whole payload has been flushed.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(report), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  process.exit(0);
}

export async function runMigrationPreloadIpc() {
  const entry = NodeURL.fileURLToPath(import.meta.url);
  const child = NodeChildProcess.spawnSync(process.execPath, [entry, EMIT_FLAG], {
    encoding: "utf8",
    cwd: desktopRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(
      `Preload IPC corpus failed (exit ${String(child.status)}): ${child.stderr.slice(-4000)}`,
    );
  }
  return JSON.parse(child.stdout) as Awaited<ReturnType<typeof buildReport>>;
}
