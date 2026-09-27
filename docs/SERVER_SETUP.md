# LMCS Code Server Deployment Manual

## Overview

This manual documents the complete server deployment process for LMCS Code, a desktop application for local coding agents. The server component handles orchestration, provider management, MCP (Model Context Protocol) sessions, and thread management.

## Prerequisites

### System Requirements

- **Node.js**: v24.13.1 or higher (v24.21.0 recommended)
- **pnpm**: v11.10.0 or higher
- **Operating System**: macOS, Linux, or Windows
- **Memory**: Minimum 4GB RAM recommended
- **Disk Space**: At least 2GB for dependencies and build artifacts

### Required Tools

```bash
# Verify Node.js version (must be 24+)
node --version

# Verify pnpm version (must be 11+)
pnpm --version

# If using nvm, ensure Node 24 is active
nvm use 24
nvm alias default 24
```

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/leandroasilva/lmcs-agent.git
cd lmcs-agent
```

### 2. Install Dependencies

```bash
# Install all workspace dependencies
pnpm install

# If you encounter issues with the lockfile, use:
pnpm install --no-frozen-lockfile
```

### 3. Verify Installation

```bash
# Run typecheck to verify all packages are correctly linked
pnpm exec vp run --parallel --concurrency-limit 4 typecheck

# Expected: Core workspaces (server, web, desktop, packages) should pass
# Note: Mobile workspaces may have pre-existing type errors unrelated to deployment
```

## Configuration

### Environment Variables

The server uses the following environment variables:

| Variable        | Description                | Default                |
| --------------- | -------------------------- | ---------------------- |
| `PORT`          | HTTP server port           | `13773`                |
| `HOME_DIR`      | Application data directory | `.lmcs-agent`          |
| `VITE_HTTP_URL` | Web client HTTP URL        | Auto-configured in dev |
| `VITE_WS_URL`   | WebSocket URL              | Auto-configured in dev |

### Application Data Directory

LMCS Code stores its data in `.lmcs-agent/` by default, separate from the upstream T3 Code installation. This includes:

- Database files (SQLite)
- Settings and configuration
- Authentication state
- Session data

### Provider Configuration

LMCS Code supports multiple AI provider drivers:

- **Codex**: OpenAI's Codex CLI
- **Claude Agent**: Anthropic's Claude Agent SDK
- **Cursor**: Cursor IDE integration
- **Grok**: xAI's Grok Build
- **OpenCode**: OpenCode CLI
- **Antigravity**: Antigravity provider

Each provider must be installed and authenticated separately. Use the application's Settings → Providers interface to configure them.

## Starting the Server

### Development Mode

```bash
# Start the full development environment (web + server)
npm run dev

# Or start components individually:
npm run dev:server   # Server only (port 13773)
npm run dev:web      # Web client only (port 5733)
```

### Production Mode

```bash
# Build all packages
npm run build

# Start the production server
npm run start
```

### Using the Launcher Script

The repository includes a launcher script that manages the pinned toolchain:

```bash
# Setup (installs correct Node/pnpm versions)
node scripts/lmcs-agent.mjs setup

# Start development
node scripts/lmcs-agent.mjs dev

# Run tests
node scripts/lmcs-agent.mjs test

# Run typecheck
node scripts/lmcs-agent.mjs typecheck
```

## Server Architecture

### Core Components

1. **Orchestration Engine**: Manages threads, commands, and project state
2. **Provider Runtime**: Handles AI provider sessions and communication
3. **MCP Server**: Model Context Protocol HTTP server for external integrations
4. **WebSocket Server**: Real-time communication with web/desktop clients
5. **Persistence Layer**: SQLite-based storage for threads, projects, and settings

### Key Directories

```
apps/server/src/
├── cli/                    # CLI commands and argument parsing
├── orchestration/          # Core orchestration engine
│   └── Layers/             # Effect layers for projection, providers
├── provider/               # Provider adapters and management
│   └── Layers/             # Provider-specific runtime layers
├── mcp/                    # MCP protocol implementation
├── persistence/            # Database and migrations
└── cloud/                  # Cloud sync and relay functionality
```

### API Endpoints

| Endpoint        | Method    | Description                    |
| --------------- | --------- | ------------------------------ |
| `/`             | GET       | Health check                   |
| `/mcp`          | POST      | MCP protocol messages          |
| `/ws`           | WebSocket | Real-time client communication |
| `/api/threads`  | GET/POST  | Thread management              |
| `/api/projects` | GET/POST  | Project management             |

## Testing

### Running Tests

```bash
# Run all server tests
pnpm exec vp run --filter t3 test

