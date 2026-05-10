# Building PolyTrack Online for macOS

For an M-series Mac like a MacBook Pro M4 Pro, use the native Apple Silicon build:

```sh
npm install
npm run build-mac-arm64
```

The app will be created in:

```txt
dist/PolyTrack Online-darwin-arm64/
```

Open `PolyTrack Online.app` from that folder.

Because this app is unsigned, macOS may block it the first time. Right-click `PolyTrack Online.app`, choose `Open`, then confirm. If host mode asks for incoming network access, allow it.

Use these build targets:

```sh
npm run build-mac-arm64  # M1/M2/M3/M4 Macs
npm run build-mac-intel  # older Intel Macs
npm run build-win        # Windows x64
```

The Apple Silicon build is the best target for an M4 Pro. It should be the smoothest macOS option and avoids Rosetta translation.
