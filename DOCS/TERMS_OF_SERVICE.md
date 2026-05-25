# Terms of Service — Sync-Player

**Last updated: May 2026**

---

## 1. Overview

Sync-Player is an open-source, self-hosted HTML5 media synchronization server built with Node.js, Express, and Socket.IO. It is developed and maintained by Lakunake (`johnwebdisplay@gmail.com`) and is licensed under the [GNU Affero General Public License v3.0 (AGPLv3)](https://www.gnu.org/licenses/agpl-3.0.html).

These Terms of Service ("Terms") explain your rights and responsibilities when using Sync-Player — either as someone who deploys and runs it (an **Operator**), or as someone who connects to a running instance to watch media (a **User** or **Viewer**).

Please read these Terms carefully before using or deploying Sync-Player.

---

## 2. There Is No Central Sync-Player Service

This is the most important thing to understand about Sync-Player:

> **Lakunake does not host, operate, or run any instance of Sync-Player.**

Sync-Player is downloaded from [GitHub](https://github.com/Lakunake/Sync-Player) and run entirely on infrastructure chosen and controlled by the Operator. Lakunake has no access to, no visibility into, and no control over any running instance of Sync-Player — including any media, users, chat messages, or data on that instance.

When you connect to a Sync-Player instance as a Viewer, **you are interacting with the Operator of that instance, not with Lakunake.** Any questions, complaints, or concerns about a specific instance must be directed to that instance's Operator.

---

## 3. Who These Terms Apply To

These Terms address two distinct parties.

**Operators** are individuals or organisations who have downloaded Sync-Player and are running their own instance on their own hardware or hosting. Operators are solely responsible for their deployment, including all content, users, and legal compliance.

**Users (Viewers)** are people who connect to an Operator's instance via a web browser to watch synced media.

These Terms apply to both parties. If you are an Operator, you accept the additional responsibilities described in Section 6.

---

## 4. Software License

Sync-Player is free, open-source software licensed under the **AGPLv3**. Under this license, you are free to use, modify, and redistribute the software, subject to one key condition: if you publicly deploy a modified version of Sync-Player, you must make your modifications available under the same AGPLv3 license.

The full license text is available at: https://www.gnu.org/licenses/agpl-3.0.html

These Terms of Service govern your use of Sync-Player as a software product. The AGPLv3 governs the source code itself. Together, these two documents represent the complete terms applicable to Sync-Player. In the event of any conflict between these Terms and the AGPLv3 with respect to software licensing, the AGPLv3 prevails.

---

## 5. Acceptable Use

By using Sync-Player — whether as an Operator or a User — you agree that you will not use it to:

- Infringe on the intellectual property rights of others, including copyright, trademarks, or trade secrets.
- Stream, host, or share content that is illegal in your jurisdiction or the jurisdiction of your users.
- Harass, threaten, or harm other users.
- Engage in any activity that violates applicable local, national, or international law.

Sync-Player includes a feature called BSL-S² (Both-Side Local Synchronized Stream), which allows a viewer to play a media file stored on their own device in sync with the server, rather than streaming it from the Operator's server. When using this feature, each party — the Operator and the User — remains individually responsible for ensuring they hold the appropriate rights to any media they play locally.

---

## 6. Operator Responsibilities

If you are an Operator, you take on full legal and ethical responsibility for your instance. Specifically, you are solely responsible for:

**Legal compliance.** Your deployment must comply with all applicable laws, including data protection laws (such as GDPR, CCPA, or equivalent), copyright law, and any sector-specific regulations relevant to your use case.

**Content.** All media you host locally or stream via external URLs must be either owned by you or licensed for the use you intend. You must not use Sync-Player to stream or share content in violation of copyright or other intellectual property law. Lakunake is not responsible for any content hosted on your instance and has no ability to remove it.

**Data protection.** As the operator of a self-hosted server, you are the **data controller** for any personal data processed by your instance (such as display names, IP addresses, admin credentials, or session logs). You are responsible for providing your users with appropriate privacy notices and for complying with applicable data protection law. Lakunake is not a data processor for your instance.

**User safety and moderation.** You are responsible for moderating your instance's content and user activity. Sync-Player has no built-in age verification. If your instance may be accessed by minors, you are responsible for ensuring compliance with applicable child protection laws, including COPPA in the USA and Article 8 of the GDPR in the EU.

**Security.** You are responsible for the security of your server infrastructure, including keeping Sync-Player and its dependencies up to date, configuring HTTPS where appropriate, and protecting the admin panel from unauthorised access.

---

## 7. Copyright and Intellectual Property

Sync-Player provides tools that make it easy to play local media files or stream content from external URLs (including YouTube, Twitch, Vimeo, Dailymotion, SoundCloud, and direct media links). **Operators and Users are solely responsible for ensuring they have the legal right to stream or share any content they use with Sync-Player.**

Copyright infringement notices relating to content on a specific Sync-Player instance must be directed to **the Operator of that instance** — not to Lakunake. Lakunake has no technical ability to access, modify, or remove content on any third-party-hosted instance and therefore cannot respond to DMCA takedown notices or equivalent copyright claims relating to content hosted by others.

If you are a third party seeking to contact the Operator of a specific instance, please consult that server's own documentation, landing page, or any contact information made available by the Operator. Lakunake cannot identify or act as an intermediary for operators of independent deployments.

---

## 8. Third-Party Services

Sync-Player's viewer can load and play content from third-party platforms. When this happens, your browser connects directly to that platform — for example, YouTube's servers, Twitch's servers, or another external host. Those platforms have their own terms of service and privacy policies, which apply to your use of their content. Lakunake has no control over those platforms and is not responsible for their content, practices, or availability.

---

## 9. Data and Privacy

Sync-Player collects a minimal amount of data as described in the [Privacy Policy](https://github.com/Lakunake/Sync-Player/blob/main/DOCS/PrivacyPolicy.md). In summary:

- **Display names** may be stored on the Operator's server.
- **Admin fingerprint:** an encrypted identifier used to authenticate the admin, always stored on disk by the Operator's instance.
- **IP addresses** are held in memory for rate limiting and may be written to disk only in the event of a failed admin authentication attempt.
- **Session logs** (room creation, deletion, and user join/leave events, in server mode only) are stored on disk.
- **Chat messages** are never written to disk.
- A single strictly-necessary security cookie (`sync_session`) is used for CSRF protection.
- No tracking cookies, advertising cookies, or third-party analytics are included in the software.

Lakunake has no access to any of this data. All data is held on the Operator's server and is subject to the Operator's own privacy practices.

---

## 10. No Warranty

Sync-Player is provided **"as is,"** without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement.

Lakunake does not warrant that Sync-Player will be free of bugs, secure, or uninterrupted. You use Sync-Player at your own risk.

---

## 11. Limitation of Liability

To the fullest extent permitted by applicable law, Lakunake shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising out of or in connection with your use of Sync-Player — including, without limitation, damages resulting from:

- Content hosted or streamed on any Operator's instance.
- Actions taken by any Operator or User.
- Loss of data, revenue, or goodwill.
- Bugs, downtime, or security vulnerabilities in the software.

This limitation applies regardless of the legal theory under which a claim is brought, and even if Lakunake has been advised of the possibility of such damages. Nothing in these Terms limits liability that cannot be excluded by law.

---

## 12. Indemnification

Operators agree to indemnify and hold harmless Lakunake from and against any claims, damages, losses, or costs (including reasonable legal fees) arising out of or relating to their deployment of Sync-Player, content hosted or streamed on their instance, their failure to comply with applicable law, or claims brought by their Users or affected third parties.

---

## 13. Severability

If any provision of these Terms is found to be unenforceable or invalid under applicable law, that provision will be modified to the minimum extent necessary to make it enforceable, or severed if modification is not possible. The remaining provisions of these Terms will continue in full force and effect.

---

## 14. Changes to These Terms

Lakunake may update these Terms from time to time. Updated Terms will be published in the Sync-Player GitHub repository with a revised "Last updated" date. Continued use of Sync-Player after an update constitutes acceptance of the revised Terms.

---

## 15. Governing Law

These Terms are governed by the laws of the jurisdiction in which Lakunake resides, without regard to conflict-of-law principles. In the event of a dispute, the parties agree to first attempt to resolve the matter informally before pursuing formal proceedings.

---

## 16. Contact

For questions about these Terms or the Sync-Player software itself, you may contact the developer at:

**Lakunake** — `johnwebdisplay@gmail.com`

**Please note:** Lakunake has no access to any running instance of Sync-Player and cannot assist with content-related issues, user disputes, DMCA notices, or data requests relating to a third-party-hosted server. For such matters, please contact the Operator of the relevant instance directly.
