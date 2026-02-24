# Sync-Player

A FULLY synchronized non-coder friendly HTML5 video player originally for Minecraft's WebDisplays mod using Node.js and Socket.IO. This project allows all players to view the same video in perfect sync including play, pause, and seek actions and more across connected clients.

> Frequently Asked Questions: [FAQ](FAQ.md)

---
## Table of Contents

* [Requirements](#requirements)
* [Features](#features)
* [Controls](#controls)
    * [Client Controls](#client-controls-touchclick-interface)
    * [Admin Controls](#admin-controls-web-interface)
* [Hosting Tutorials](#hosting-tutorials)
    * [Method 1: Direct Hosting](#method-1-lan-or-public-ip-direct-hosting)
    * [Method 2: Tailscale](#method-2-tailscale-virtual-lan)
    * [Method 3: Cloud Hosting](#method-3-cloud-hosting-render-heroku-replit-etc)
* [Firewall Warning](#firewall-warning)
* [File Structure](#-file-structure)
* [Configuration](#️-configuration)
* [License](#license)
* [Credits](#-credits)

---

## Requirements
> these are auto-installed with console.ps1/run.bat so you don't have it install it yourself

* [Node.js](https://nodejs.org/) installed on your machine (v20.6.0+ required for config to work)
* [ffmpeg](https://ffmpeg.org/) installed for high bitrate support and video optimization (via [node-av](https://github.com/seydx/node-av))
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
<img width="1919" height="909" alt="image" src="https://github.com/user-attachments/assets/16706deb-cc7f-4ea4-8830-1dc88f141eeb" />
<img width="1919" height="909" alt="image" src="https://github.com/user-attachments/assets/26cda4d9-69e0-4441-a218-e0e05c085b0e" />
<img width="1832" height="933" alt="image" src="https://github.com/user-attachments/assets/359ef7b1-b0c7-40d4-a734-fd16cd6c78e5" />

> [!NOTE]
>  All users will see the same video at the same time except for **volume**, which is controlled individually per client.

---

## Hosting Tutorials

> [!NOTE]
> Ensure [Node.js](https://nodejs.org/) is installed before proceeding.
> Run "npm install" at cmd in case of the auto install failing.

### Method 1: LAN or Public IP (Direct Hosting),
> Best for Many people and Repeated users, complex-ish setup

> [!NOTE]
> Though many security features are implemented, direct hosting can still be risky for attacks

1. Make sure your selected port is open in your firewall/router
2. Run `run.bat` in your folder
3. Access the video player from devices at the provided links
4. Access admin panel at `http://your-ip:port/admin` and go to `http://your-ip:port` in minecraft

### Method 2: Tailscale (Virtual LAN) 
> Basic to setup. *Safest way to do it as in cybersecurity.* Takes a bit longer than method one to do a subsequent start. Also gives trusted SSLs for HTTPS

1. Download and install [Tailscale](https://tailscale.com/download) on everybody's computers
2. Invite your friends to your [Tailnet](https://tailscale.com/kb/1136/tailnet)
3. Run `run.bat`, then visit the provided network link
> [!IMPORTANT]  
> Beware, Tailscale only allows 3 emails per [Tailnet](https://tailscale.com/kb/1136/tailnet), but it allows a 100 devices to be connected at the same time, so it would be best if you created a new email for your friends to log into tailscale to just for this

### Method 3: Cloud Hosting (Render, Heroku, Replit, etc.)
> Safe-ish..? Though hard to set up and do subsequent starts.

1. Fork the repository: [https://github.com/Lakunake/Minecraft-WebDisplays-Sync-Player](https://github.com/Lakunake/Minecraft-WebDisplays-Video-Player)
2. Connect your repository to your hosting service
3. Set build command: `npm install`
4. Set start command: `node --env-file-if-exists=../config.env server.js`
5. Set root folder to: `./res/`
6. Deploy and access your video player via the provided URL
> [!WARNING]
> Not recommended due to the free plan limitations of websites

> Congratulations if you managed to deploy it successfully using Cloud Hosting...
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
server.js              # Node.js backend
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
port: [1024-49151]            # Server port
volume_step: [1-20]           # Volume adjustment percentage
skip_seconds: [5-60]          # Skip duration in seconds
join_mode: sync/reset         # Decides what happens when a new user joins the watch party (more info in actual config)
HTTPS: t/f                    # Whether you want to use https or not, but you also need cert and key files
bsl_s2_mode: any/all          # Changing requirements of BSL-S² to if all clients should have file or not
video_autoplay: t/f           # Explains itself
admin_fingerprint_lock: t/f   # Generates a fingerprint from to first machine to access /admin to not let others reach it (t/f)
bsl_advanced_match: t/f       # Whether or not if BSL-S² should use Advanced match to check if 2 given videos are the same
...threshold: [1-4]           # How many criterias should advanced match check
skip_intro_seconds:           # How many seconds the "Skip Intro" button jumps forward
controls_disabled: t/f        # If controls of clients should be disabled
sync_disabled: t/f            # If clients should keep control of their own video but should not send those controls to server and get overridden by server
chat_enabled: t/f             # Yeah
data_hydration: t/f           # When enabled, the server injects initial data into admin.html to save a round-trip, improves overall performance
max_volume: [100-1000]        # How much should clients be able to crank the volume up to
subtitle_renderer: wsr/jassub # Which subtitle renderer should be used to render .ass subtitles, wsr is generally more compatible than jassub
```

---

## License

**Short name**: `AGPL-3.0-or-later`
**URL**: [gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html)

This project is licensed under **AGPLv3**:

*  Free to use and modify
*  Must credit the original creator (**Lakunake**)
*  Must share any changes with the same license **if distributed or hosted publicly**

See [LICENSE](LICENSE) for more details.

---

## 🙏 Credits

Created by **Lakunake**
Built using Node.js and many [node modules](res/package.json)

Contact: johnwebdisplay@gmail.com        (Obviously not my real name)
