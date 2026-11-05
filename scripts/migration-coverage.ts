import type { buildMigrationInventory } from "./migration-inventory.ts";

export const migrationCoverage = {
  interpretation:
    "Required coverage, not a claim that these clients or connections were exercised.",
  clients: ["web-local", "web-hosted", "electron", "ios", "android"],
  futureClients: ["tauri"],
  platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"],
  connectionModes: ["local", "lan", "ssh", "tailscale", "connect-cloudflared", "wsl"],
  versionPairs: ["current-current", "old-client-new-server", "new-client-old-server", "downgrade"],
  transitions: [
    "offline-reconnect-cursor-replay",
    "multi-device",
    "multi-environment",
    "archive-unarchive",
    "approval-reply-cancel",
    "turn-completion-checkpoint-completion",
    "update-failure-rollback",
  ],
  providers: ["codex", "claudeAgent", "cursor", "grok", "opencode", "qoder", "commandCode"],
  providerEvidence: "apps/server/src/provider/builtInDrivers.ts",
  providerScenarios: [
    "start-turn-stream-complete",
    "instance-isolation",
    "resume-after-restart",
    "approval-and-structured-input",
    "interrupt-and-process-exit",
    "mcp-routing",
    "rollback-or-explicit-unsupported",
  ],
  focusedSuites: [
    {
      boundary: "authorization",
      paths: ["apps/server/src/auth/RpcAuthorization.test.ts"],
      milestone:
        "Every registered RPC has an explicit scope; dynamic device operations require operate.",
    },
    {
      boundary: "orchestration",
      paths: [
        "apps/server/src/orchestration/decider.userMessageAppend.test.ts",
        "apps/server/src/orchestration/projector.test.ts",
        "apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts",
      ],
      milestone:
        "Dispatch receipt, atomic event/projection/receipt commit, ordered replay and reopen.",
    },
    {
      boundary: "project-lifecycle",
      paths: [
        "packages/client/src/operations/commands.test.ts",
        "packages/client/src/state/shellReducer.test.ts",
        "apps/server/src/orchestration/decider.delete.test.ts",
      ],
      milestone:
        "Project creation/deletion use orchestration commands, while shell snapshots/events carry project lists. Preserve explicit force intent, deletion invariants and removal from the client read model.",
    },
    {
      boundary: "legacy-migrations",
      paths: [
        "apps/server/src/persistence/Migrations/026_CanonicalizeModelSelectionOptions.test.ts",
      ],
      milestone: "Legacy option objects become canonical arrays without losing persisted intent.",
    },
    {
      boundary: "async-drain-and-terminal",
      paths: [
        "packages/core/src/shared/DrainableWorker.test.ts",
        "apps/server/src/terminal/OutputProtocol.test.ts",
      ],
      milestone:
        "Drain includes active work; output resumes only on acknowledgements after the window fills.",
    },
  ],
  notExercisedBySyntheticBaseline: [
    "Full server startup with all reactors, providers and HTTP/WebSocket listeners.",
    "Electron/OS startup, preview Chromium, passkeys, signing and packaged updater.",
    "Real network, PTY throughput, remote tunnels, WSL and multi-device reconnection.",
    "iOS/Android UI and platform-specific native integrations.",
    "Provider-specific raw transcripts and credentialed upstream behavior for every driver.",
    "Historical databases from every released schema version and data distribution.",
  ],
} as const;

export const migrationOwnership = [
  {
    id: "orchestration",
    currentWriter: "environment-node",
    resources: ["orchestration-events", "orchestration-projections", "durable-command-receipts"],
    mutationBoundary:
      "One serialized dispatch transaction owns all three resources; publish after commit.",
    evidence: "apps/server/src/orchestration/Layers/OrchestrationEngine.ts",
    cutoverUnit: "engine-and-persistence",
  },
  {
    id: "environment-auth",
    currentWriter: "environment-node",
    resources: [
      "auth-sessions",
      "pairing-grants",
      "environment-signing-secrets",
      "dpop-replay-state",
    ],
    mutationBoundary:
      "Atomic grant consumption, scoped sessions and persistent signing identities.",
    evidence: "apps/server/src/auth/SessionStore.ts",
    cutoverUnit: "environment-auth",
  },
  {
    id: "workspace",
    currentWriter: "environment-node",
    resources: ["workspace-files", "attachments", "workspace-search-index"],
    mutationBoundary:
      "Only the owning environment writes files; read scopes do not imply side-effect freedom.",
    evidence: "apps/server/src/workspace/WorkspaceFileSystem.ts",
    cutoverUnit: "workspace-services",
  },
  {
    id: "vcs",
    currentWriter: "environment-node",
    resources: ["git-worktrees", "checkpoint-hidden-refs", "forge-mutations"],
    mutationBoundary:
      "Git/forge CLIs remain external; coordinate restore with provider conversation rollback.",
    evidence: "apps/server/src/vcs/GitVcsDriver.ts",
    cutoverUnit: "vcs-and-checkpoint-reactors",
  },
  {
    id: "providers",
    currentWriter: "environment-node",
    resources: ["provider-children", "provider-resume-cursors", "provider-approval-callbacks"],
    mutationBoundary:
      "One process owner per instance/thread; no duplicate turn or approval execution.",
    evidence: "apps/server/src/provider/Services/ProviderAdapter.ts",
    cutoverUnit: "provider-instance",
  },
  {
    id: "terminals",
    currentWriter: "environment-node",
    resources: ["pty-children", "terminal-history", "terminal-output-sequences"],
    mutationBoundary:
      "Drain retained output before lifecycle transitions; preserve acknowledgement windows.",
    evidence: "apps/server/src/terminal/Manager.ts",
    cutoverUnit: "terminal-manager",
  },
  {
    id: "connect",
    currentWriter: "environment-node",
    resources: ["managed-cloudflared-child", "managed-endpoint-registration", "cloud-login-state"],
    mutationBoundary:
      "Generation-aware reconciliation owns only its connector processes; CLI login owns its loopback listener and cloud-token state.",
    evidence: "apps/server/src/cloud/ManagedEndpointRuntime.ts",
    cutoverUnit: "managed-endpoint-runtime",
  },
  {
    id: "desktop",
    currentWriter: "electron-main",
    resources: [
      "desktop-settings",
      "desktop-backend-pool",
      "desktop-ssh-tunnels",
      "desktop-update-lifecycle",
      "desktop-window-state",
      "desktop-activation-requests",
      "desktop-ssh-prompts",
    ],
    mutationBoundary:
      "Shell owns local/WSL children; never stop an independently owned remote server.",
    evidence: "apps/desktop/src/backend/DesktopBackendPool.ts",
    cutoverUnit: "desktop-shell",
  },
  {
    id: "preview",
    currentWriter: "electron-main",
    resources: ["preview-profiles", "preview-cookies", "preview-webcontents", "preview-recordings"],
    mutationBoundary: "Browser session ownership is independent of the environment RPC server.",
    evidence: "apps/desktop/src/preview/Manager.ts",
    cutoverUnit: "preview-companion",
  },
  {
    id: "devices",
    currentWriter: "environment-node",
    resources: ["device-registry", "device-hub-proxy-connections"],
    mutationBoundary:
      "Registry owns in-memory registrations; proxy request scopes own upstream connections, not hub processes.",
    evidence: "apps/server/src/DeviceRegistry.ts",
    cutoverUnit: "device-services",
  },
  {
    id: "environment-http",
    currentWriter: "environment-node",
    resources: ["environment-rpc-connections", "static-response-streams", "browser-trace-delivery"],
    mutationBoundary:
      "Request scopes own transport streams and client connection lifecycle; backend data remains with its service owner.",
    evidence: "apps/server/src/http.ts",
    cutoverUnit: "environment-transport",
  },
  {
    id: "relay",
    currentWriter: "relay-service",
    resources: ["relay-links", "relay-delivery-queues", "relay-device-registrations"],
    mutationBoundary:
      "External broker is not the environment session authority and is not migrated here.",
    evidence: "infra/relay/src/worker.ts",
    cutoverUnit: "unchanged",
  },
] as const;

