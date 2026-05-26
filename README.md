# Sync-Player

A FULLY synchronized non-coder friendly HTML5 video player originally for Minecraft's WebDisplays mod using Node.js and Socket.IO. This project allows all players to view the same video in perfect sync including play, pause, and seek actions and more across connected clients.

> Frequently Asked Questions: [FAQ](FAQ.md)

### [Read Hosting Methods Here!!](https://github.com/Lakunake/Sync-Player/blob/main/DOCS/Hosting%20Methods.md)

---
## Table of Contents

* [Requirements](#requirements)
* [Features](#features)
* [Controls](#controls)
    * [Client Controls](#client-controls-touchclick-interface)
    * [Admin Controls](#admin-controls-web-interface)
* [Firewall Warning](#firewall-warning)
* [File Structure](#-file-structure)
* [Configuration](#️-configuration)
* [License](#license)
* [Credits](#-credits)

---

## Requirements
> these are auto-installed with console.ps1/run.bat so you don't have it install it yourself

* [Node.js](https://nodejs.org/) installed on your machine (v20.6.0+ required for config to work)
* [Docker](https://www.docker.com/) installed on your machine if you're using Docker Compose Method
* Follow of the [Hosting Methods](https://github.com/Lakunake/Sync-Player/blob/main/DOCS/Hosting%20Methods.md)
* Media files placed in the `/media/` folder (supports MP3, MP4, .MKV, .AVI, .MOV, .WMV, .WEBM, .PNG, .JPG, .WEBP, embeds and more)
 
---

## Features

* Multi-format streaming mentioned above
* High Quality streaming with FFmpeg optimization
* Both Side Local Syncronized Stream ([BSL-S²](https://github.com/Lakunake/Minecraft-WebDisplays-Sync-Player/issues/35))
* Playlist support with sequential playback
* Admin control panel for remote management
* Real-time playback synchronization using Socket.IO
* Lightweight Node.js + Express server (excluding media tooling)
* Custom video control zones  designed for the WebDisplays mod thats still usable in normal web browsers(click-based)
* Automatic video preloading for smooth transitions
* Dynamic Audio/Subtitle track changing supporting .ass([jassub](https://www.npmjs.com/package/jassub) and [wsr](https://www.npmjs.com/package/web-subtitle-renderer)) and .vtt(wsr), you can extract subs directly from admin panel
* Minimal UI in view mode
* Modernized UI with Glassmorphism in admin panel
* Tab to use ffmpeg's provided tools without needing much knowledge of using CLI
* HTTP/HTTPS switch
* Improved safety in multiple measures [ⓘ](https://github.com/Lakunake/Minecraft-WebDisplays-Sync-Player/releases/tag/1.9.2) + [Helmet](https://www.npmjs.com/package/helmet) for safer Direct Hosting experience
* [Join Behaviors](https://github.com/Lakunake/Minecraft-WebDisplays-Sync-Player/releases/tag/goonen); Sync, and Reset
* Client Remembering
* Machine fingerprint based locking
* Server mode if you want to do simultaneous watch parties
* A toggleable chat with proper escaping
* A different look of the admin panel for mobile
* Very easily configureable experience

---

## Controls

### Client Controls (Touch/Click Interface):
| Zone                                   | Action                   | Sync Behavior |
| -------------------------------------- | ------------------------ | ------------- |
| **Left Edge (≤ 87px)**                 | ⏪ Rewind 5 seconds       | ✅ Synced      |
| **Right Edge (≥ screen width − 87px)** | ⏩ Skip forward 5 seconds | ✅ Synced      |
| **Center (±75px from center)**         | ▶️ Toggle Play / Pause   | ✅ Synced      |
| **Between Left Edge and Center**       | 🔉 Decrease volume (5%)  | ❌ Local only  |
| **Between Center and Right Edge**      | 🔊 Increase volume (5%)  | ❌ Local only  |

There are also 2 chat commands called /fullscreen and /rename, they work as the name implies

![Controls](https://cdn.modrinth.com/data/N3CzASyr/images/dee2ac0695a18044f60e62bf75c5d3a94de57bd6.png "Visualised Controls (<3 comic sans)")
> Of course use Left Click if you're not in minecraft while using this

### Admin Controls (Web Interface):
- Playlist creation and management
- Remote play/pause/skip/seek controls to eliminate desync
- Main video selection with custom start time
- File browser for media management
- FFmpeg generated thumbnail for video from the first third of the video
- Tab to use various ffmpeg tools
<img width="1919" height="943" alt="image" src="https://github.com/user-attachments/assets/2821e24d-b946-456b-bda7-30e540e0ba02" />
<img width="1919" height="943" alt="image" src="https://github.com/user-attachments/assets/8b1eab02-70e3-4156-9594-059cf3ce46d7" />
<img width="1866" height="918" alt="image" src="https://github.com/user-attachments/assets/f69bce7e-78a0-4be0-9c78-c43e018275df" />


> [!NOTE]
>  All users will see the same video with the same attributes except for **volume**, which is controlled individually per client.

---

## Firewall Warning

By default, the `console.ps1` script will automatically:
1.  Check if a Windows Firewall rule exists for your configured `PORT` (default 3000).
2.  If missing, it will restart the script as Administrator to add the rule.

To **disable** this behavior (e.g., if you manage firewall rules manually), add the following to your `config.env`:

```properties
SYNC_SKIP_FIREWALL_CHECK=true
```

---

## 📁 File Structure

```
/media/                # Folder containing media files
/memory/               # Folder containing fingerprints, logs, etc.
/res/                  # Folder containing the app’s runtime files, server, web pages, dependencies, and launch/helper scripts.
/cert/                 # Folder containing the SSL generation scripts for HTTPS, the generated SSLs are also stored there.
/res/lib/              # Folder containing the modular Node.js backend components (config, security, memory, etc.)
server.js              # Node.js backend entrypoint
index.html             # Client video player interface
admin.html             # Admin control panel
landing.html           # Page to join rooms, exclusive to server mode
package.json           # Node.js dependencies, scripts and other metadata
launcher.vbs           # Small script that re-opens the server in Terminal if opened in CMD
console.ps1            # Script that verifies dependencies, initializes settings, and keeps the server running with error recovery.
run.bat                # Windows startup script
start.sh               # Linux startup script
config.env             # Configuration file, this is plain text (port, settings, etc.)
legacylauncher.bat     # Old startup script that is not updated but reliable, written in batch
postinstall.js         # Fixes, bundling and whatnot after npm install
generate-ssl.bat/sh    # Generates ssl for https usage, may give not trusted warn since this is self signed
subtitles.js           # wsr code
```

---

## ⚙️ Configuration

Edit `config.env` to customize:

```ini
SYNC_PORT=3000                     # Server port (1024-49151)
SYNC_VOLUME_STEP=5                 # Volume adjustment percentage
SYNC_SKIP_SECONDS=5                # Skip duration in seconds
SYNC_JOIN_MODE=sync                # Decides what happens when a new user joins the watch party
SYNC_USE_HTTPS=true                # Whether you want to use HTTPS or not, but you also need cert and key files
SYNC_BSL_MODE=any                  # Changing requirements of BSL-S² to if all clients should have file or not
SYNC_VIDEO_AUTOPLAY=false          # Auto-play videos when loaded
SYNC_ADMIN_FINGERPRINT_LOCK=false  # Generates a fingerprint from first machine to access /admin to not let others reach it
SYNC_BSL_ADVANCED_MATCH=true       # Whether or not BSL-S² should use Advanced match to check if 2 given videos are the same
SYNC_BSL_MATCH_THRESHOLD=1         # How many criterias should advanced match check
SYNC_SKIP_INTRO_SECONDS=87         # How many seconds the "Skip Intro" button jumps forward
SYNC_CLIENT_CONTROLS_DISABLED=false# If controls of clients should be disabled
SYNC_CLIENT_SYNC_DISABLED=false    # If clients should keep control of their own video but should not send those controls to server
SYNC_CHAT_ENABLED=true             # Yeah
SYNC_DATA_HYDRATION=true           # When enabled, the server injects initial data into admin.html to save a round-trip
SYNC_MAX_VOLUME=400                # How much should clients be able to crank the volume up to
SYNC_SUBTITLE_RENDERER=jassub      # Which subtitle renderer should be used to render .ass subtitles
SYNC_FFMPEG_DISABLE_BAN=false      # When tools password is typed incorrectly, honeypots until next refresh instead of banning
SYNC_FFMPEG_DISABLE_CONSEQUENCES=false # Whether honeypotting and banning an admin should happen after a failed login
SYNC_FFMPEG_TOOLS_PASSWORD=        # The password to ffmpeg tools tab, is encrypted with SHA-256 onto RAM
SYNC_PLAYER_KEY=                   # Encryption key, is optional and disabled by default
SYNC_SUBTITLE_FIT=bottom           # Stretch = Canvas fills screen/Bottom = Same video aspect ratio but pinned to bottom
SYNC_SHOW_SSL_TIP=false            # Whether or not to show a tip that says there are SSL generation scripts in /cert
SYNC_SKIP_FIREWALL_CHECK=false     # See firewall warning above
```

---

## Legal

### License

**Short name**: `AGPL-3.0-or-later`
**URL**: [gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html)

This project is licensed under **AGPLv3**:

*  Free to use and modify
*  Must credit the original creator (**Lakunake**)
*  Must share any changes with the same license **if distributed or hosted publicly**

See [LICENSE](LICENSE) for more details.

### Legal Documents

See [Documents Folder](DOCS) for [Privacy Policy](DOCS/PrivacyPolicy.md) and [Terms of Service](DOCS/TERMS_OF_SERVICE.md)

---

## 🙏 Credits

Created by **Lakunake**
Built using Node.js and many [node modules](res/package.json)

Contact: johnwebdisplay@gmail.com        (Obviously not my real name)
