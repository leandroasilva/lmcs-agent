# LMCS Agent

LMCS Agent is an open-source control surface for coding agents. A Node.js WebSocket server wraps the provider CLIs installed on your machine and serves web, desktop (Electron), and mobile (React Native) clients over authenticated WebSocket RPC. The server runs where your code lives; clients can connect from any machine on your network, over Tailscale, or through a self-hosted relay.

Think of LMCS Agent as a bring-your-own-subscription alternative to apps like Claude Desktop, Codex App, or Cursor — except it runs on your hardware, uses your provider credentials, and gives you full control.

### Origin

This project was forked from [LMCS Code](https://github.com/pingdotgg/t3code) (originally T3 Code) and has been heavily customized to fit the daily workflow of its maintainer. What started as a set of personal tweaks — additional provider integrations, custom automations, deployment pipelines, and quality-of-life adjustments — grew into a more complete and opinionated solution. LMCS Agent extends the original with extra providers, streamlined self-hosted deployment via Docker and HCloud, automated CI/CD for desktop and mobile builds, and various enhancements shaped by real daily use.

## Features

### Multi-provider agent orchestration

Run coding agents from a single interface. LMCS Agent supports **eight providers** out of the box:

| Provider        | CLI            | Authentication        |
| --------------- | -------------- | --------------------- |
| **Codex**       | `codex`        | `codex login`         |
| **Claude**      | `claude`       | `claude auth login`   |
| **Cursor**      | `cursor-agent` | `agent login`         |
| **Grok Build**  | `grok`         | `grok login`          |
| **OpenCode**    | `opencode`     | `opencode auth login` |
| **Qoder**       | `qoder`        | `qoder login`         |
| **CommandCode** | `cmd`          | `cmd auth login`      |

Each provider is isolated by instance — multiple accounts, separate credentials, independent model catalogs. Switch between providers and models mid-thread. Configure per-instance environment variables, API keys, and custom base URLs.

### Three client surfaces

- **Web** — React/Vite UI served by the Node.js server. Open it from any browser on your network. Also available at the configured hosted app URL (default: `https://lmcs-agent.cloud.hcloud.net.br`).
- **Desktop** — Full Electron app that bundles the server runner. Available for macOS (ARM64/x64), Windows (ARM64/x64), and Linux (AppImage/x64). Supports auto-update, global keyboard shortcuts, and native SnapShot captures.
- **Mobile** — React Native app for iOS and Android. Connect to any LMCS Agent server to control work remotely. Features device panel integration, push notifications, and home screen widgets for subscription tracking.

### Remote-ready architecture

The server is designed to run headless and be controlled remotely:

- **Direct connection** — Connect clients directly to the server over HTTP/WebSocket on port 80.
- **LAN pairing** — Direct pairing over your local network or Tailscale.
- **Docker deployment** — Self-hosted container with persistent data volume, ready for HCloud or any cloud provider.
- **Tailscale HTTPS** — Serve over your tailnet with automatic HTTPS.

### Integrated source control

Full Git integration with GitHub, GitLab, Forgejo, Gitea, Bitbucket, and Azure DevOps:

- Clone and publish repositories
- AI-generated commit messages and PR descriptions using the thread's model
- Create, review, and merge pull requests
- GitHub stack support (merge stack, rebase stack)
- Linked pull requests across threads and repositories
- Mark files as viewed in diffs
- Auto-merge with waiting checks

### Permission modes

Control when agents need approval:

| Mode                  | Behavior                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes                         |
| **Auto-accept edits** | Approves file edits automatically; other actions still require approval |
| **Auto**              | Uses the provider's automatic review for routine actions                |
| **Full access**       | Allows commands and edits without approval prompts                      |

### Threads and workspaces

- **Threads** — Durable conversation and work history for a project. Survives provider process exits.
- **Worktrees** — Isolate code changes in separate Git checkouts per thread.
- **Checkpoints** — Hidden Git refs capture workspace state for diffs and restore without polluting your branch history.
- **Background threads** — Start a thread and immediately begin another. Shift-click models to fan out the same prompt across multiple models.
- **Thread management** — Pin, snooze, settle, archive, and drag-to-reorder threads.

### Composer and context

- Attach up to 100 files per message (images up to 10 MiB, other files up to 50 MiB)
- Drag-and-drop files onto threads
- SnapShot captures — screenshot the active window with accessibility data for agent reasoning
- Voice input support
- Queue or steer messages while the agent is working
- Context references for files, previous responses, and skills

### Usage tracking

Unified usage dashboard across all providers:

- Token counts, cache savings, and model breakdowns
- Estimated API-equivalent costs
- Subscription limit tracking with per-account pool visibility
- Custom model pricing overrides
- CLIProxyAPI hub integration for pooled accounts
- Mobile home screen widgets for Codex and Claude quota tracking

### Device panel

Live iOS Simulator and Android Emulator integration:

- Watch agents verify mobile work in real time
- Interactive touch, keyboard, and gesture control
- Agents control devices through `device_*` tools
- Float device over chat for side-by-side work

### Appearance and customization

- Multiple themes with light/dark mode
- System appearance following
- Material You theming on Android 12+
- Customizable keybindings
- Configurable send shortcut (Enter vs. `mod+Enter`)
- Panel animation control

## Getting started

### Prerequisites

- Git
- Node.js 24.18.0+ (the launcher pins this automatically)
- pnpm 11.10.0 (the launcher pins this automatically)
- At least one installed, authenticated provider CLI

### Install from source

```sh
git clone https://github.com/leandroasilva/lmcs-agent
cd lmcs-agent
npm run setup
npm run lmcs -- dev
```

The launcher pins Node 24.18.0 and pnpm 11.10.0 without changing the global toolchain. `setup` installs the frozen lockfile into a local `.pnpm-store/`; later runs reuse it.

Then:

1. Read the actual web and server ports from the `[dev-runner]` output. They derive from the checkout path and shift when a port is occupied.
2. Open the full pairing URL printed by the server. The bare origin does not authenticate a new browser. Treat pairing URLs as credentials — do not commit, publish, or share them.
3. Add a project from a local directory, pick a provider, and start a thread.

### Install the CLI

For production use without a source checkout:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/leandroasilva/lmcs-agent/main/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/leandroasilva/lmcs-agent/main/scripts/install.ps1 | iex
```

| Task                                             | Command              |
| ------------------------------------------------ | -------------------- |
| Start the server and open the web app            | `t3`                 |
| Start the server without a browser               | `t3 serve`           |
| Keep it running in the background (macOS, Linux) | `t3 service install` |
| Move to the newest release                       | `t3 update`          |
| Remove it again                                  | `t3 uninstall`       |

### Desktop app

Download the latest release for your platform from [GitHub Releases](https://github.com/leandroasilva/lmcs-agent/releases). The desktop app bundles its own server and updates itself automatically.

### Mobile app

The mobile app is not published to app stores. Build it from source:

- **iOS**: [sideload the IPA with AltStore](./docs/user/ios-sideload.md)
- **Android**: build from `apps/mobile` with `vp run android:dev`, or produce an APK through EAS

## Launcher commands

`npm run lmcs -- <task>` runs one task under the pinned toolchain:

| Task                             | What it does                                           |
| -------------------------------- | ------------------------------------------------------ |
| `setup`                          | Install dependencies (frozen lockfile, local store)    |
| `dev`, `dev:server`, `dev:web`   | Run server and web together, or each side alone        |
| `dev:desktop`                    | Run the Electron app against the dev server            |
| `build`, `build:desktop`         | Build the apps, or the desktop + server bundles        |
| `start`                          | Serve the compiled app on loopback (run `build` first) |
| `test`                           | Run the workspace test suite                           |
| `typecheck`, `lint`, `fmt:check` | Workspace checks                                       |

### Desktop distribution

| Task                     | Platform                                  |
| ------------------------ | ----------------------------------------- |
| `dist:desktop:dmg`       | macOS DMG (auto-detect arch)              |
| `dist:desktop:dmg:arm64` | macOS DMG (ARM64)                         |
| `dist:desktop:dmg:x64`   | macOS DMG (x64)                           |
| `dist:desktop:linux`     | Linux AppImage (x64)                      |
| `dist:desktop:win`       | Windows NSIS installer (auto-detect arch) |
| `dist:desktop:win:arm64` | Windows NSIS installer (ARM64)            |
| `dist:desktop:win:x64`   | Windows NSIS installer (x64)              |

### Native helpers

Rust helper tests are separate from the JavaScript suite and need a Rust toolchain:

```sh
cargo test --locked --manifest-path native/resource-monitor/Cargo.toml
cargo test --locked --manifest-path native/kde-snap-shot/Cargo.toml
```

## Architecture

LMCS Agent keeps execution in the environment that owns the workspace. Web, desktop, and mobile clients control it over authenticated RPC. A remote client never substitutes its own filesystem, provider credentials, or machine state for the environment's.

### How it works

Clients send typed WebSocket requests. The server turns them into **commands**, a pure **decider** turns commands into persisted **events**, and a **projector** derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider **adapters** translate their native protocols into orchestration events. Side effects run in queue-backed **reactors** that emit **receipts** when milestones land. Each turn ends with a **checkpoint** — a hidden Git ref — so the app can diff and restore workspace state.

### Event-sourced orchestration

The event log is the source of truth. The engine serializes commands; the decider produces events without performing provider or filesystem work. Events, persisted projections, and the accepted command receipt commit in one database transaction. This keeps command retries idempotent and prevents projections from getting ahead of the event log.

### Provider adapter boundary

Complexity lives at the adapter boundary. Orchestration works with normalized commands and events, so adding a provider does not require branches throughout the domain or clients. Each driver implements `ProviderDriver` with an adapter (runtime protocol translation), a provider (snapshot/probe for UI), and text generation (AI-powered commit messages and PR content).

## Repository layout

```
apps/
  server/          WebSocket server, orchestration, provider adapters, checkpointing
  web/             React/Vite UI
  desktop/         Electron shell wrapping the web app
  mobile/          React Native app for iOS and Android
  marketing/       Landing page (Astro)

packages/
  core/            Wire contracts and shared runtime (@lmcstools/core)
  client/          Client logic shared by web and mobile (@lmcstools/client)
  network/         SSH and Tailscale transport (@lmcstools/network)
  providers/       ACP and Codex app-server protocol support (@lmcstools/providers)

native/
  resource-monitor/     System resource telemetry (Rust)
  kde-snap-shot/        KDE Wayland snapshot capture (Rust)
  hyprland-snap-shot/   Hyprland Wayland snapshot capture (Rust)
  libghostty-vt/        Terminal VT emulation library
  browser-secret/       Browser credential helpers

infra/
  relay/           Self-hostable relay for LMCS Connect

scripts/           Repository tooling
.repos/            Vendored read-only references
```

## Tech stack

| Layer    | Technology                          |
| -------- | ----------------------------------- |
| Runtime  | Node.js 24, Effect-TS 4.0           |
| Frontend | React 19, Tailwind CSS 4, shadcn/ui |
| Build    | Vite+, TypeScript 7, pnpm 11        |
| Desktop  | Electron 44, electron-builder       |
| Mobile   | Expo 57, React Native 0.86          |
| Database | SQLite (server state), Effect SQL   |
| Native   | Rust (cargo)                        |
| Linting  | oxlint, knip, @shadcn/lint          |

## Documentation

### Using LMCS Code

- [Installation guide](./docs/user/install.md)
- [Usage and limits](./docs/user/usage.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Remote access](./docs/user/remote-access.md)
- [Background service](./docs/user/background-service.md)
- [Source control](./docs/user/source-control.md)
- [Working with threads](./docs/user/thread-sidebar.md)
- [Messages and context](./docs/user/composer.md)
- [SnapShots](./docs/user/snap-shot.md)
- [Device panel](./docs/user/devices.md)
- [Appearance and themes](./docs/user/appearance.md)
- [Project settings](./docs/user/project-settings.md)
- [Updating LMCS Code](./docs/user/updating.md)
- Provider guides: [Codex](./docs/user/providers-codex.md), [Claude](./docs/user/providers-claude.md), [OpenCode](./docs/user/providers-opencode.md)

### Working on the codebase

- [Architecture overview](./docs/internals/overview.md)
- [Glossary](./docs/internals/glossary.md)
- [Provider constraints](./docs/internals/providers.md)
- [Connection runtime](./docs/internals/connection-runtime.md)
- [Remote environments](./docs/internals/remote.md)
- [Development runbook](./docs/operations/development.md)
- [Release process](./docs/operations/release.md)
- [Observability](./docs/operations/observability.md)

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR, and [AGENTS.md](./AGENTS.md) for the working agreement that governs agent-driven changes.

We are most likely to accept small, focused bug fixes, reliability improvements, and tightly scoped maintenance work. Feature requests and proposals belong in [Ideas discussions](https://github.com/leandroasilva/lmcs-agent/discussions/categories/ideas).

## License

MIT License — see [LICENSE](./LICENSE) for details.

Copyright (c) 2026 Leandro Asci da Silva

LMCS Agent is a fork of [LMCS Code](https://github.com/pingdotgg/t3code) (originally T3 Code by T3 Tools Inc.), extended and customized for personal daily use. The source remains under the MIT license with its original attribution.