# Run non-server tests (web, desktop, packages)
pnpm exec vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!lmcs-agent' test

# Run specific test file
cd apps/server && pnpm exec vp test run src/provider/providerCompatibility.test.ts
```

### Test Coverage

The server test suite includes:

- **Unit tests**: Individual component testing
- **Integration tests**: End-to-end orchestration flows
- **Provider tests**: Mock provider interactions
- **Persistence tests**: Database migrations and queries

## Troubleshooting

### Common Issues

#### 1. "Unknown file extension .ts"

**Cause**: Node.js version is below 24, which doesn't support native TypeScript type stripping.

**Solution**:

```bash
nvm install 24
nvm use 24
node --version  # Should show v24.x.x
```

#### 2. "No exports main defined in @ff-labs/fff-node"

**Cause**: Pre-existing issue with the `@ff-labs/fff-node` package configuration.

**Impact**: Some test files fail to load, but core functionality is unaffected.

**Workaround**: This is a known issue being tracked. The affected tests are integration tests that depend on this package.

#### 3. "@pierre/diffs utils/parsePatchFiles not exported"

**Cause**: The pnpm patch for `@pierre/diffs` wasn't applied during install.

**Solution**:

```bash
# Force reinstall with patches
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

#### 4. Port Already in Use

**Cause**: Another process is using port 13773 (server) or 5733 (web).

**Solution**:

```bash
# Find and kill the process
lsof -ti:13773 | xargs kill -9
lsof -ti:5733 | xargs kill -9

# Or use a different port
PORT=14000 npm run dev:server
```

#### 5. Provider Not Found

**Cause**: The AI provider CLI is not installed or not in PATH.

**Solution**:

1. Install the provider CLI (e.g., `codex`, `claude`, `cursor`)
2. Authenticate with the provider
3. Restart the LMCS Code server
4. Check Settings → Providers to verify detection

### Database Issues

#### Reset Database

```bash
# Stop the server
# Delete the database files
rm -rf .lmcs-agent/*.db

# Restart the server (will recreate database)
npm run dev:server
```

#### Run Migrations

Migrations run automatically on startup. To manually trigger:

```bash
node apps/server/scripts/migrate-dev-db.ts
```

### Logging

Server logs are output to stdout. For debugging:

```bash
# Enable verbose logging
DEBUG=* npm run dev:server

# Or filter by component
DEBUG=orchestration:* npm run dev:server
```

## Desktop Build

### Building macOS DMG

```bash
# Build for ARM64 (Apple Silicon)
npm run dist:desktop:dmg:arm64

# Build for x64 (Intel)
npm run dist:desktop:dmg:x64
```

### Build Output

Artifacts are produced in the `release/` directory:

- `LMCS-Code-{version}-arm64.dmg` - macOS installer
- `LMCS-Code-{version}-arm64.zip` - ZIP archive
- `.blockmap` files for delta updates

### Code Signing

For production builds, code signing requires:

- Valid Apple Developer Certificate
- `CSC_LINK` or `CSC_NAME` environment variable
- Notarization credentials for macOS distribution

## Version Information

- **Current Version**: 0.0.1
- **Package Scope**: `@lmcstools/*`
- **Repository**: https://github.com/leandroasilva/lmcs-agent

## Support

For issues and questions:

- GitHub Issues: https://github.com/leandroasilva/lmcs-agent/issues
- Documentation: See `docs/` directory in the repository

## License

MIT License - See LICENSE file for details.
