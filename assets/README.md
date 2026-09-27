# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the LMCS Code mark: a mint L and a lavender code chevron. Production uses a dark navy background, development uses blue, and nightly uses violet. Asset filenames retain their upstream names for packaging compatibility.

Run `vp run icons:export` from the repository root to regenerate the tracked macOS, iOS, Linux, Windows, and web assets. Development web exports are copied to `apps/web/public`, and production exports to `apps/marketing/public`. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

The export script frames the rounded Icon Composer rendition in an 824×824 area on a transparent 1024×1024 canvas, inset 100 pixels on every side. This reproducible LMCS export does not require the GUI-only pre-Tahoe preset. Desktop packaging derives ICNS files from these PNGs.

Do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  blue and violet backgrounds. Production uses solid navy (`#101A2E`).
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. It also generates `android-icon-mark.png` and `android-notification-icon.png` as white silhouettes for themed launcher icons and notifications.
