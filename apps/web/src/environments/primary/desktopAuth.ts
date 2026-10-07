let desktopBearerTokenPromise: Promise<string | null> | null = null;

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }

  // In desktop dev mode the Vite define injects the dev auth token directly
  // into the renderer. Use it synchronously as the bearer token so the
  // WebSocket connection can authenticate immediately without waiting for
  // the desktop bridge IPC (which may take a long time to resolve or fail
  // when the backend pool is not yet ready).
  const devToken = (import.meta.env.VITE_DEV_AUTH_TOKEN as string | undefined)?.trim();
  if (devToken && devToken.length > 0) {
    return Promise.resolve(devToken);
  }

  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  desktopBearerTokenPromise ??= bridge
    .getLocalEnvironmentBearerToken()
    .then((token) => {
      if (typeof token === "string" && token.length > 0) {
        return token;
      }
      return null;
    })
    .catch(() => {
      desktopBearerTokenPromise = null;
      return null;
    });
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