export function validateOwnership(
  entries: ReadonlyArray<{ id: string; currentWriter: string; resources: readonly string[] }>,
) {
  const owners = new Map<string, string>();
  const issues: string[] = [];
  for (const entry of entries) {
    for (const resource of entry.resources) {
      const previous = owners.get(resource);
      if (previous !== undefined)
        issues.push(`${resource} is claimed by ${previous} and ${entry.id}`);
      else owners.set(resource, entry.id);
    }
  }
  return issues;
}

type MigrationInventory = Awaited<ReturnType<typeof buildMigrationInventory>>;
export type ContractClassification = {
  code: "raw-http-schema-not-declared" | "ipc-schema-not-declared";
  subject: string;
  owner: (typeof migrationOwnership)[number]["id"];
  resources: readonly string[];
  representation:
    | "schema-decoded"
    | "schema-declared-not-decoded"
    | "partially-decoded"
    | "typescript-only"
    | "no-payload"
    | "binary"
    | "http-proxy"
    | "websocket-upgrade"
    | "manual-validation";
  contract: string;
  direction: "main-to-renderer" | "renderer-to-main" | "http-request-response";
  authorization: string;
  effects: string;
  evidence: ReadonlyArray<{ file: string; fingerprint: string }>;
  tests: readonly string[];
  parityRequirement: string;
};

