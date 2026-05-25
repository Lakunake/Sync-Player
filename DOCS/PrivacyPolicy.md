# Privacy Policy — Sync-Player

**Last updated:** May 2025
**Software version:** Sync-Player (AGPLv3)
**GitHub:** <https://github.com/Lakunake/Sync-Player>

---

## 1. Who Is Responsible for Your Data?

Sync-Player is **self-hosted, open-source software**. This means the person or organisation who downloaded and is running the server — referred to throughout this policy as **"the host"** or **"the operator"** — is the **data controller** for your data.

The developer of Sync-Player, **Lakunake** (`johnwebdisplay@gmail.com`), has no access to any data collected by any instance of this software. Lakunake cannot see, retrieve, or delete data on any server that runs Sync-Player.

If you have a privacy concern about a specific Sync-Player server, you need to contact **the person or organisation hosting that server**.

---

## 2. What Data Is Collected and Why

Sync-Player collects a minimal set of data to function correctly. Here is a plain-English breakdown.

### Display Names (User-Chosen)

When you join a session, you may be given or choose a display name (e.g., a username visible to others in the room). This name is:

- **Shown to all other connected viewers** in real time.
- **Saved on the server** so it persists across reconnections.
- Changeable at any time using the `/rename` command in chat.

**Purpose:** Identify viewers in the session and provide a consistent identity across reconnections.

### Admin Machine Fingerprint (Optional Feature)

If the host has enabled admin access control, the admin's browser generates a **fingerprint** used to verify their identity on future visits. There are two methods depending on how the server is configured:

- **Multi-room (server) mode:** A random identifier is generated once and stored in your browser's **`localStorage`**. It contains no personal or hardware information — it is simply a random token tied to the server's origin (URL + port).

- **Single-room (legacy) mode:** A fingerprint is derived from browser and device characteristics, including: your browser's user agent string, language setting, reported platform, number of CPU cores, approximate device memory, screen resolution, colour depth, timezone offset, and a canvas rendering test. These are combined and hashed into a fixed identifier, which is also stored in your browser's **`localStorage`**.

In both cases the fingerprint is:

- **Encrypted** before being saved on the server.
- Used **only** to verify the admin's identity — it is never shared or used for any other purpose.
- Only stored for the admin. Regular viewers do not have fingerprints stored on the server.

**Purpose:** Admin authentication and access control. This only applies if the host has turned on the fingerprint lock feature.

### IP Addresses (Security / Rate Limiting)

Your IP address is read from your connection for **rate limiting** (preventing abuse) and **security checks**. Under normal circumstances, raw IP addresses are **not written to disk**.

The exception is the **FFmpeg Tools security system**: if an incorrect password is entered for the admin's video-processing tools, the server records your IP address and browser identifier for the host's manual security review. This mechanism can be disabled by the host entirely.

IP addresses also appear in the **server's console output** (e.g., rate-limit alerts), but this output is managed by the host's operating system and is not retained as a file by Sync-Player itself.

**Purpose:** Protecting privileged admin tools from unauthorised access; rate limiting.

### Room and Session Logs

When server mode (multi-room watch parties) is active, Sync-Player keeps activity logs on the server:

- **General log**: Records when rooms are created or deleted. Contains room codes and names — no personal user data.
- **Per-room log**: Records client join, leave, and disconnect events, including the user's chosen display name and whether they were the admin. These logs are capped and roll over automatically.

**Purpose:** Operational logging for the host to monitor server activity.

### Chat Messages

If the host has enabled the chat feature, messages you send are **broadcast in real time** to all connected viewers. Chat messages are:

- **Never written to disk** — they exist only in memory while you are connected.
- Sanitised server-side to prevent script injection attacks.

**Purpose:** Real-time communication between viewers.

### Session Cookie

Sync-Player sets a single cookie in your browser. It contains a random token with **no personal information** in it. It is used purely for **CSRF protection** — a standard security mechanism that ensures admin actions originate from the legitimate admin browser and not from a malicious third-party page.

