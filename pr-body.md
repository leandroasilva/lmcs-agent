## Summary

Fixes two critical issues with the desktop release pipeline:

1. **Gatekeeper Error**: The app was being code-signed but not notarized, causing macOS to block it with "The item cannot be opened because Apple cannot check it for malicious software."

2. **Auto-update Failure**: The update feed files (latest*.yml, latest*.yml.blockmap) were not being published to the GitHub Release, so electron-updater could not detect or download updates.

## Changes

### scripts/build-desktop-artifact.ts

- Added macOS DMG notarization step using `xcrun notarytool` when Apple API credentials are available
- Notarization runs after the DMG is built and before artifacts are copied to the output directory

### .github/workflows/deploy.yml

- Added `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` environment variables to the macOS build job
- Added `latest*.yml` and `latest*.yml.blockmap` to the artifact upload paths
- Updated the release creation step to include yml and blockmap files

## Required GitHub Secrets

The following secrets must be configured for notarization to work:

- `APPLE_API_KEY` - Base64-encoded Apple API key file
- `APPLE_API_KEY_ID` - Apple API key ID
- `APPLE_API_ISSUER` - Apple API issuer ID

If these secrets are not configured, the build will still succeed but the DMG will not be notarized (same as current behavior).