// Pinned review evidence must be renewed deliberately, never regenerated during a baseline run.
const reviewedSources = {
  channels: [
    "apps/desktop/src/ipc/channels.ts",
    "8bce223a5153ccc408b660442ae81a67e52e29d7cf24c7673720219c29c231f7",
  ],
  ipc: [
    "packages/core/src/contracts/ipc.ts",
    "8695f6d6b781035f1eba038f28bc4daffe9898ddb4e36bbf4e0d260fd56fd562",
  ],
  base: [
    "packages/core/src/contracts/baseSchemas.ts",
    "fb12e72f4a44458a587de2c9aac9fa5f4ce04e4f510a523119b4f2a29f70849c",
  ],
  settings: [
    "packages/core/src/contracts/settings.ts",
    "a99a81045b272fbd00a2a5d626f7b55cfee6404c413877d286a172cd7050d3aa",
  ],
  activationContract: [
    "packages/core/src/contracts/desktopAppActivation.ts",
    "6f0635e8645681d1470ce16dd91f395f75447309ce537630b90a5a5339ead202",
  ],
  preload: [
    "apps/desktop/src/preload.ts",
    "3011535ae18b483934451eca0473a1d6486110a1ff9030cc8a520c3725aa068a",
  ],
  window: [
    "apps/desktop/src/window/DesktopWindow.ts",
    "103d648ffb9a3b699f86a60cc5e37b832ed601501b2d6e3faa882741f17d9de6",
  ],
  quit: [
    "apps/desktop/src/window/QuitHold.ts",
    "f8129c904364031e0cea9ff6bcc11e379176c60411d12d5c491c7e59ed39bd1b",
  ],
  activation: [
    "apps/desktop/src/app/DesktopAppActivation.ts",
    "8e1d773924e659ed550c9cfae5456d8617fc5f7e7c5d55c49c88a325ac7d50ca",
  ],
  broker: [
    "apps/desktop/src/app/DesktopAppActivationBroker.ts",
    "9de2c0daffdc00d5709f0837b830e931d8c18ad714b4cfb50beb9f72f11ee32e",
  ],
  updates: [
    "apps/desktop/src/updates/DesktopUpdates.ts",
    "a022339d9378c3e329a5fd7b6796dfebf8f310c72124040acb06af0b0269ae6d",
  ],
  ssh: [
    "apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts",
    "5400d9380535cecb47c8e90aeefc4b14b3f18f241d24469fcc6db93ec54baa72",
  ],
  preview: [
    "apps/desktop/src/preview/Manager.ts",
    "265c64705d2a1a84b6cff8fe991a641f6afbf214a1d768fd4ae40b3b4888863f",
  ],
  forwarding: [
    "apps/desktop/src/ipc/methods/preview.ts",
    "8717ff34579047c4d7831eb990638d69d5d97d0d3efbc413f8ad88f252aa8b87",
  ],
  pip: [
    "apps/desktop/src/preview-pip-preload.ts",
    "f3e0f5760f46c5c763a5bf23a0f4900de404d18378ab325036db78807e426ccf",
  ],
  macPreload: [
    "apps/desktop/src/mac-permission-preload.ts",
    "178abe92e652ca798863fecc147fbc847a35e28540d5a84e1c00e8002f5c456c",
  ],
  macHelper: [
    "apps/desktop/src/permissions/MacPermissionHelper.ts",
    "91b92feb4b9dcd8f08549eb64e820aa649813d80a556cbc91d36f5b494194c01",
  ],
  electronWindow: [
    "apps/desktop/src/electron/ElectronWindow.ts",
    "ff5e7b8f0021944926d4859410d7f7760350851727b10669a5615db8231bb184",
  ],
  ipcHandlers: [
    "apps/desktop/src/ipc/DesktopIpcHandlers.ts",
    "fef39433d5783f7f4d02d04484973258e83a8012744e8a4d5ffa4b84feb0f324",
  ],
  guest: [
    "apps/desktop/src/preview/GuestProtocol.ts",
    "46fad383bbbd7e8700cc43d881600baf7c09cbf84580448001ff678b07e9b2a8",
  ],
  pickPreload: [
    "apps/desktop/src/preview/PickPreload.ts",
    "ccfdc468882b6207936cb664befce36aeb22ad2aa1ce0e1f1868d2ed992e9053",
  ],
  recordingCursor: [
    "apps/desktop/src/preview/RecordingCursor.ts",
    "67b2c90b12956f3fe732b38ad2c5937fd7354991a4fb061bffb30f41a75c1ca9",
  ],
  cli: [
    "apps/server/src/cloud/CliTokenManager.ts",
    "3845cd6d70c7e0d5027fb60209450ae590fae93e76c1f9cf72ef1e07dc02583e",
  ],
  cliHtml: [
    "apps/server/src/cloud/cliAuthHtml.ts",
    "46e77fb0fe23518049136b3445dde68365d54e0f21df50ad8c6b44a32d4a2d04",
  ],
  cloudConfig: [
    "apps/server/src/cloud/publicConfig.ts",
    "18b3fa94db472cf459e8eaa4edf6f6ed2afffc8f28f04e1fed2988157e472118",
  ],
  secrets: [
    "apps/server/src/auth/ServerSecretStore.ts",
    "b0ef3021526aa045344a739dc341798d588878ba93a2db001253a40ee65dca4e",
  ],
  connectAuth: [
    "packages/core/src/shared/connectAuth.ts",
    "87bb4f76558cfb5047912fee124aaf4ab10dbf5130e8045c1778422b0b616860",
  ],
  deviceProxy: [
    "apps/server/src/device/DeviceHubProxy.ts",
    "45ec012450b37826cd872631e19bbb514304716eefd8306b3333bc147f0b9a66",
  ],
  deviceService: [
    "apps/server/src/device/DeviceService.ts",
    "3627baf1bb5742d1fc3f9d9bb3a10c873cef4e705da18e2145d6698b3cb1ceaf",
  ],
  deviceHttp: [
    "apps/server/src/device/http.ts",
    "3226f9c0456b4d1f9252dbe00eab2ac45e60629176cafe56f02682d37cd37ed8",
  ],
  deviceRegistry: [
    "apps/server/src/DeviceRegistry.ts",
    "b9d74cd185b53171c9557430ac7a8e35282c37aaa19686de6630d61d4f172d6c",
  ],
  http: [
    "apps/server/src/http.ts",
    "94051091703a58438a9af84b0403ffe0ca362bb79c0317f0a4f2327089e0d56f",
  ],
  ws: ["apps/server/src/ws.ts", "317b813089cbcbc83dab5c823ff577208f4fce2aaf4664e0b9d9151f3c59e0ed"],
  server: [
    "apps/server/src/server.ts",
    "32dedcc2d49cd5b178065b13e07a16cc25fa9428bdec9316efdbf3c863e110a9",
  ],
  assets: [
    "apps/server/src/assets/AssetAccess.ts",
    "1d79034bf66525f6567d65caffed70db901669208a2490794b2c4f20c7728391",
  ],
  media: [
    "apps/server/src/assets/MediaFile.ts",
    "3588f08a8878dd6f6eb4db6f7745fa1ebcfe4bcce5af83ea1c11474d78281bfe",
  ],
  github: [
    "apps/server/src/assets/GitHubMediaFetch.ts",
    "2306f48bb78c963ae59fb418f3bb6baceb322cc0ddca671a7029f135bf2c7293",
  ],
  uploads: [
    "apps/server/src/assets/AttachmentUpload.ts",
    "80014c4753facf89acf8d17fe5d8c07490300413b00772d54f9c2315c0057c87",
  ],
  observability: [
    "packages/core/src/shared/observability.ts",
    "604c1a2973f2df186668d325f12119167cc720bb87c4920f533db96efabebd35",
  ],
  traceCollector: [
    "apps/server/src/observability/BrowserTraceCollector.ts",
    "2d2b32937633f541e27a01a7a59d7c3dcef7a1615e6dc4a39b58c8c0ef19286e",
  ],
  auth: [
    "apps/server/src/auth/EnvironmentAuth.ts",
    "a69a9e36b08793458fb49b82492fb4952313edb66a85e351bde0ecd4323537ae",
  ],
  authHttp: [
    "apps/server/src/auth/http.ts",
    "3e8c2834415890652331755b421b4a711156f91ad8479687160c1f4ca261d86c",
  ],
  rpcAuth: [
    "apps/server/src/auth/RpcAuthorization.ts",
    "1394aad1176f0d33765fa13acbe404c78983c810be7a8c77218326d776c90916",
  ],
  session: [
    "apps/server/src/auth/SessionStore.ts",
    "5b5e65ddd0d91d51826325b898d6d739ced5a881a633713349e44cf738408cd0",
  ],
  environmentHttp: [
    "packages/core/src/contracts/environmentHttp.ts",
    "e40dc5a62d9eb4cc23951df88dec0480d83f308b709c3c09ff6555cdd26f298f",
  ],
  rpc: [
    "packages/core/src/contracts/rpc.ts",
    "20a1e6649daf3e2626cc9dea04d3586e04cc8d0e9ee309d435992ef585570540",
  ],
} as const;
const evidence = (...keys: (keyof typeof reviewedSources)[]) =>
  keys.map((key) => {
    const [file, fingerprint] = reviewedSources[key];
    return { file, fingerprint };
  });

