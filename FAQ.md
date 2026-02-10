**It says that im lacking...**

Open Command Prompt(CMD), and write these commands in order or whichever ones you need

```cmd
winget install ffmpeg
winget install --id OpenJS.NodeJS.LTS -e
md(or cd in some cases) (Your path to the code)
npm install
```

**I get a white screen in minecraft and get a non trusted message on chrome with https on**

If you're just gonna use chrome, you can just skip that page with the button to the bottom right of the page.

If you're gonna use it with minecraft, follow this tut:

>WILL UPDATE LATER

**Subtitle/Audio track changing does not work**

Extract Audio/Subtitle tracks and relaunch playlist through ffmpeg tools
Enable #enable-experimental-web-platform-features through Chrome Flags(chrome://flags/) or your browser's config/flags

**My friend can't see the hevc video im sharing and can only hear it**

Thats most likely a hardware related issue, but it could be solved by doing one of these(if not you have almost no way of)

- Check [chrome://gpu/](chrome://gpu/) if it says anything about hevce being true, Install HEVC extensions from windows store and Turn on BSL-S²
- If no, re-encode the video in H.264 or any chromium supported codec through either Handbrake or FFmpeg
- Use BSL-S2
  

**How do I properly use the admin panel?**

Open the admin panel on your default browser, chrome or safari for example, then launch your playlist, after you can freely watch the videos you want while using the admin panel through your default browser like a remote that overrides the other ones to ensure sync

**What's a "main" video?**  

Main videos are typically large or high-quality files that may take longer to load. Selecting one as the “main” video lets the player preload it in the background while smaller, faster videos are playing.

**My video doesn't load. What do I do?** 
 
Check if your video uses H.265/HEVC codecs. Chromium browsers do not support this. To check your file, you can use a tool like MediaInfo
 or check its properties in your OS. After, use either HandBrake or ffmpeg to convert your file to an mp4 encoded with H.264. Handbrake is the easy choice of two. Also check if your video file is renamed to filmeva.mp4 and is under the videos folder if you're on an older version of the software

**Can I use this outside of Minecraft and on normal browsers?**

Althought it is originally designed for the WebDisplays mod, it should have *ALMOST* no problems doing that.(Mod's custom browser lets me do some things general browsers wont allow)

**Does the software collect any personal data?**           

No. This software does not transmit usage information, track the files you open, or send data to third parties. 

**My router doesn't support NAT loopback, I can't see the stream. What do I do?**  (thank you @xdcoelite)

Edit your computer’s `hosts` file:     
1. Go to `C:\Windows\System32\drivers\etc`  
2. Open `hosts` as Administrator.  
3. Add:  
   `192.168.x.x yourdomain.ddns.net`  
   (Replace with your PC’s local IP and your public hostname.)  

Now accessing `yourdomain.ddns.net` will connect locally.

⚠️ Editing your hosts file can affect how your system resolves domains. Only make changes if you’re comfortable, and double-check the entries.

Your Question isn't here? Then visit [Questions](https://github.com/Lakunake/Minecraft-WebDisplays-Video-Player/discussions/2) or email **johnwebdisplay@gmail.com**.
