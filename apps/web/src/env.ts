/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes. This is a function (not a constant) to handle cases where the module
 * loads before the bridge is fully initialized.
 */
export const isElectron = () => typeof window !== "undefined" && window.desktopBridge !== undefined;