export const migrationContractClassifications: readonly ContractClassification[] = [
  {
    code: "ipc-schema-not-declared",
    subject: "MENU_ACTION_CHANNEL",
    owner: "desktop",
    resources: ["desktop-window-state"],
    representation: "manual-validation",
    direction: "main-to-renderer",
    authorization: "Main-process dispatch through preload; no server RPC scope.",
    contract:
      "DesktopBridge.onMenuAction receives a string; preload accepts any string, not an action enum.",
    effects:
      "dispatchMenuAction can reveal/create a window and defer event delivery until loading finishes.",
    evidence: evidence("channels", "ipc", "preload", "window"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/window/DesktopWindow.test.ts",
    ],
    parityRequirement:
      "The corpus pins the desktop:menu-action channel, string-only acceptance, non-string rejection and disposal; parity still needs main-side dispatch with queued-window delivery and the downstream menu actions in a renderer.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "SNAP_SHOT_EVENT_CHANNEL",
    owner: "desktop",
    resources: ["desktop-window-state"],
    representation: "schema-declared-not-decoded",
    direction: "main-to-renderer",
    authorization: "Main-process lifecycle notification through preload.",
    contract:
      "DesktopSnapShotEvent Schema exists, but preload isSnapShotEvent accepts optional string IDs more broadly than that Schema.",
    effects:
      "Dispatches capture lifecycle notifications and reveals the window for started events.",
    evidence: evidence("channels", "ipc", "base", "preload", "window"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/window/DesktopWindow.test.ts",
    ],
    parityRequirement:
      "The corpus pins guard acceptance per discriminant, absent/invalid IDs, extra-field passthrough, cleanup and the divergences from the declared Schema; parity still needs the main-side focus and window-reveal behavior. Do not silently tighten the port to the declared Schema.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "QUIT_SHORTCUT_CHANNEL",
    owner: "desktop",
    resources: ["desktop-window-state"],
    representation: "manual-validation",
    direction: "main-to-renderer",
    authorization: "Main-process keyboard hint, not a renderer command to quit.",
    contract:
      "QuitShortcutHintEvent is an erased up/down union; preload checks state and hold/double-click mode, then reconstructs the payload.",
    effects: "Relays quit-hint transitions; QuitHold owns the actual timing and quit action.",
    evidence: evidence("channels", "ipc", "preload", "window", "quit"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/window/QuitHold.test.ts",
    ],
    parityRequirement:
      "The corpus pins channel identity, guard rejections and payload reconstruction; parity still needs the main-process emit path wired to QuitHold timing, which callback tests alone do not verify.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "TRACKPAD_SCROLL_END_CHANNEL",
    owner: "desktop",
    resources: ["desktop-window-state"],
    representation: "no-payload",
    direction: "main-to-renderer",
    authorization: "Native main-process gesture notification.",
    contract:
      "gestureScrollEnd sends no arguments; preload invokes a zero-argument listener. No declared Schema.Void.",
    effects: "Notifies renderer listeners when native trackpad scrolling ends.",
    evidence: evidence("channels", "preload", "window"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/window/DesktopWindow.test.ts",
    ],
    parityRequirement:
      "The corpus pins the zero-argument arity, payload-ignoring wrapper and cleanup; parity still needs the native gesture source, end/update distinction and the consuming device view.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "WINDOW_FULLSCREEN_STATE_CHANNEL",
    owner: "desktop",
    resources: ["desktop-window-state"],
    representation: "manual-validation",
    direction: "main-to-renderer",
    authorization: "Main-process window notification.",
    contract:
      "Boolean guarded with typeof in preload; initial state is obtained on a separate synchronous channel.",
    effects:
      "macOS enter/leave hooks publish true/false; leaving also resynchronizes native window buttons.",
    evidence: evidence("channels", "ipc", "preload", "window"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/window/DesktopWindow.test.ts",
    ],
    parityRequirement:
      "The corpus pins boolean-only acceptance and invalid payload rejection; parity still needs enter/leave ordering, platform-specific button resynchronization and this channel's own synchronous handler (its channel, strict-true transform and declared sync result codec are pinned, as is the shipped sendSync framing: the encoded result lands on `event.returnValue` and a failed encode throws instead of replying).",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL",
    owner: "desktop",
    resources: ["desktop-activation-requests"],
    representation: "schema-declared-not-decoded",
    direction: "main-to-renderer",
    authorization:
      "Local socket ingress validates DesktopAppActivationRequest; outgoing IPC preload only checks for an object.",
    contract:
      "Version-1 open-workspace request with requestId, workspaceRoot and platform; Schema exists but is not applied at the event boundary.",
    effects:
      "Activation broker queues requests until renderer readiness; completion uses a separate invoke method.",
    evidence: evidence("channels", "activationContract", "base", "preload", "activation", "broker"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/app/DesktopAppActivationBroker.test.ts",
      "apps/desktop/src/app/DesktopAppActivation.test.ts",
    ],
    parityRequirement:
      "The corpus pins the outgoing channel and the preload's object-only acceptance versus the declared Schema, plus the ready/complete request channels with their envelopes and declared codecs; parity still needs real IPC forwarding with duplicate/readiness ordering and completion.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "UPDATE_STATE_CHANNEL",
    owner: "desktop",
    resources: ["desktop-update-lifecycle"],
    representation: "schema-declared-not-decoded",
    direction: "main-to-renderer",
    authorization: "Main-process broadcast to live BrowserWindows.",
    contract:
      "DesktopUpdateStateSchema is declared; emitState sends the interface value and preload object-checks/casts without decoding.",
    effects:
      "Publishes update progress/state; this notification does not download or install an update.",
    evidence: evidence("channels", "ipc", "settings", "preload", "updates", "electronWindow"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/updates/DesktopUpdates.test.ts",
    ],
    parityRequirement:
      "The corpus pins channel identity, full-state forwarding, empty-object acceptance and teardown; parity still needs every state the real updater emits and broadcast ordering across live windows.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "SSH_PASSWORD_PROMPT_CHANNEL",
    owner: "desktop",
    resources: ["desktop-ssh-prompts"],
    representation: "typescript-only",
    direction: "main-to-renderer",
    authorization: "Main-process prompt to the main window; response uses a separate method.",
    contract:
      "DesktopSshPasswordPromptRequest interface: requestId, destination, nullable username, prompt, expiresAt; object-check/cast only. No password in this outgoing event.",
    effects:
      "Registers a pending prompt, focuses/restores the window and awaits resolution with timeout/cleanup.",
    evidence: evidence("channels", "ipc", "preload", "ssh"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts",
    ],
    parityRequirement:
      "The corpus pins the channel and that any object, including an empty one, is forwarded unchecked; parity still needs every prompt field, cancellation/expiry and request isolation without storing real credentials in fixtures.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL",
    owner: "preview",
    resources: ["preview-webcontents"],
    representation: "typescript-only",
    direction: "main-to-renderer",
    authorization: "Main process targets the dedicated PiP window.",
    contract:
      "DesktopPreviewRecordingFrame interface holds tabId, base64 JPEG data, width, height and receivedAt; PiP preload only object-checks/casts.",
    effects:
      "Captures JPEG frames, checks dimensions, suppresses duplicates and adjusts PiP aspect/size before delivery.",
    evidence: evidence("channels", "ipc", "preview", "pip"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/preview/Manager.test.ts",
    ],
    parityRequirement:
      "The corpus pins the dedicated PiP channel and its object-only guard; parity still needs frame bytes/dimensions, duplicate suppression and window closure on the real PiP surface.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "PREVIEW_RECORDING_FRAME_CHANNEL",
    owner: "preview",
    resources: ["preview-recordings"],
    representation: "typescript-only",
    direction: "main-to-renderer",
    authorization: "Main-process broadcast via scoped preview forwarding.",
    contract:
      "DesktopPreviewRecordingFrame interface; outgoing preload only object-checks/casts. Retained CDP frame path is not proof of active recording transport.",
    effects:
      "Acknowledges received CDP frames and forwards to registered consumers; current startRecording uses native display-media capture, not Page.startScreencast.",
    evidence: evidence(
      "channels",
      "ipc",
      "preload",
      "preview",
      "forwarding",
      "electronWindow",
      "ipcHandlers",
    ),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/preview/Manager.test.ts",
    ],
    parityRequirement:
      "The corpus pins the recording-frame channel identity and its object-only guard; parity still needs retained-path compatibility versus native recording, plus acknowledgement and cleanup evidence.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "PREVIEW_STATE_CHANGE_CHANNEL",
    owner: "preview",
    resources: ["preview-webcontents"],
    representation: "typescript-only",
    direction: "main-to-renderer",
    authorization: "Main-process broadcast via scoped preview forwarding.",
    contract:
      "Two positional arguments (tabId, state), not a single object; DesktopPreviewTabState interface, with only string/object guards in preload.",
    effects:
      "Broadcasts manager state changes; downstream renderer and server-reporting effects are outside this boundary review.",
    evidence: evidence(
      "channels",
      "ipc",
      "preload",
      "preview",
      "forwarding",
      "electronWindow",
      "ipcHandlers",
    ),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/preview/Manager.test.ts",
    ],
    parityRequirement:
      "The corpus pins two-positional-argument delivery, malformed-argument rejection and disposal; parity still needs tab/state identity from the real broadcaster and downstream navigation reporting. Internal manager callbacks are not IPC parity.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "PREVIEW_POINTER_EVENT_CHANNEL",
    owner: "preview",
    resources: ["preview-webcontents"],
    representation: "typescript-only",
    direction: "main-to-renderer",
    authorization: "Main-process broadcast; recording guest mirroring uses a different channel.",
    contract:
      "DesktopPreviewPointerEvent interface: tabId, move/click phase, x/y, sequence, createdAt; preload object-check/cast only.",
    effects:
      "Publishes pointer feedback before dispatching automation mouse input and mirrors separately to a recording guest.",
    evidence: evidence(
      "channels",
      "ipc",
      "preload",
      "preview",
      "forwarding",
      "electronWindow",
      "ipcHandlers",
    ),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/preview/Manager.test.ts",
    ],
    parityRequirement:
      "The corpus pins the outgoing desktop channel and its object-only guard; parity still needs ordering, sequence and coordinates independently of guest-channel and internal-callback tests.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "MAC_PERMISSION_HELPER_CHANNEL",
    owner: "desktop",
    resources: ["desktop-window-state"],
    representation: "manual-validation",
    direction: "renderer-to-main",
    authorization: "Checks sender WebContents and mainFrame identity plus exact action values.",
    contract:
      "Raw drag/finder/close string actions; erased union in helper preload, explicit comparisons in onMessage, no Schema.",
    effects:
      "Starts native bundle drag, reveals in Finder or closes/refocuses windows; it does not grant permissions.",
    evidence: evidence("channels", "macPreload", "macHelper"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/permissions/MacPermissionHelper.test.ts",
    ],
    parityRequirement:
      "The corpus runs the shipped MacPermissionHelper: the sender/mainFrame identity gate, the three declared actions, 13 malformed values, the drag fallback, the Full Disk Access no-probe path, the shipped settings-window geometry and listener removal after close are all executed against an in-memory Electron stub; parity still needs the real macOS transport (webContents identity, native drag image, the System Tracking window and its osascript watcher) and the onboarding callers that choose which permission to show.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "PREVIEW_RECORDING_INPUT_CHANNEL",
    owner: "preview",
    resources: ["preview-recordings"],
    representation: "partially-decoded",
    direction: "main-to-renderer",
    authorization:
      "Upstream guest input is schema-checked and gated by current tab/recording/options; outgoing preload only object-checks the envelope.",
    contract:
      "Erased {tabId,input} envelope; nested DesktopPreviewRecordingInputSchema validates pointer/key/clear input upstream, not the complete outgoing event.",
    effects:
      "Forwards accepted recording input through manager subscriptions for recording decoration.",
    evidence: evidence(
      "channels",
      "ipc",
      "preload",
      "preview",
      "guest",
      "forwarding",
      "electronWindow",
      "ipcHandlers",
    ),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/preview/Manager.test.ts",
    ],
    parityRequirement:
      "The corpus pins the exact desktop channel, that the preload envelope is object-checked only and that the shipped main-side framing decodes before the handler and encodes before replying. It also runs the guest emitter that produces the nested input — the preview pick preload and its real recording cursor against a stubbed DOM — and decodes all 19 payloads that guest emits with the same DesktopPreviewRecordingInputSchema the host's isRecordingInput gate uses, so the upstream validation is executed rather than only described. Parity still needs the complete {tabId,input} envelope through this channel's real handler, the Manager's tab/capture gates and its unsubscribe behavior, and the real guest webContents transport.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "PREVIEW_GUEST_TO_HOST_CHANNELS",
    owner: "preview",
    resources: ["preview-webcontents", "preview-recordings"],
    representation: "partially-decoded",
    direction: "renderer-to-main",
    authorization:
      "The guest webContents sends through ipcRenderer and the main process listens on webContents.ipc inside the owning tab's listener scope; there is no server RPC scope and no sender-identity check beyond that closure.",
    contract:
      "Four preview:* channels the guest emits — element-picked, human-input, mouse-navigate and recording-input — declared in GuestProtocol.ts, so none of them is one of the 113 desktop channels and none reaches a DesktopIpc factory or codec. This is one namespace-level subject rather than one per channel because the four share a single declaration file, a single guest producer and a single main-process consumer, unlike the desktop channels, which each own a factory. Only recording-input has a runtime Schema: Manager gates it with Schema.is(DesktopPreviewRecordingInputSchema). The other three are hand-guarded per positional argument: isPreviewInputSignal for human-input, an exact 'back'/'forward' string comparison for mouse-navigate, and isPreviewAnnotationPayload plus normalizeCaptureRect and an args[2] === 'send' coercion for element-picked's three positional arguments.",
    effects:
      "recording-input feeds the recording-input subscribers behind the tab and capture-consumer gates; element-picked captures an annotation screenshot and settles the pick, resolving null when the payload is rejected; mouse-navigate drives webContents.navigationHistory back/forward. human-input has the widest effect and the weakest guard: a payload that fails isPreviewInputSignal still falls through to bumping the tab's control epoch and setting controller 'human', so any value on that channel takes control away from the agent.",
    evidence: evidence("guest", "pickPreload", "preview", "ipc", "channels"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/preview/Manager.test.ts",
    ],
    parityRequirement:
      "The corpus runs the shipped guest emitter: the preview pick preload and its real recording cursor against a stubbed DOM, with all 19 preview:recording-input payloads it produces decoded against the same Schema the host gate uses, and the human-input and mouse-navigate sends pinned including the trusted-event requirement and the thumb-button preventDefault. Parity still needs the host half executed — isPreviewInputSignal, consumeExpectedAgentInput, the control-epoch takeover that a malformed human-input payload still triggers, isPreviewAnnotationPayload, normalizeCaptureRect, the send/attach coercion and the navigation-history guards — over a real guest webContents transport, plus a decision on whether that unguarded takeover is intended behavior or a defect.",
  },
  {
    code: "ipc-schema-not-declared",
    subject: "PREVIEW_HOST_TO_GUEST_CHANNELS",
    owner: "preview",
    resources: ["preview-webcontents", "preview-recordings"],
    representation: "manual-validation",
    direction: "main-to-renderer",
    authorization:
      "The main process sends to the target preview webContents; the guest receives through ipcRenderer with no scope and no origin check, so anything the main process emits is trusted by construction.",
    contract:
      "Eight preview:* channels the main process emits into the guest — start-pick, cancel-pick, annotation-captured, annotation-theme, recording-cursor, recording-controller, recording-pointer and recording-key — declared in GuestProtocol.ts and absent from the 113-channel desktop list, so no DesktopIpc factory or codec covers any of them. This is one namespace-level subject for the same reason as the guest-to-host group. Nothing validates what arrives on this leg: annotation-captured carries no payload at all, and the annotation theme was decoded on the earlier renderer-to-main leg by DesktopPreviewAnnotationThemeInputSchema but is forwarded to the guest without re-validation, so DesktopPreviewAnnotationThemeSchema is never a gate on this boundary. Validation is the guest's own guards in PickPreload, which read positional arguments: recording-cursor takes (active, options, controller) and routes any first argument that is not the literal true to disposal, recording-controller takes (controller, point), and recording-key and recording-pointer each take one hand-checked object.",
    effects:
      "start-pick and cancel-pick open and tear down the annotation session, annotation-theme and annotation-captured drive the overlay, recording-cursor installs or disposes the shipped recording cursor (a style element plus two document elements and eight window listeners in capture phase), recording-controller and recording-pointer move the agent cursor, and recording-key labels a key press. Malformed values are dropped rather than rejected, so a wrong-typed theme or point silently leaves the previous state, and a second recording-cursor activation reuses the live cursor instead of applying the new options.",
    evidence: evidence("guest", "pickPreload", "recordingCursor", "preview", "ipc", "channels"),
    tests: [
      "apps/desktop/scripts/migration-preload-ipc.test.ts",
      "apps/desktop/src/preview/Manager.test.ts",
    ],
    parityRequirement:
      "The corpus runs the shipped guest half for real: the recording-cursor install, reuse and dispose lifecycle, the malformed recording-controller, recording-key and recording-pointer payloads that leave the cursor untouched, the stored-theme application on reactivation and the no-session cancel-pick, all against a stubbed DOM with captured timers and animation frames. Parity still needs the main-process half executed — which tab receives which send, the recording-cursor restore on dom-ready, the controller patch and human point Manager sends, and the annotation theme lifecycle — plus a real DOM, real Chromium capture, the never-driven start-pick overlay, and a decision on whether the theme should be re-validated on this leg.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "oauth-loopback: GET /callback",
    owner: "connect",
    resources: ["cloud-login-state"],
    representation: "manual-validation",
    direction: "http-request-response",
    authorization:
      "Nonempty code and exact generated OAuth state; separate loopback listener, not environment authentication.",
    contract:
      "Manual code/state query checks; success HTML or invalid-callback text/400, not a JSON API.",
    effects:
      "Completes login Deferred; enclosing login owns PKCE, loopback listener, timeout, token exchange and persistence.",
    evidence: evidence("cli", "cliHtml", "cloudConfig", "secrets", "connectAuth"),
    tests: ["apps/server/src/cloud/CliTokenManager.test.ts"],
    parityRequirement:
      "Exercising the shipped handler with a real listener means binding the hard-coded loopback port 34338 (publicConfig has no override), which is the production port of every CLI login on the machine, so it needs an explicit decision first: add a port override or accept the bind. Existing tests cover only the interaction helpers; state rejection, response bytes, duplicate callbacks, timeout and listener cleanup remain unexecuted.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: * /api/device-hub/*",
    owner: "devices",
    resources: ["device-hub-proxy-connections"],
    representation: "http-proxy",
    direction: "http-request-response",
    authorization:
      "Route/method allowlist, then authenticateWebSocketUpgrade; read scope normally, operate for input sockets and non-read tuning/fold; screenshot POST remains read-scoped.",
    contract:
      "Opaque HTTP streams or bidirectional WebSocket frames; filtered headers/status plus local text and structured auth errors, not a uniform JSON Schema.",
    effects:
      "Uses existing host readiness; strips routing tickets/credentials and owns upstream HTTP or WS resources for the request scope, without starting a hub.",
    evidence: evidence(
      "deviceProxy",
      "deviceService",
      "auth",
      "authHttp",
      "environmentHttp",
      "server",
    ),
    tests: [
      "apps/server/scripts/migration-device-hub-http.test.ts",
      "apps/server/src/device/DeviceHubProxy.test.ts",
    ],
    parityRequirement:
      "Cover successful WS pumps/close, header/body fidelity, host selection, readiness errors and the full scope matrix beyond a stubbed hub; the corpus characterizes path/method gating, read/operate denial, ticket stripping, header hygiene, readiness and response rewriting, but no upgrade or real upstream.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: POST /api/devices",
    owner: "devices",
    resources: ["device-registry"],
    representation: "schema-decoded",
    direction: "http-request-response",
    authorization:
      "No explicit authentication in this raw handler or blanket authentication at environment route mounting.",
    contract:
      "Inline Schema.Struct decodes string deviceId/token/name/platform from JSON; response DeviceInfo has no Schema and malformed input has no explicit 400 mapping.",
    effects:
      "Upserts the in-memory registry and sets registration/last-seen timestamps plus connected=true.",
    evidence: evidence("deviceHttp", "deviceRegistry", "server"),
    tests: ["apps/server/scripts/migration-device-http.test.ts"],
    parityRequirement:
      "The isolated Node corpus covers registration/upsert, malformed JSON/fields and output shape. Full-server authentication boundaries, concurrent requests and replacement-runtime parity remain untested; security policy changes require separate review.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: GET /api/devices",
    owner: "devices",
    resources: ["device-registry"],
    representation: "typescript-only",
    direction: "http-request-response",
    authorization:
      "No explicit authentication in this raw handler or blanket authentication at environment route mounting.",
    contract:
      "No request body; JSON {devices: DeviceInfo[]} includes registry tokens. Response type is erased, not a decoder.",
    effects: "Reads the shared registry map without mutation.",
    evidence: evidence("deviceHttp", "deviceRegistry", "server"),
    tests: ["apps/server/scripts/migration-device-http.test.ts"],
    parityRequirement:
      "The isolated Node corpus covers empty/populated listing, HEAD and synthetic token exposure. Full-server authentication, client handling and replacement-runtime parity remain untested; do not infer safety from typed-API middleware.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: GET /api/devices/by-token/:token",
    owner: "devices",
    resources: ["device-registry"],
    representation: "manual-validation",
    direction: "http-request-response",
    authorization: "No explicit authentication; lookup token is not an authentication guard.",
    contract:
      "Takes the final URL-path segment manually; JSON DeviceInfo or JSON errors with 400/404, no router-param Schema.",
    effects: "Scans registry entries without mutation.",
    evidence: evidence("deviceHttp", "deviceRegistry", "server"),
    tests: ["apps/server/scripts/migration-device-http.test.ts"],
    parityRequirement:
      "The isolated Node corpus covers known/missing/encoded tokens, duplicate-token first-match, errors and route precedence. Network URL parsing, full-server authentication and replacement-runtime parity remain untested.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: GET /api/devices/:deviceId",
    owner: "devices",
    resources: ["device-registry"],
    representation: "manual-validation",
    direction: "http-request-response",
    authorization:
      "No explicit authentication in this raw handler or blanket authentication at environment route mounting.",
    contract:
      "Takes the final URL-path segment manually; JSON DeviceInfo or JSON errors with 400/404, no router-param Schema.",
    effects: "Looks up the shared registry map without mutation.",
    evidence: evidence("deviceHttp", "deviceRegistry", "server"),
    tests: ["apps/server/scripts/migration-device-http.test.ts"],
    parityRequirement:
      "The isolated Node corpus covers ID lookup, missing/encoded IDs, errors and coexistence with the by-token route. Network URL parsing, full-server authentication and replacement-runtime parity remain untested.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: POST /api/observability/v1/traces",
    owner: "environment-http",
    resources: ["browser-trace-delivery"],
    representation: "manual-validation",
    direction: "http-request-response",
    authorization: "authenticateRawRouteWithScope requires orchestration:operate.",
    contract:
      "request.json is cast to OTLP data, then best-effort decodeOtlpTraceRecords; no payload Schema. Empty 204 or forwarding error text/502 is intended, but this revision reads removed ServerConfig fields before the body, so authenticated requests return an empty 500.",
    effects:
      "Intended to record to the injected collector and optionally export upstream; at this revision the handler fails before decoding, so neither a record nor an export occurs.",
    evidence: evidence(
      "http",
      "observability",
      "traceCollector",
      "auth",
      "authHttp",
      "environmentHttp",
      "server",
    ),
    tests: ["apps/server/scripts/migration-otlp-http.test.ts"],
    parityRequirement:
      "The isolated corpus covers credential rejection, scope ordering, POST-only routing and the config-induced 500. Intended decode/record/forwarding/502 behavior cannot be characterized until the removed telemetry configuration is restored or the route is deleted; that is a Phase 1 product decision, not a Phase 0 repair.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: GET /api/assets/*",
    owner: "workspace",
    resources: ["workspace-files"],
    representation: "binary",
    direction: "http-request-response",
    authorization:
      "Signed AssetClaimsSchema capability with expiry and resource-specific checks; no session scope check at this handler.",
    contract:
      "File/media bytes or GitHub response stream, ranges/206/416 and cache/CSP/download headers; signed claim decoding is in AssetAccess, not a JSON response contract.",
    effects:
      "May initialize a shared signing key, read files/icons, hold scoped media descriptors or fetch GitHub data with cached credentials.",
    evidence: evidence("http", "assets", "media", "github", "server"),
    tests: [
      "apps/server/scripts/migration-asset-http.test.ts",
      "apps/server/src/http.test.ts",
      "apps/server/src/assets/AssetAccess.test.ts",
      "apps/server/src/server.test.ts",
    ],
    parityRequirement:
      "The isolated corpus covers attachment claims: forged, expired and deleted-file 404s, inline images ignoring ranges, private no-store video with 206/416 and Accept-Ranges, download disposition with RFC 5987 file names, sandboxed inline HTML and invalid Host. Workspace-file, media-file-exact, project-favicon, native-app-icon and github-media claims, conditional requests, cancellation and helper-level descriptor lifetime remain untested at the route.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: POST /api/attachments/upload/*",
    owner: "workspace",
    resources: ["attachments"],
    representation: "binary",
    direction: "http-request-response",
    authorization:
      "Signed AttachmentUploadClaims with kind/version/expiry checks; no session scope check at this handler.",
    contract:
      "Raw byte stream, not multipart or JSON; declared and received lengths must match signed claims. Empty 204 or text 400/404/500.",
    effects:
      "Consumes request stream in its scope, writes unique .part file, renames on success and removes partial data on failure; may initialize shared signing key.",
    evidence: evidence("http", "uploads", "server"),
    tests: [
      "apps/server/scripts/migration-upload-http.test.ts",
      "apps/server/src/assets/AttachmentUpload.test.ts",
      "apps/server/src/server.test.ts",
    ],
    parityRequirement:
      "The isolated corpus covers route-level token rejection (missing, malformed, tampered, extra segment, expired), Content-Length agreement, exact/chunked/zero-size storage, short and oversized body rejection with .part cleanup and extension selection. Real client interruption, rename-over-existing behavior, authentication middleware and attachment consumption after upload remain untested.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: GET *",
    owner: "environment-http",
    resources: ["static-response-streams"],
    representation: "binary",
    direction: "http-request-response",
    authorization: "No authentication; public static/dev handler with path checks.",
    contract:
      "File/HTML stream, dev redirect/302, empty 304 or text errors; Schema-decoded local build manifest is not a wire payload Schema. GET fallback also handles HEAD.",
    effects:
      "Loads immutable-asset metadata and owns scoped file handles/streams, including SPA fallback and conditional responses.",
    evidence: evidence("http", "server"),
    tests: [
      "apps/server/scripts/migration-static-http.test.ts",
      "apps/server/src/http.test.ts",
      "apps/server/src/server.test.ts",
    ],
    parityRequirement:
      "The isolated corpus covers SPA/HTML fallback, manifest-gated immutable caching, revalidation, 304/HEAD, encoded parent-segment rejection, invalid Host, dev redirect/proxied prefixes and the no-static 503. Compression, ranges, media streaming, packaged-build drift, proxy loops and cancellation remain untested.",
  },
  {
    code: "raw-http-schema-not-declared",
    subject: "environment: GET /ws",
    owner: "environment-http",
    resources: ["environment-rpc-connections"],
    representation: "websocket-upgrade",
    direction: "http-request-response",
    authorization:
      "authenticateWebSocketUpgrade then per-method authorizeEffect/authorizeStream; no single fixed upgrade scope.",
    contract:
      "HTTP upgrade to JSON Effect RPC with WsRpcGroup schemas and unary/stream envelopes; bounded optional client metadata, not a JSON HTTP endpoint.",
    effects:
      "Owns scoped RPC transport/handler layers and terminal windows; records session metadata and connected/disconnected lifecycle while SQL services stay server-owned.",
    evidence: evidence(
      "ws",
      "rpc",
      "rpcAuth",
      "auth",
      "authHttp",
      "session",
      "environmentHttp",
      "server",
    ),
    tests: [
      "apps/server/src/server.test.ts",
      "apps/server/src/auth/SessionStore.test.ts",
      "apps/server/src/terminal/OutputProtocol.test.ts",
    ],
    parityRequirement:
      "Existing tests already bind a real listener on an ephemeral port with the production perMessageDeflate setting and drive real WebSocket RPC clients, so the upgrade path is executed rather than stubbed; that is a suite, not a pinned corpus, and one of its cases currently fails on the known OTLP route defect. Parity still needs frames, streams, method scopes, cookie/ticket handling and teardown on every disconnect/failure path recorded deterministically; the missing vcs.deleteBranch scope remains a separate blocker.",
  },
];

