> [!NOTE]
> Ensure run.bat/start.sh is ran once before proceeding.
> The list below is sorted in safety order with the lower number being safer.

### Method 1: Tailscale (Virtual LAN)

> [!IMPORTANT]
> Beware, Tailscale only allows 3 emails per [Tailnet](https://tailscale.com/kb/1136/tailnet), but it allows a 100 devices to be connected at the same time, so it would be best if you created a new email for your friends to log into tailscale to just for this

> Basic to setup. *Safest way to do it as in cybersecurity.* Takes a bit longer than method one to do a subsequent start. Also gives trusted SSLs for HTTPS

1. Download and install [Tailscale](https://tailscale.com/download) on everybody's computers
2. Invite your friends to your [Tailnet](https://tailscale.com/kb/1136/tailnet)
3. Run `run.bat`, then visit the provided network link

### Method 2: Cloud Hosting (Render, Heroku, Replit, etc.)
  
> [!WARNING]
> Not recommended due to the free plan limitations of websites

> Safe-ish..? Though hard to set up and do subsequent starts.

1. Fork the repository: [https://github.com/Lakunake/Minecraft-WebDisplays-Sync-Player](https://github.com/Lakunake/Minecraft-WebDisplays-Video-Player)
2. Connect your repository to your hosting service
3. Set build command: `npm install`
4. Set start command: `node --env-file-if-exists=../config.env server.js`
5. Set root folder to: `./res/`
6. Deploy and access your video player via the provided URL

> Congratulations if you managed to deploy it successfully using Cloud Hosting...

### Method 3: Docker Compose
[@Aeres-u99](https://github.com/Aeres-u99)


1. Make sure you have [Docker](https://www.docker.com/products/docker-desktop/) installed on your machine.
2. Run `docker-compose up -d` in the project folder.
5. To change settings, edit `config.env` and restart the container (`docker-compose restart`).

### Method 4: LAN or Public IP (Direct Hosting)

> Best for Many people and Repeated users, complex-ish setup

1. Make sure your selected port is open in your firewall/router
2. Run `run.bat` in your folder
3. Access the video player from devices at the provided links
4. Access admin panel at `http://your-ip:port/admin` and go to `http://your-ip:port` in minecraft

