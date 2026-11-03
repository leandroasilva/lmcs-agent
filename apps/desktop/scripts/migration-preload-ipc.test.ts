import { assert, it } from "@effect/vitest";
import { runMigrationPreloadIpc } from "./migration-preload-ipc.ts";

const actualOf = (
  report: Awaited<ReturnType<typeof runMigrationPreloadIpc>>,
  id: string,
): unknown => {
  const result = report.results.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`Missing preload IPC check: ${id}`);
  return result.actual;
};

it("characterizes the shipped preload event guards without Electron", async () => {
  const report = await runMigrationPreloadIpc();
  assert.lengthOf(report.results, 94);
  assert.equal(new Set(report.results.map((result) => result.id)).size, 94);
  assert.deepEqual(
    report.results.filter((result) => !result.passed),
    [],
  );
  assert.include(report.interpretation, "not an approved contract");
  assert.include(report.interpretation, "in-memory electron stub");
  assert.include(report.declaredSchemaComparison, "Schema.is");
  assert.isAbove(report.knownLimitations.length, 0);
});

it("pins the channel identity each subscription listens on", async () => {
  const report = await runMigrationPreloadIpc();
  assert.deepEqual(actualOf(report, "event-channel-identity"), {
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
  assert.deepEqual(actualOf(report, "both-bridges-are-exposed"), [
    "desktopBridge",
    "previewPictureInPicture",
  ]);
});

it("pins guard rejections, payload reconstruction and disposal", async () => {
  const report = await runMigrationPreloadIpc();
  assert.deepEqual(actualOf(report, "menu-action-drops-numbers"), { deliveries: 0, args: [] });
  assert.deepEqual(actualOf(report, "menu-action-drops-objects"), { deliveries: 0, args: [] });
  assert.deepEqual(actualOf(report, "snap-shot-drops-unknown-type"), { deliveries: 0, args: [] });
  assert.deepEqual(actualOf(report, "quit-shortcut-reconstructs-up-hint"), {
    deliveries: 1,
    args: [[{ state: "up" }]],
  });
  assert.deepEqual(actualOf(report, "quit-shortcut-drops-down-without-mode"), {
    deliveries: 0,
    args: [],
  });
  assert.deepEqual(actualOf(report, "trackpad-scroll-end-invokes-zero-argument-listener"), {
    deliveries: 1,
    args: [[]],
  });
  assert.deepEqual(actualOf(report, "window-fullscreen-drops-strings"), {
    deliveries: 0,
    args: [],
  });
  assert.deepEqual(actualOf(report, "preview-state-change-uses-two-positional-arguments"), {
    deliveries: 1,
    args: [["tab-1", { isLoading: true }]],
  });
  assert.deepEqual(actualOf(report, "preview-state-change-drops-single-argument"), {
    deliveries: 0,
    args: [],
  });
  assert.equal(actualOf(report, "unsubscribe-stops-delivery"), 0);
  assert.equal(actualOf(report, "double-subscription-delivers-twice"), 2);
});

it("pins the recorded divergence between guards and declared contracts", async () => {
  const report = await runMigrationPreloadIpc();
  assert.deepEqual(actualOf(report, "snap-shot-accepts-ready-without-id-while-schema-rejects"), {
    guardAccepts: true,
    schemaAccepts: false,
  });
  assert.deepEqual(actualOf(report, "snap-shot-accepts-non-hex-id-while-schema-rejects"), {
    guardAccepts: true,
    schemaAccepts: false,
  });
  assert.deepEqual(actualOf(report, "snap-shot-keeps-id-on-shortcut-changed-and-schema-drops-it"), {
    guardAccepts: true,
    schemaAccepts: true,
  });
  assert.deepEqual(actualOf(report, "update-state-accepts-empty-object-while-schema-rejects"), {
    guardAccepts: true,
    schemaAccepts: false,
  });
  assert.deepEqual(
    actualOf(report, "activation-request-accepts-empty-object-while-schema-rejects"),
    {
      guardAccepts: true,
      schemaAccepts: false,
    },
  );
  assert.deepEqual(actualOf(report, "recording-input-accepts-empty-object-while-schema-rejects"), {
    guardAccepts: true,
    schemaAccepts: false,
  });
});

it("drives every shipped renderer->main request method", async () => {
  const report = await runMigrationPreloadIpc();
  const rows = report.requestMethods;
  assert.lengthOf(rows, 99);
  assert.deepEqual(
    rows
      .filter((row) => row.kind === "sendSync")
      .map((row) => row.path)
      .sort(),
    [
      "getAppBranding",
      "getLocalEnvironmentBootstraps",
      "getLocalEnvironmentEnabled",
      "getSystemLocale",
      "getWindowFullscreenState",
    ],
  );
  assert.deepEqual(actualOf(report, "every-declared-channel-is-exercised-by-the-shipped-preload"), {
    declaredCount: 113,
    requestChannelCount: 99,
    eventChannelCount: 15,
    unexercised: [],
    usedByBothRoles: ["desktop:set-notification-badge"],
    macChannelConstant: "MAC_PERMISSION_HELPER_CHANNEL",
  });
  assert.equal((actualOf(report, "non-request-bridge-members") as unknown[]).length, 15);
  assert.lengthOf(
    rows.filter((row) => row.kind === "invoke" && row.args.length === 0),
    17,
  );
  assert.deepEqual(actualOf(report, "single-argument-calls-separate-omitted-from-undefined-keys"), {
    ensureSshEnvironment: { target: "s0" },
    showContextMenu: { items: "s0" },
    "preview.createTab without defaults": {
      tabId: "s0",
      zoomFactor: "__undefined__",
      colorScheme: "__undefined__",
    },
  });
  assert.deepEqual(actualOf(report, "preview-create-tab-drops-unknown-default-fields"), {
    tabId: "s0",
    zoomFactor: 1.5,
    colorScheme: "dark",
  });
  assert.deepEqual(actualOf(report, "get-local-environment-enabled-uses-loose-not-false"), {
    false: false,
    true: true,
    null: true,
    undefined: true,
    string: true,
    object: true,
  });
  assert.deepEqual(actualOf(report, "get-window-fullscreen-state-requires-strict-true"), {
    true: true,
    false: false,
    string: false,
    number: false,
    null: false,
  });
  assert.deepEqual(actualOf(report, "get-app-branding-nullifies-non-object-results"), {
    object: { name: "LMCS" },
    array: [1, 2],
    string: null,
    number: null,
    null: null,
    undefined: null,
  });
  assert.deepEqual(
    actualOf(report, "ensure-ssh-environment-converts-cancellation-into-a-rejection"),
    {
      cancelledWithMessage: { thrown: "no credentials", value: null },
      cancelledWithoutMessage: { thrown: "SSH authentication cancelled.", value: null },
      cancelledWithNonStringMessage: { thrown: "SSH authentication cancelled.", value: null },
      passthrough: { thrown: null, value: { status: "connected" } },
      nullResult: { thrown: null, value: null },
    },
  );
  assert.include(report.interpretation, "ipcRenderer.invoke or sendSync");
});

it("audits the shipped request envelopes against the declared main-process codecs", async () => {
  const report = await runMigrationPreloadIpc();
  assert.lengthOf(report.requestPayloadCodecs, 99);
  assert.deepEqual(actualOf(report, "main-process-codecs-are-declared-for-every-request-channel"), {
    capturedCodecs: 99,
    distinctCodecChannels: 99,
    duplicateCodecChannels: [],
    requestChannelsWithoutCodec: [],
    codecChannelsNeverRequested: [],
    requestChannelCount: 99,
  });
  assert.deepEqual(actualOf(report, "declared-request-payload-codec-shapes"), {
    shapeCounts: {
      object: 50,
      void: 17,
      primitive: 13,
      union: 11,
      sync: 5,
      undefinedPayload: 3,
    },
    shapesTotal: 99,
    unclassifiedAstTags: [],
  });
  assert.deepEqual(
    actualOf(report, "payload-free-request-envelopes-decode-under-the-declared-codec"),
    { auditedCount: 20, rejectedPaths: [] },
  );
  assert.deepEqual(actualOf(report, "request-envelope-keys-match-the-declared-payload-codec"), {
    rebuiltEnvelopes: 43,
    mismatches: [],
  });
  assert.deepEqual(actualOf(report, "request-envelopes-by-declared-codec-shape"), {
    buckets: {
      "rebuilt object": 43,
      "forwardedUntouched string": 7,
      "primitiveCodec string": 13,
      "unionCodec string": 11,
      "voidCodec undefined": 17,
      "undefinedPayloadCodec undefined": 3,
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
  });
  assert.deepEqual(actualOf(report, "every-request-channel-carries-a-single-payload-argument"), []);
  const descriptorOf = (channel: string) =>
    report.requestPayloadCodecs.find((entry) => entry.channel === channel);
  assert.deepEqual(descriptorOf("desktop:preview-create-tab"), {
    channel: "desktop:preview-create-tab",
    constant: "PREVIEW_CREATE_TAB_CHANNEL",
    kind: "invoke",
    astTag: "Objects",
    shape: "object",
    requiredKeys: ["tabId"],
    optionalKeys: ["colorScheme", "zoomFactor"],
    acceptsNoPayload: false,
  });
  assert.deepEqual(descriptorOf("desktop:context-menu"), {
    channel: "desktop:context-menu",
    constant: "CONTEXT_MENU_CHANNEL",
    kind: "invoke",
    astTag: "Objects",
    shape: "object",
    requiredKeys: ["items"],
    optionalKeys: ["position"],
    acceptsNoPayload: false,
  });
  assert.deepEqual(descriptorOf("desktop:paste-as-text"), {
    channel: "desktop:paste-as-text",
    constant: "PASTE_AS_TEXT_CHANNEL",
    kind: "invoke",
    astTag: "Undefined",
    shape: "undefinedPayload",
    requiredKeys: [],
    optionalKeys: [],
    acceptsNoPayload: true,
  });
  assert.deepEqual(descriptorOf("desktop:get-app-branding"), {
    channel: "desktop:get-app-branding",
    constant: "GET_APP_BRANDING_CHANNEL",
    kind: "sync",
    astTag: "noPayload",
    shape: "sync",
    requiredKeys: [],
    optionalKeys: [],
    acceptsNoPayload: true,
  });
  assert.deepEqual(descriptorOf("desktop:set-notification-badge"), {
    channel: "desktop:set-notification-badge",
    constant: "SET_NOTIFICATION_BADGE_CHANNEL",
    kind: "invoke",
    astTag: "Objects",
    shape: "object",
    requiredKeys: ["count", "image"],
    optionalKeys: [],
    acceptsNoPayload: false,
  });
  assert.include(report.interpretation, "requestPayloadCodecs");
  assert.include(
    report.knownLimitations.join(" "),
    "Object envelopes are audited by key set, not by value",
  );
});

it("executes the shipped main-process request framing", async () => {
  const report = await runMigrationPreloadIpc();
  const decode = actualOf(report, "main-listener-decodes-the-payload-before-the-handler-runs");
  const outcomes = structuredClone(decode) as { outcome: string; message?: string }[];
  assert.deepEqual(
    outcomes.map((entry) => entry.outcome),
    ["resolved", "resolved", "rejected", "rejected", "rejected", "rejected"],
  );
  assert.deepEqual(
    outcomes.map((entry) => entry.message),
    [undefined, undefined, "Expected string", "Missing key", "Expected object", "Expected object"],
  );
  assert.deepEqual(actualOf(report, "main-listener-hands-the-handler-a-decoded-not-a-raw-object"), [
    { tabId: "t" },
    { tabId: "t" },
  ]);
  assert.deepEqual(
    actualOf(report, "main-listener-encodes-the-handler-result-through-the-declared-codec"),
    {
      invalidResult: [{ raw: true, outcome: "rejected", message: "Expected boolean" }],
      voidResult: [{ raw: true, outcome: "resolved", value: "__undefined__" }],
    },
  );
  assert.deepEqual(
    actualOf(report, "sync-listener-writes-the-encoded-result-to-the-return-value"),
    {
      ok: [{ outcome: "returned", returnValue: "ok", thrown: null }],
      invalid: [
        { outcome: "threw", returnValue: "untouched", thrown: "Expected string" },
        { outcome: "threw", returnValue: "untouched", thrown: "Expected string" },
      ],
    },
  );
  assert.deepEqual(
    actualOf(report, "registration-replaces-the-listener-and-releases-it-when-the-scope-closes"),
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
  assert.include(report.interpretation, "DesktopIpc registration");
  assert.include(
    report.knownLimitations.join(" "),
    "Framing is exercised with synthetic service-free codecs",
  );
});

it("runs the real notification badge installer and handler", async () => {
  const report = await runMigrationPreloadIpc();
  assert.deepEqual(actualOf(report, "notification-badge-installer-registers-on-the-shipped-path"), {
    installCalls: [
      "removeHandler desktop:set-notification-badge",
      "handle desktop:set-notification-badge",
    ],
    appEvents: ["browser-window-focus", "before-quit"],
    loggedLines: ["Could not update notification badge Error: synthetic badge failure"],
  });
  const rows = actualOf(report, "notification-badge-payload-validation-and-badge-effects") as {
    outcome: string;
    message?: string;
    effects: string[];
  }[];
  assert.deepEqual(
    rows.map((row) => row.outcome),
    [
      "resolved",
      "resolved",
      "resolved",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.effects),
    [
      ["setBadgeCount 3"],
      ["setBadgeCount 0"],
      ["setBadgeCount 3"],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ],
  );
  assert.deepEqual(
    rows.slice(3).map((row) => row.message),
    [
      "Expected a string matching the RegExp ^data:image\\/png;base64,[a-z0-9+/]+={0,2}$",
      "Expected string | null",
      "Expected a value between 0 and 2147483647",
      "Expected an integer",
      "Expected a value between 0 and 2147483647",
      "Missing key",
      "Missing key",
      "Expected object",
      "Expected object",
    ],
  );
  assert.deepEqual(actualOf(report, "notification-badge-platform-branches"), {
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
  });
  assert.deepEqual(actualOf(report, "notification-badge-clears-when-a-window-is-focused"), {
    focused: {
      raw: { count: 5, image: null },
      outcome: "resolved",
      value: "__undefined__",
      effects: ["setBadgeCount 0", "send desktop:set-notification-badge []"],
    },
    failing: {
      raw: { count: 5, image: null },
      outcome: "resolved",
      value: "__undefined__",
      effects: [],
    },
  });
  assert.deepEqual(
    actualOf(report, "notification-badge-focus-listener-and-scope-close-clear-the-badge"),
    {
      focusEffects: [
        ["setBadgeCount 0", "send desktop:set-notification-badge []"],
        ["setBadgeCount 0", "send desktop:set-notification-badge []"],
      ],
      finalizerEffects: ["setBadgeCount 0", "send desktop:set-notification-badge []"],
    },
  );
});

it("drives the macOS permission panel bridge and maps every observed channel back to its constant", async () => {
  const report = await runMigrationPreloadIpc();
  assert.deepEqual(actualOf(report, "mac-permission-preload-registers-its-dom-bridge"), [
    "#app:click",
    "#app:dragstart",
    "#close:click",
    "document:keydown",
  ]);
  assert.deepEqual(actualOf(report, "mac-permission-panel-only-looks-up-its-own-elements"), [
    "app",
    "close",
  ]);
  assert.deepEqual(actualOf(report, "mac-permission-dragstart-sends-drag-and-prevents-default"), {
    listeners: 1,
    preventDefault: 1,
    sends: [{ channel: "desktop:mac-permission-helper", args: ["drag"] }],
  });
  assert.deepEqual(actualOf(report, "mac-permission-app-click-sends-finder"), {
    listeners: 1,
    preventDefault: 0,
    sends: [{ channel: "desktop:mac-permission-helper", args: ["finder"] }],
  });
  assert.deepEqual(actualOf(report, "mac-permission-escape-sends-close"), {
    listeners: 1,
    preventDefault: 0,
    sends: [{ channel: "desktop:mac-permission-helper", args: ["close"] }],
  });
  assert.deepEqual(actualOf(report, "mac-permission-other-key-sends-nothing"), {
    listeners: 1,
    preventDefault: 0,
    sends: [],
  });
  assert.deepEqual(actualOf(report, "mac-permission-sends-carry-only-declared-action-strings"), [
    "close",
    "close",
    "drag",
    "finder",
  ]);
  assert.deepEqual(
    report.coveredEventChannels.map((entry) => entry.constant),
    [
      "DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL",
      "MAC_PERMISSION_HELPER_CHANNEL",
      "MENU_ACTION_CHANNEL",
      "PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL",
      "PREVIEW_POINTER_EVENT_CHANNEL",
      "PREVIEW_RECORDING_FRAME_CHANNEL",
      "PREVIEW_RECORDING_INPUT_CHANNEL",
      "PREVIEW_STATE_CHANGE_CHANNEL",
      "QUIT_SHORTCUT_CHANNEL",
      "SET_NOTIFICATION_BADGE_CHANNEL",
      "SNAP_SHOT_EVENT_CHANNEL",
      "SSH_PASSWORD_PROMPT_CHANNEL",
      "TRACKPAD_SCROLL_END_CHANNEL",
      "UPDATE_STATE_CHANNEL",
      "WINDOW_FULLSCREEN_STATE_CHANNEL",
    ],
  );
});
