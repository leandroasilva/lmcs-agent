import * as NodeModule from "node:module";

const STUB_MARK = "virtual:lmcs-probe-electron";

const electronStub = `
const noop = () => {};
export const contextBridge = { exposeInMainWorld: noop, exposeInIsolatedWorld: noop };
export const ipcRenderer = { on: noop, removeListener: noop, send: noop, sendSync: noop, invoke: async () => null };
export const ipcMain = { on: noop, handle: noop, removeHandler: noop, removeAllListeners: noop, send: noop };
export const webFrame = { getZoomFactor: () => 1, setZoomFactor: noop };
export const webUtils = { getPathForFile: () => "" };
export const app = { on: noop, once: noop, getPath: () => "/tmp", setPath: noop, getAppPath: () => "/tmp", isReady: () => true, whenReady: async () => {}, quit: noop };
export const dialog = { showOpenDialog: async () => ({}) };
export const shell = { openExternal: async () => {}, showItemInFolder: noop, trashItem: async () => {} };
export const Menu = { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop };
export const BrowserWindow = class {};
export const screen = { on: noop, getPrimaryDisplay: () => ({}) };
export const nativeTheme = { on: noop, shouldStartInDarkMode: async () => false, themeSource: "system" };
export const session = { defaultSession: { on: noop, clearStorageData: async () => {}, getCookieString: async () => "" } };
export const powerMonitor = { on: noop };
export const Tray = class {};
export const nativeImage = { createFromPath: () => ({}) };
export const protocol = { handle: noop, registerFileProtocol: noop };
export const clipboard = { readText: () => "", writeText: noop, write: noop };
export const ClipboardItem = class {};
export const webContents = { fromId: () => undefined, getAllWebContents: () => [] };
export const WebContentsView = class {};
export const View = class {};
export const net = { request: () => ({}) };
export const powerSaveBlocker = { start: () => 0, stop: noop, isStarted: () => false };
export const desktopCapturer = { getSources: async () => [] };
export const globalShortcut = { register: () => true, unregisterAll: noop };
export const systemPreferences = { getMediaAccessStatus: () => "unknown", askForMediaAccess: async () => false };
`;

const clerkStub = `export const exposeClerkBridge = () => {};`;

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

const modules = [
  "../src/ipc/methods/window.ts",
  "../src/ipc/methods/wsl.ts",
  "../src/ipc/methods/snapShot.ts",
  "../src/ipc/methods/preview.ts",
  "../src/ipc/methods/sshEnvironment.ts",
  "../src/ipc/methods/updates.ts",
  "../src/ipc/methods/clientSettings.ts",
  "../src/ipc/methods/connectionCatalog.ts",
  "../src/ipc/methods/deviceToken.ts",
  "../src/ipc/methods/localEnvironment.ts",
  "../src/ipc/methods/serverExposure.ts",
  "../src/ipc/methods/appActivation.ts",
  "../src/ipc/methods/notificationBadge.ts",
];

for (const specifier of modules) {
  try {
    const loaded = await import(specifier);
    console.log(`OK ${specifier} exports=${Object.keys(loaded).length}`);
  } catch (error) {
    console.log(`FAIL ${specifier}: ${(error as Error).message.split("\n")[0]}`);
  }
}
