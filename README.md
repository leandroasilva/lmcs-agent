# LMCS Code

A coding-agent desktop app based on [T3 Code](https://github.com/pingdotgg/t3code), imported from commit `7a12aff471ffe2b22b9fee495b04b32c43f45a37`. LMCS Code has its own product name and icons while preserving the upstream functionality, provider integrations, internal package names, connection protocols, and MIT attribution.

## Run this checkout

Prerequisites: Git, Node.js, npm, and an installed, authenticated agent provider. Native desktop and Rust helpers additionally need the platform's build toolchain.

From this repository's root, run:

```sh
npm run setup
npm run lmcs -- dev
```

The launcher selects Node 24.18.0 and pnpm 11.10.0 without changing the global toolchain. Setup installs the frozen lockfile into a local `.pnpm-store/`; subsequent commands reuse the installed dependencies.

### Open the application

1. Keep the development command running. Read the actual web and server ports from its output; they are selected for the checkout and can change when ports are occupied. This checkout was verified with web port `5733` and server port `13773`.
2. Open the complete private pairing URL printed by the server in your browser. Opening the bare web address in a new browser does not authenticate it. Treat pairing URLs as credentials: do not commit, publish, or share them unintentionally.
3. Add a project using a local repository directory, select an available provider, and start a thread. The server uses the provider credentials on the machine where it runs. For example, authenticate an installed Claude CLI with `claude auth login` before using Claude.

The application is branded **LMCS Code** across desktop, web, and mobile. Internal `t3code` identifiers and existing data paths remain compatible. Subscriptions and third-party hosted services are not bundled with this checkout.

Local databases, settings, and authentication state live in the ignored `.lmcs-agent/` directory, separate from an existing T3 Code installation. Do not point the development server at `~/.t3/userdata`. Development uses Vite's same-origin proxy; do not set `VITE_HTTP_URL` or `VITE_WS_URL`.

### Desktop and production

Electron connects to its local server automatically; no manual pairing token is required. The browser's pairing token is a local access credential, not a provider API key.

```sh
# Electron development
npm run lmcs -- dev:desktop

# Build, then serve the compiled application on loopback
npm run lmcs -- build
npm run lmcs -- start
```

Stop development with Ctrl+C before starting production: both LMCS launch modes use the same local data directory. Read the production address and pairing URL from its output. A different port can be selected with `npm run lmcs -- start --port 14000`.

### Checks

```sh
npm run lmcs -- test
npm run lmcs -- typecheck
npm run lmcs -- lint
npm run lmcs -- fmt:check
```

Native helper tests require Rust and are separate from the JavaScript/TypeScript suite:

```sh
cargo test --locked --manifest-path native/resource-monitor/Cargo.toml
cargo test --locked --manifest-path native/kde-snap-shot/Cargo.toml
# Linux only; run on Linux or inside a Linux container
cargo test --locked --manifest-path native/hyprland-snap-shot/Cargo.toml
```

### Verified baseline

Before the LMCS Code branding changes, local verification on September 25, 2026:

- Full workspace suite: 17,826 passed, 56 skipped; no failures.
- Launcher and updated desktop preload verifier: 18 focused tests passed.
- All three native Rust helpers: 38 tests passed, using Linux Docker for Hyprland.
- Root build and all 15 workspace typecheck tasks passed.
- Lint completed with zero errors and 776 inherited warnings. Formatting checks passed for the changed files.
- Development and production entry pages, authentication endpoints, and application assets passed HTTP smoke checks.

Interactive browser flows and a live provider conversation have not been verified. Native mobile builds, desktop installers, and hosted GitHub workflows have not been verified either. The imported workflows still depend on upstream runner services and release credentials; publishing LMCS releases requires separate configuration.

## Upstream project reference

The original project instructions below describe T3 Code's published distribution, not an LMCS release. Use the source-checkout commands above for LMCS Code. The imported source remains covered by the [MIT license](./LICENSE) and its original attribution.

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
