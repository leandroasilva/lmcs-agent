"use client";

import type { PreviewViewportSetting, ScopedThreadRef } from "@lmcstools/core";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";

interface DualPreviewViewProps {
  readonly threadRef: ScopedThreadRef;
  readonly mainTabId: string;
  readonly companionTabId: string;
  readonly desktopViewport: PreviewViewportSetting;
  readonly mobileViewport: PreviewViewportSetting;
  readonly visible: boolean;
}

/**
 * Side-by-side responsive preview: renders the same page at two different
 * viewport sizes (desktop + mobile) with device-frame chrome around each.
 *
 * Each side owns a BrowserSurfaceSlot that acquires its own Electron webview
 * from the surface store. The server keeps both tabs' navigation in sync.
 */
export function DualPreviewView({ mainTabId, companionTabId, visible }: DualPreviewViewProps) {
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center gap-6 overflow-auto bg-muted/30 p-6">
      <DesktopDeviceFrame>
        <BrowserSurfaceSlot tabId={mainTabId} visible={visible} className="h-full w-full" />
      </DesktopDeviceFrame>
      <MobileDeviceFrame>
        <BrowserSurfaceSlot tabId={companionTabId} visible={visible} className="h-full w-full" />
      </MobileDeviceFrame>
    </div>
  );
}

/** Browser-chrome frame for the desktop viewport. */
function DesktopDeviceFrame({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-background shadow-lg">
      {/* Browser chrome bar */}
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/50 px-3 py-1.5">
        {/* macOS traffic-light colors via inline style (not on the theme scale) */}
        <span className="size-2.5 rounded-full" style={{ backgroundColor: "#ff5f57" }} />
        <span className="size-2.5 rounded-full" style={{ backgroundColor: "#febc2e" }} />
        <span className="size-2.5 rounded-full" style={{ backgroundColor: "#28c840" }} />
        <div className="ml-2 flex-1 rounded-sm bg-background/80 px-2 py-0.5 text-center text-3xs text-muted-foreground">
          Desktop
        </div>
      </div>
      {/* Viewport area — the slot fills this */}
      <div className="relative overflow-hidden" style={{ width: 520, height: 340 }}>
        {children}
      </div>
    </div>
  );
}

/** Phone-style frame for the mobile viewport. */
function MobileDeviceFrame({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center">
      <div
        className="overflow-hidden rounded-4xl shadow-xl"
        style={{
          borderWidth: 3,
          borderColor: "#1a1a1a",
          backgroundColor: "#111111",
        }}
      >
        {/* Notch */}
        <div className="flex justify-center pt-1.5">
          <div className="h-3.5 w-16 rounded-full" style={{ backgroundColor: "#1a1a1a" }} />
        </div>
        {/* Viewport area */}
        <div className="relative overflow-hidden bg-background" style={{ width: 220, height: 420 }}>
          {children}
        </div>
        {/* Home indicator */}
        <div className="flex justify-center pb-1.5">
          <div className="h-1 w-10 rounded-full" style={{ backgroundColor: "#525252" }} />
        </div>
      </div>
      <span className="mt-2 text-3xs font-medium text-muted-foreground">Mobile</span>
    </div>
  );
}
