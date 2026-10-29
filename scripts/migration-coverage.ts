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
    resources: ["managed-cloudflared-child", "managed-endpoint-registration"],
    mutationBoundary: "Generation-aware reconciliation owns only its connector processes.",
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
