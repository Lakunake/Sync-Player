# Frequently Asked Questions (FAQ)

## Installation & Setup

**How do I install the required dependencies?**

If the console says "Node.js is not installed" or you need to update:
1.  Open PowerShell or Command Prompt as Administrator.
2.  Run: `winget install --id OpenJS.NodeJS.LTS -e`
3.  Restart your terminal.
4.  Navigate to the folder where you downloaded Sync-Player.
5.  Run the startup script: `.\res\console.ps1` (or `run.bat`).
    *   It will automatically install any missing dependencies like `express` or `socket.io`.

---

## Connection & Networking

**How do I use Tailscale?**

Tailscale allows you to host a session without port forwarding.
1.  **Install Tailscale** on both the host (you) and the client (the person watching).
2.  **Login** to the same Tailscale network (or share your machine with them).
3.  Run a generate ssl script with Tailscale option selected and then run a startup script.
4.  If active, you will see a **Tailscale URL** (e.g., `https://machine.tailnet.ts.net:3000`).
5.  Share this URL with your friends!

**"Site cannot be reached" / DNS Issues**

If the Tailscale URL doesn't work (but the IP does):
1.  **Disable "Use Secure DNS"** in your browser settings (Chrome/Edge/Firefox).
    *   Browsers often bypass local DNS resolution (which Tailscale needs).
2.  **Check MagicDNS**: Ensure it's enabled in your [Tailscale Admin Console](https://login.tailscale.com/admin/dns).
3.  **Check HTTPS setting on Tailscale**: Ensure it's set to "Auto" or "Off" in your [Tailscale Admin Console](https://login.tailscale.com/admin/dns).   
4.  **Flush DNS**: Run `ipconfig /flushdns` in a terminal.

**My router doesn't support NAT loopback (I can't see my own stream)** (@xdcoelite)

If you can't connect to your own public IP/domain locally:
1.  Run `.\res\console.ps1` as **Administrator**.
2.  It will attempt to automatically patch your `hosts` file to resolve the domain to your local IP.
3.  **Manual Fix**:
    *   Go to `C:\Windows\System32\drivers\etc`.
    *   Open `hosts` as Admin.
    *   Add: `192.168.x.x yourdomain.ddns.net` (Replace with your local IP).

---

## HTTPS & Certificates

**I get a "Not Secure" warning in my browser / White screen in Minecraft**

This happens because the default SSL certificate is **self-signed**.
*   **Fix for Browser**: Click "Advanced" > "Proceed to..." (or type `thisisunsafe` in Chrome if there's no button).
*   **Fix for Minecraft (WebDisplays)**:
    *   The in-game browser (CEF) strictly blocks invalid certs.
    *   **Solution 1 (Recommended)**: Use **Tailscale**. It provides valid, trusted certificates automatically.
    *   **Solution 2**: Add the `.pem/.crt(you can rename them vice versa)` to your computer's "Trusted Root Certification Authorities" store (little advanced).

---

## Playback & Codecs

**My video doesn't load / I can hear audio but see no video**

This is usually a **Codec Issue**.
*   **The Problem**: Web browsers (Chrome, Edge, MCF) **cannot play** H.265 (HEVC) or MKV files natively.
*   **The Solutions**:
    1.  **Use BSL-S² (Recommended)**: This feature syncs a file playing locally on your PC (VLC/MPV) with the room. It supports **any** format.
    2.  **Re-encode**: Use HandBrake to convert the video to **H.264 (AVC) MP4**.
    3.  **Hardware Acceleration**: In rare cases, enabling it in `chrome://settings/system` might help if your GPU supports it.

**Subtitle/Audio track changing does not work**

1.  Use the **FFmpeg Tools** in the Admin Panel to extract/convert tracks.
2.  The server uses `node-av` to process these quickly, but the browser needs them in a specific format (VTT for subs, AAC/MP3 for audio).

---

## Usage

**How do I update the software?**

1.  Download the latest version.
2.  Extract the files **over** your existing folder (replace all).
3.  Run `.\res\console.ps1`.
    *   It will automatically check for new dependencies and install them.
    *   Your `config.env` and `memory/` (database) are safe and won't be overwritten if you kept them outside or backed them up.

**How do I use the Admin Panel?**

1.  Open the **Admin Panel URL** (shown in `console.ps1`) on your **real browser** (Chrome/Edge on your second monitor or phone).
2.  Use it as a **remote control** for the in-game player.
3.  You can change videos, seek, pause, and manage the playlist from there. This ensures proper sync for everyone.

**What's a "Main" video?**

"Main" videos are prioritized for preloading. If you have a playlist, marking a large movie as "Main" ensures it buffers while you watch the intros or shorter clips.

**Can I use this outside of Minecraft?**

Yes! It works in any modern web browser. While designed for the WebDisplays mod, you can use it to sync videos with friends in Chrome/Edge/Firefox just as easily.

---

## Other

**Does this software collect data?**

**No.** Your files, logs, and playback history stay on your machine. No data is sent to us or any third party.

---

*Still have questions? Visit [GitHub Discussions](https://github.com/Lakunake/Minecraft-WebDisplays-Video-Player/discussions) or contact the support email.*
