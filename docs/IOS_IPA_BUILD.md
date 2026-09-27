# iOS IPA Build Guide for AltStore

This guide explains how to build the LMCS Code iOS IPA for sideloading via AltStore.

## Prerequisites

1. **macOS** with Xcode installed (tested with Xcode 27.0)
2. **Apple ID** (free or paid developer account)
3. **AltStore** installed on your Mac and iOS device
4. **Node.js 24+** and **pnpm 11+**

## Step 1: Generate Native iOS Project

```bash
cd apps/mobile
npx expo prebuild --clean --platform ios
```

This creates the `ios/` directory with the native Xcode project.

## Step 2: Configure Signing in Xcode

1. Open `apps/mobile/ios/LMCSCode.xcworkspace` in Xcode
2. Select the **LMCSCode** target
3. Go to **Signing & Capabilities** tab
4. Check **Automatically manage signing**
5. Select your **Team** (your Apple ID or developer account)
6. If using a free account, Xcode will create a personal provisioning profile

### Bundle Identifier

The default bundle identifiers are:

- Main app: `com.t3tools.t3code` (or `com.t3tools.t3code.dev` for dev builds)
- Widgets: `com.t3tools.t3code.widgets`
- Sharing extension: `com.t3tools.t3code.sharing`

For personal team builds, Xcode will automatically modify these to include your team ID.

## Step 3: Build and Archive

### Option A: Using Xcode GUI

1. Select **Product → Archive** from the menu
2. Wait for the archive to complete (may take 5-10 minutes)
3. Open **Window → Organizer**
4. Select the archive and click **Distribute App**
5. Choose **Custom** → **Development** → **Next**
6. Select **App Thinning: None** → **Next**
7. Check **Rebuild from Bitcode: No** → **Next**
8. Choose **Automatically manage signing** → **Next**
9. Click **Export** and save the IPA

### Option B: Using Command Line

```bash
cd apps/mobile/ios

# Archive the project
xcodebuild -workspace LMCSCode.xcworkspace \
  -scheme LMCSCode \
  -configuration Release \
  -archivePath build/LMCSCode.xcarchive \
  -destination "generic/platform=iOS" \
  archive

# Export the IPA
xcodebuild -exportArchive \
  -archivePath build/LMCSCode.xcarchive \
  -exportPath build/ipa \
  -exportOptionsPlist ExportOptions.plist
```

**Note**: You need to create an `ExportOptions.plist` file with your signing configuration. See the template below.

## ExportOptions.plist Template

Create `apps/mobile/ios/ExportOptions.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>development</string>
    <key>teamID</key>
    <string>YOUR_TEAM_ID</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <false/>
    <key>compileBitcode</key>
    <false/>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>com.t3tools.t3code</key>
        <string>LMCSCode Dev</string>
    </dict>
</dict>
</plist>
```

Replace `YOUR_TEAM_ID` with your Apple Developer Team ID (found in Xcode under Preferences → Accounts).

## Step 4: Sideload with AltStore

1. Open **AltStore** on your Mac
2. Connect your iOS device via USB
3. Drag the exported IPA file into AltStore
4. AltStore will sideload the app onto your device
5. On your iOS device, go to **Settings → General → Device Management**
6. Trust your developer certificate

### Free Developer Account Limitations

If using a free Apple ID:

- Apps must be re-signed every **7 days**
- AltStore handles this automatically when your device is on the same WiFi
- You may need to re-sideload after 7 days

## Troubleshooting

### "No signing certificate found"

**Solution**: In Xcode, go to Preferences → Accounts and add your Apple ID.

### "Provisioning profile doesn't include signing certificate"

**Solution**:

1. Delete existing profiles in `~/Library/MobileDevice/Provisioning Profiles/`
2. Let Xcode recreate them automatically

### "The operation couldn't be completed"

**Solution**:

1. Clean the build folder in Xcode (Product → Clean Build Folder)
2. Delete `apps/mobile/ios/` and re-run `npx expo prebuild`
3. Try building again

### App crashes on launch

**Solution**:

1. Check device logs in Xcode (Window → Devices and Simulators)
2. Ensure all required permissions are granted
3. Verify the app has network access if needed

## App Configuration

### Version Information

- **App Name**: LMCS Code
- **Bundle Identifier**: `com.t3tools.t3code` (auto-modified for personal team)
- **Deployment Target**: iOS 17.0
- **Slug**: `lmcs-code`

### Features

- Full LMCS Code functionality
- Widget support (AgentActivity, SubscriptionUsage)
- Share extension for importing content
- Push notifications (requires configuration)

## Alternative: EAS Build (Expo Application Services)

If you have an Expo account and EAS subscription:

```bash
cd apps/mobile
npx eas build --platform ios --profile preview
```

This builds the IPA in the cloud and provides a download link.

## Support

For issues specific to iOS builds:

- Check the [Expo iOS documentation](https://docs.expo.dev/guides/local-app-development/)
- Review Xcode build logs in the Report Navigator
- Consult AltStore's troubleshooting guide

## Notes

- The bundle identifier still uses `com.t3tools.t3code` for compatibility with existing installations
- The app display name is "LMCS Code" regardless of bundle identifier
- All internal branding has been updated to LMCS Code / LMCS Connect
