Reach Cockpit on your own computer or in Docker from a phone or another computer over a stable HTTPS hostname. Projects, terminals, and agents run on your machine. Keep the machine, Cockpit, and the Cloudflare Tunnel connector running while you need remote access.

## Create a Cloudflare Tunnel

Add your domain to Cloudflare and choose a dedicated subdomain such as `cockpit.example.com`. In the Cloudflare dashboard, create a remotely managed tunnel using **Cloudflared**. Keep the connector token from the dashboard for the Docker example.

Once Cockpit and your chosen connector are running, add a **Published application route** to the tunnel. Select your subdomain and the **HTTP** service type, and enter `127.0.0.1:3457` as the origin address. Cloudflare serves HTTPS to the browser and the connector reaches Cockpit over loopback. Both examples use the same route. Choose one way to run Cockpit and its connector for each tunnel. [Create a tunnel in the Cloudflare dashboard](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)

## Run Cockpit on your computer

Run this from the project you want to use remotely. To install Cockpit first, see [Quickstart](/en/docs/get-started/quickstart/#install). If Cockpit is already using port 3457, stop it normally before starting it with this configuration. To reuse an existing access token, first save it in `~/.config/opencockpit/remote-access-token` with permissions set to `600`.

```bash
(
  set -eu
  umask 077
  token_dir="$HOME/.config/opencockpit"
  mkdir -p "$token_dir"
  if [ ! -s "$token_dir/remote-access-token" ]; then
    token=$(openssl rand -hex 32)
    printf '%s\n' "$token" > "$token_dir/remote-access-token"
  fi

  COCKPIT_HOST=127.0.0.1 \
  COCKPIT_TOKEN="$(cat "$token_dir/remote-access-token")" \
  cockpit . --port 3457 --no-open
)
```

Install `cloudflared` on the same computer and run the connector command Cloudflare shows for your operating system. On macOS you can install it with `brew install cloudflared`. Use the dashboard instructions to run the connector as a system service if desired. [Install cloudflared](https://developers.cloudflare.com/tunnel/downloads/)

Cockpit listens on `127.0.0.1:3457`. You can leave your router's port forwarding disabled for this tunnel.

## Run Cockpit in Docker

You need Docker and `docker compose`. Create a dedicated directory and save the following files as `Dockerfile` and `compose.yaml`.

```dockerfile
FROM node:24

RUN npm install -g --no-audit --no-fund @surething/cockpit@latest

RUN install -d -o node -g node /home/node/projects
USER node
WORKDIR /home/node/projects
CMD ["cockpit", ".", "--port", "3457", "--no-open"]
```

```yaml
services:
  cockpit:
    build: .
    init: true
    restart: unless-stopped
    env_file: cockpit.env
    environment:
      COCKPIT_HOST: 127.0.0.1
    volumes:
      - cockpit-home:/home/node

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    network_mode: service:cockpit
    env_file: tunnel.env
    command: ["tunnel", "--no-autoupdate", "run"]

volumes:
  cockpit-home:
```

The containers share a network namespace, so the connector can reach Cockpit at `127.0.0.1:3457`. Compose does not publish a host port. The `cockpit-home` named volume holds projects, `~/.cockpit`, and any agent credentials stored in the home directory. Recreating the containers keeps this volume.

In the same directory, generate the Cockpit token and create the connector environment file. Add `TUNNEL_TOKEN=YOUR_CONNECTOR_TOKEN` to `tunnel.env` with the token from the Cloudflare dashboard. Keep both files on your machine.

```bash
if [ ! -e cockpit.env ]; then
  (umask 077; token=$(openssl rand -hex 32) && printf 'COCKPIT_TOKEN=%s\n' "$token" > cockpit.env)
fi
(umask 077; touch tunnel.env)
```

Add `*.env` to `.dockerignore` and keep both credential files out of Git. Start the services.

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 cockpit cloudflared
```

Run `docker compose exec cockpit bash` to clone projects or sign in to an agent inside the container. Install additional system tools or agent CLIs in the Dockerfile.

## Sign in and scan the phone QR code

After publishing the route, check it from another device. This request carries no Cockpit token and should return `401` when Cloudflare Access is disabled. If it returns `200`, disable the public route while you check that Cockpit loaded its token and the proxy forwards the visitor's address header.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cockpit.example.com/api/health
```

1. Open `https://cockpit.example.com/?token=YOUR_ACCESS_TOKEN` in your desktop browser. Cockpit sets a login cookie and removes the token from the URL.
2. Click **Open on phone** in the desktop top bar and scan the QR code. If a session is open, the phone goes straight to it. The QR icon is hidden on `localhost`.
3. Open a chat and terminal on the phone to check the WebSocket connection. The QR code includes the shared access token, so treat it like a password.

To require an email-based identity check before the Cockpit token, configure a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) on the same subdomain. A phone opening the QR link for the first time must also pass Access. Anonymous requests can be redirected or denied by Access before reaching Cockpit.

## Stop and troubleshoot

- **502 from Cloudflare**. Check that Cockpit is running and the tunnel origin is `http://127.0.0.1:3457`. In Docker, check `docker compose ps` and the logs of both services.
- **Pause remote access**. Stop `cloudflared` on your computer, or run `docker compose stop` in Docker. The named volume keeps your projects and sessions. Run `docker compose up -d` to start the containers again.
- **Update the Docker setup**. Run `docker compose build --pull --no-cache cockpit`, then `docker compose up -d --force-recreate` to recreate both containers so the connector moves into Cockpit's new network namespace. Keep the existing volume and token files.

If you need Cockpit while your computer is off, see [Server Deployment](/en/docs/get-started/server-deployment/).
