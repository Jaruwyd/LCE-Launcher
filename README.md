# LCE Launcher

LCE Launcher is a custom launcher for Minecraft Legacy Console Edition preservation and community builds. It focuses on fast instance management, clean updates, and a cozy nostalgic UI.

<img width="1277" height="717" alt="LCE Launcher" src="https://github.com/user-attachments/assets/eaa9bae6-3b3b-4e39-a3c1-156e34abf3cc" />

## Features

- Minecraft-inspired UI with modern polish
- Instance management for multiple installs
- GitHub release fetching for game builds
- Custom servers list management
- Profile with username + playtime tracking
- Announcements and patch notes view
- Background video and music controls
- Auto-update support for packaged builds (GitHub Releases)

## Getting Started

### From Source
1. Clone or download this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the launcher:
   ```bash
   npm start
   ```

## Building

### Windows (NSIS)
```bash
npm run dist:win
```

### Linux (AppImage)
```bash
npm run dist
```

### Linux (Flatpak)
```bash
npm run dist:flatpak
```

### macOS (DMG)
```bash
npm run dist:mac
```

## Configuration

### Repository Source
By default, the launcher fetches releases from `smartcmd/MinecraftConsoles`. You can change this in the Settings menu.

### Launch Options
- GitHub repository for game releases
- Executable name (default: `Minecraft.Client.exe`)
- Compatibility layer (Linux) for running Windows builds
- Optional server IP/port

### Profile
- Username (stored locally)
- Playtime tracking

## Auto-Updates (Packaged Builds)

Packaged builds can auto-update via GitHub Releases when configured. During launch, the app checks for new releases, downloads updates, and installs automatically.

## Credits

- **Jaruwyd / nt8j** — Launcher Creator  
  https://github.com/Jaruwyd
- **smartcmd** — Legacy (Nightly) Build Version  
  https://github.com/smartcmd/MinecraftConsoles

## Help & Links

If you need any help in-game, join the Minecraft Consoles Discord server:  
https://discord.gg/minecraftconsoles

## License

ISC