| Cookie         | Content                          | Expiry   | Flags                          |
| -------------- | -------------------------------- | -------- | ------------------------------ |
| `sync_session` | Random session ID (not personal) | 24 hours | `httpOnly`, `sameSite: strict` |

There are **no tracking cookies, advertising cookies, or third-party cookies** of any kind.

**Purpose:** CSRF protection for admin operations.

### Functional Data (Held in Memory Only)

The following data is held in memory only while the server is running and is **never written to disk**:

- **Video and playback state**: Current video, playback time, audio/subtitle track, playback rate — used to keep all viewers in sync.
- **Sync status**: Playback drift values between clients — purely functional.

---

## 3. Who Can See Your Data?

- **The host/operator** has access to all data stored on their server, including display names, any ban records, and session logs.
- **Other viewers** can see your display name and chat messages during a live session.
- **No one else.** Lakunake (the developer) has zero access. There are no third-party analytics services, advertising networks, or telemetry systems built into the software.

### A Note on Embedded External Content

If the host adds external URLs (such as YouTube videos) to the playlist, those services are loaded in your browser directly and their own privacy policies apply. Sync-Player itself does not relay your data to these services — your browser connects to them directly as it would if you visited them normally.

---

## 4. How Long Is Data Kept?

| Data                        | Retention                                        |
| --------------------------- | ------------------------------------------------ |
| Display names               | Indefinitely, until manually deleted by the host |
| Admin fingerprint           | Indefinitely, until the host resets it           |
| Ban records (hashed)        | Indefinitely; no automatic expiry                |
| IP address security log     | Indefinitely; no automatic expiry                |
| Per-room activity logs      | Rolling cap; deleted when the room is deleted    |
| General activity log        | Rolling cap                                      |
| Session cookie / CSRF token | 24-hour expiry; never written to disk            |
| Chat messages               | Never stored; only exist during live broadcast   |

---

## 5. Your Rights

Because Sync-Player is self-hosted software with no central service, the way to exercise your privacy rights is to **contact the operator of the server you are using**.

You may ask the host to:

- **Delete your display name** from their server.
- **Delete any ban or security records** associated with your IP address.
- Provide information about what data they hold relating to you.

Depending on where you and the host are located, you may have additional rights under applicable law (such as GDPR in the EU/UK, or CCPA in California). The host, as data controller, is responsible for complying with those obligations.

---

## 6. Security

Sync-Player includes several technical measures to protect the data it handles:

- **AES-256-GCM encryption** for the admin fingerprint stored on disk.
- **HTTP security headers** (Content Security Policy, HSTS when HTTPS is enabled, etc.) via the Helmet.js library.
- **CSRF token protection** on all admin operations.
- **Rate limiting** on both HTTP endpoints and real-time socket events.
- **Input validation and path traversal prevention** on all file-related operations.
- **Honeypot security system** on the admin video-processing tools endpoint.
- **Optional HTTPS** via self-signed certificates or Tailscale.

No security system is perfect. Ultimately, the security of your data also depends on how the host configures and maintains their server.

---

## 7. Children

Sync-Player does not include any age verification mechanism. The host is responsible for ensuring their server is used appropriately and in compliance with laws regarding minors (such as COPPA in the United States or similar regulations in other jurisdictions).

---

## 8. Changes to This Policy

If the host modifies this privacy policy, they should update the "Last updated" date at the top and communicate changes to their users as appropriate. Changes to the Sync-Player software may also affect what data is collected; the host should review the upstream documentation when updating the software.

---

## 9. Contact

**For questions about data held on a specific Sync-Player server:**
Contact the person or organisation operating that server. They control all data on their instance.

**For developer-level questions about Sync-Player's code and data practices:**
Contact Lakunake at `johnwebdisplay@gmail.com`. Note that the developer has no access to data on any deployed instance.