export function classifyMigrationInventory(
  inventory: Pick<MigrationInventory, "issues" | "sources">,
  classifications: readonly ContractClassification[],
) {
  const sources = new Map(inventory.sources.map((source) => [source.file, source.fingerprint]));
  const owners = new Map<string, readonly string[]>(
    migrationOwnership.map((owner) => [owner.id, owner.resources]),
  );
  const reviewIssues: { code: string; subject: string; reason: string }[] = [];
  const key = (entry: { code: string; subject: string }) =>
    JSON.stringify([entry.code, entry.subject]);
  const reviews = new Map<string, ContractClassification[]>();
  for (const classification of classifications) {
    const id = key(classification);
    reviews.set(id, [...(reviews.get(id) ?? []), classification]);
  }
  const findings = new Map<string, number>();
  for (const finding of inventory.issues)
    findings.set(key(finding), (findings.get(key(finding)) ?? 0) + 1);
  for (const [id, entries] of reviews) {
    if (!findings.has(id))
      reviewIssues.push({
        code: entries[0]!.code,
        subject: entries[0]!.subject,
        reason: "Classification no longer matches an inventory finding.",
      });
  }
  const entries = inventory.issues.map((finding) => {
    const matches = reviews.get(key(finding)) ?? [];
    if (!matches.length) return { finding, status: "unclassified" as const, classification: null };
    const classification = matches[0]!;
    const problems = [];
    if (matches.length !== 1) problems.push("Multiple classifications match the same finding.");
    if (findings.get(key(finding)) !== 1)
      problems.push(
        "Multiple inventory findings share this identity; classification is ambiguous.",
      );
    if (!["raw-http-schema-not-declared", "ipc-schema-not-declared"].includes(finding.code))
      problems.push("This finding requires repair, not schema classification.");
    if (
      !classification.contract.trim() ||
      !classification.effects.trim() ||
      !classification.parityRequirement.trim()
    )
      problems.push("Contract, effects and parity requirements must be explicit.");
    const resources = owners.get(classification.owner);
    if (
      !resources ||
      !classification.resources.length ||
      classification.resources.some((resource) => !resources.includes(resource))
    )
      problems.push("Resources must belong to the declared ownership domain.");
    const anchor =
      finding.source?.file ??
      (finding.code === "ipc-schema-not-declared" ? "apps/desktop/src/ipc/channels.ts" : null);
    if (!anchor || !classification.evidence.some((source) => source.file === anchor))
      problems.push("Classification must include the finding's source evidence.");
    if (new Set(classification.evidence.map((source) => source.file)).size < 2)
      problems.push(
        "Classification must include contract or implementation evidence beyond the channel or route declaration.",
      );
    for (const source of classification.evidence) {
      if (sources.get(source.file) !== source.fingerprint)
        problems.push(`Source evidence changed or is missing: ${source.file}`);
    }
    for (const reason of problems)
      reviewIssues.push({ code: finding.code, subject: finding.subject, reason });
    return {
      finding,
      status: problems.length ? ("stale-or-invalid" as const) : ("classified" as const),
      classification,
    };
  });
  return {
    interpretation:
      "Reviewed handler and producer/preload metadata only, with primary ownership links. Fingerprints cover the listed sources, not all transitive dependencies, renderer consumers or tests. Drift invalidates classifications; test references do not prove execution or functional parity.",
    entries,
    reviewIssues,
    unresolved: entries
      .filter((entry) => entry.status !== "classified")
      .map((entry) => entry.finding),
    pendingParity: entries
      .filter((entry) => entry.status === "classified")
      .map((entry) => ({
        code: entry.finding.code,
        subject: entry.finding.subject,
        status: "not-run" as const,
        tests: entry.classification!.tests,
        requirement: entry.classification!.parityRequirement,
      })),
  };
}
