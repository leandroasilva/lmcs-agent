# Sideloading the iOS app with AltStore

The fork is not distributed through the App Store. To run the mobile app on an iOS device,
build the IPA locally and sideload it with [AltStore](https://altstore.io).

## Prerequisites

1. macOS with Xcode installed
2. An Apple ID (a free account works, with the limitations noted below)
3. AltStore installed on your Mac and iOS device
4. Dependencies installed (`npm run setup` from the repository root)

## Build the IPA

Generate the native Xcode project:

```bash
cd apps/mobile
npx expo prebuild --clean --platform ios
```

Open `apps/mobile/ios/LMCSCode.xcworkspace` in Xcode, select the **LMCSCode** target, and under
**Signing & Capabilities** enable automatic signing with your team. Then archive and export a
development IPA, either with **Product → Archive** in Xcode or from the command line:

```bash
cd apps/mobile/ios

xcodebuild -workspace LMCSCode.xcworkspace \
  -scheme LMCSCode \
  -configuration Release \
  -archivePath build/LMCSCode.xcarchive \
  -destination "generic/platform=iOS" \
  archive

xcodebuild -exportArchive \
  -archivePath build/LMCSCode.xcarchive \
  -exportPath build/ipa \
  -exportOptionsPlist ExportOptions.plist
```

The command-line path needs an `ExportOptions.plist` next to the workspace:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>development</string>
    <key>teamID</key>
    <string>YOUR_TEAM_ID</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>
```

## What is not obvious

- The bundle identifiers intentionally remain `com.t3tools.t3code` (plus `.widgets` and `.sharing`
  for the extensions) for compatibility with existing installations; the display name is LMCS Code.
  Xcode rewrites them to include your personal team ID, which is fine.
- A free Apple ID signature expires after 7 days. AltStore re-signs automatically when the device
  shares your Mac's network; otherwise re-sideload.
- Push notifications need the relay and FCM configuration from
  [Android and iOS notifications](../operations/android-notifications.md); a locally sideloaded
  build has none of that by default.

## Sideload

Drag the exported IPA into AltStore on your Mac with the device connected, then trust the
developer certificate under **Settings → General → Device Management** on the device.

If a build fails after signing changes, delete `apps/mobile/ios/` and re-run `expo prebuild`;
stale generated projects are the common cause.
