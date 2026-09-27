# LMCS Code - Quick Start Guide

Get LMCS Code running in under 5 minutes.

## Prerequisites

- **Node.js 24+** - `nvm install 24 && nvm use 24`
- **pnpm 11+** - `npm install -g pnpm`
- **Rust** (for native modules) - https://rustup.rs/

## Installation

```bash
# Clone and install
git clone https://github.com/leandroasilva/lmcs-agent.git
cd lmcs-agent
pnpm install

# Start development
pnpm dev
```

The app opens at http://localhost:5733

## Common Commands

| Command            | Description                |
| ------------------ | -------------------------- |
| `pnpm dev`         | Start web + server dev     |
| `pnpm dev:desktop` | Start Electron desktop app |
| `pnpm build`       | Build all apps             |
| `pnpm test`        | Run tests                  |
| `pnpm typecheck`   | Type check all workspaces  |
| `pnpm lint`        | Lint code                  |

## Building for Production

### Desktop (macOS)

```bash
pnpm dist:desktop:dmg:arm64  # Apple Silicon
pnpm dist:desktop:dmg:x64    # Intel
```

Output: `release/LMCS-Code-*.dmg`

### Server

```bash
pnpm build:desktop
node apps/server/dist/bin.mjs
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key variables:

- `LMCS_HOME` - Data directory (default: `~/.lmcs`)
- `LMCS_PORT` - Server port (default: `13773`)
- `LMCS_CLERK_*` - Authentication (optional)

## Project Structure

```
apps/
  web/        # React web app
  desktop/    # Electron app
  mobile/     # React Native app
  server/     # Node.js backend
  marketing/  # Landing page

packages/
  shared/     # Shared utilities
  contracts/  # API schemas
  client-runtime/  # Client state
```

## Need Help?

- **Docs**: `docs/` directory
- **Issues**: https://github.com/leandroasilva/lmcs-agent/issues
- **Development**: See `docs/operations/development.md`
