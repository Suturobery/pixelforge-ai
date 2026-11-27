# Code Signing & Unsigned Installers

PixelForge AI is an independent, free, and open-source desktop application built transparently via GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)).

Because commercial code-signing certificates (Windows EV / Apple Developer ID) cost hundreds of dollars per year, **official PixelForge AI releases are currently unsigned**. Your operating system may show a standard warning the first time you open a freshly downloaded installer.

---

## Windows (SmartScreen)

Windows Defender SmartScreen shows **"Windows protected your PC"** for unsigned installers:

1. Click **More info**.
2. Click **Run anyway**.

## macOS (Gatekeeper)

macOS shows **"PixelForge AI cannot be opened because the developer cannot be verified"** (or "is damaged" due to quarantine attributes on unsigned builds):

1. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
2. Or remove the quarantine flag in Terminal after moving `PixelForge AI.app` into `/Applications`:

```bash
xattr -cr "/Applications/PixelForge AI.app"
```

## Linux (AppImage)

Make the downloaded `.AppImage` executable and run it:

```bash
chmod +x PixelForge-AI-*-x86_64.AppImage
./PixelForge-AI-*-x86_64.AppImage
```

---

## Prefer to Build From Source?

Every line of code is public under [GNU AGPL-3.0](LICENSE). You can inspect and build the studio locally at any time by following [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/development.md`](docs/development.md).
