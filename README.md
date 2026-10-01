# LMCS Code

LMCS Code is a control surface for coding agents, forked from [LMCS Code](https://github.com/leandroasilva/lmcs-agent).
A local server wraps the provider CLIs installed on your machine — Codex, Claude Code, Cursor, Grok Build,
OpenCode, and Google Antigravity — and serves web, desktop (Electron), and mobile (React Native) clients over
authenticated WebSocket RPC. The server runs where your code lives; clients can connect from any machine.

The fork preserves upstream functionality, provider integrations, and internal identifiers, and ships its own
product name and icons. The source remains under the [MIT license](./LICENSE) with its original attribution.

## Getting started

Prerequisites: Git, npm, and at least one installed, authenticated provider CLI (for example
`claude auth login` for Claude Code). Native desktop and Rust helpers additionally need the platform build
toolchain.

```sh
npm run setup
npm run lmcs -- dev
```

The launcher pins Node 24.18.0 and pnpm 11.10.0 without changing the global toolchain. `setup` installs the
frozen lockfile into a local `.pnpm-store/`; later runs reuse it.

Then:

1. Read the actual web and server ports from the `[dev-runner]` output. They derive from the checkout path
   and shift when a port is occupied.
2. Open the full pairing URL printed by the server. The bare origin does not authenticate a new browser.
   Treat pairing URLs as credentials: do not commit, publish, or share them.
3. Add a project from a local directory, pick a provider, and start a thread. The server uses the provider
   credentials of the machine it runs on.

Development state lives in the checkout's gitignored `.lmcs-agent/` directory, separate from a real
installation's `~/.t3`. Never point a dev server at `~/.t3/userdata`. Dev is single-origin through Vite's
proxy; do not set `VITE_HTTP_URL` or `VITE_WS_URL`.

For install options beyond a source checkout (background service, packaged desktop builds, mobile), see
[docs/user/install.md](./docs/user/install.md).

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

Stop the dev server (Ctrl+C) before `start`; both use the same local data directory.

Native Rust helper tests are separate from the JavaScript suite and need a Rust toolchain:

```sh
cargo test --locked --manifest-path native/resource-monitor/Cargo.toml
cargo test --locked --manifest-path native/kde-snap-shot/Cargo.toml
```

## Repository layout

- `apps/server` — WebSocket server, orchestration, provider adapters, checkpointing
- `apps/web` — React/Vite UI; `apps/desktop` wraps it in an Electron shell
- `apps/mobile` — React Native app for iOS and Android
- `apps/marketing` — landing page
- `packages/core` — wire contracts and shared runtime (`@lmcstools/core`)
- `packages/client` — client logic shared by web and mobile (`@lmcstools/client`)
- `packages/network` — SSH and Tailscale transport (`@lmcstools/network`)
- `packages/providers` — ACP and Codex app-server protocol support (`@lmcstools/providers`)
- `native/` — Rust helpers (resource monitor, snapshot capture)
- `infra/relay` — self-hostable relay for LMCS Connect
- `scripts/` — repository tooling; `.repos/` holds vendored read-only references

## Documentation

Full docs live in [docs/](./docs).

- Using LMCS Code: [install](./docs/user/install.md) · [permission modes](./docs/user/permission-modes.md) ·
  [keyboard shortcuts](./docs/user/keybindings.md) · [remote access](./docs/user/remote-access.md) ·
  [background service](./docs/user/background-service.md) · [updating](./docs/user/updating.md) ·
  provider guides ([Codex](./docs/user/providers-codex.md), [Claude](./docs/user/providers-claude.md),
  [OpenCode](./docs/user/providers-opencode.md), [Antigravity](./docs/user/providers-antigravity.md))
- Working on the codebase: [architecture overview](./docs/internals/overview.md) ·
  [glossary](./docs/internals/glossary.md) · [development runbook](./docs/operations/development.md)

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR, and
[AGENTS.md](./AGENTS.md) for the working agreement that governs agent-driven changes.
