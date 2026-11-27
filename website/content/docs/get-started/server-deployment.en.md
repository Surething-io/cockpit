Install OpenCockpit on an Ubuntu server, start it at boot with systemd, and connect over SSH, a private network, or a public HTTPS domain. Project files, terminals, and agent processes stay on the server.

If Cockpit runs on your own computer or in local Docker, see [Remote Access from Your Computer](/en/docs/get-started/remote-access/).

## Install

Use Ubuntu with [Node.js 22.19.0 or later](https://nodejs.org/en/download), npm, Git, and OpenSSL. Install Node and npm system-wide so the systemd service user can run them.

```bash
sudo node -v
sudo npm install -g @surething/cockpit
command -v cockpit
cockpit -v
```

Create a dedicated service user and a projects directory. This example uses `/home/opencockpit/projects`.

```bash
id -u opencockpit >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash opencockpit
sudo -u opencockpit -H mkdir -p /home/opencockpit/projects
sudo -u opencockpit -H node -v
```

Sign in to or configure your agents as this user and put projects in a directory it can access. Sessions, settings, and credentials live in `/home/opencockpit/.cockpit` by default. Anyone with the shared token can use the service account's terminal and access the same projects and sessions. [AI engines](/en/docs/agent/engines/)

## Configure systemd

Create a root-readable environment file. The following command generates a token only if the file is absent.

```bash
sudo install -d -m 0750 /etc/opencockpit
sudo sh -ec '
  umask 077
  if [ ! -e /etc/opencockpit/access.env ]; then
    token=$(openssl rand -hex 32)
    printf "COCKPIT_TOKEN=%s\n" "$token" > /etc/opencockpit/access.env
  fi
'
```

Create the unit with `sudoedit /etc/systemd/system/opencockpit.service`. In `ExecStart`, use the system-wide absolute path returned by `command -v cockpit`.

```ini
[Unit]
Description=OpenCockpit
After=network-online.target
Wants=network-online.target

[Service]
User=opencockpit
WorkingDirectory=/home/opencockpit/projects
Environment=COCKPIT_HOST=127.0.0.1
EnvironmentFile=/etc/opencockpit/access.env
ExecStart=/usr/local/bin/cockpit --port 3457 --no-open
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Start Cockpit and check its local health endpoint.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opencockpit
sudo systemctl status opencockpit
curl -fsS http://127.0.0.1:3457/api/health
```

Use `sudo journalctl -u opencockpit -n 100 --no-pager` to read the service logs.

## Private access

For access from your own computer, open an SSH tunnel from that computer and visit `http://localhost:3457`. Keep the SSH connection open.

```bash
ssh -N -L 127.0.0.1:3457:127.0.0.1:3457 admin@server.example.com
```

Replace the username and hostname with your SSH login. SSH controls access to the tunnel, and Cockpit receives a loopback request. For browser access over a LAN or VPN, you can use an HTTPS reverse proxy restricted to that private network.

## Public HTTPS

Keep Cockpit listening on `127.0.0.1:3457`. Point the domain's A record at the server, and add an AAAA record if the server has working public IPv6. Allow inbound TCP on ports 80 and 443 for the reverse proxy. Keep port 3457 on loopback.

This example uses [Caddy's Ubuntu package](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). After installing it, add your site to `/etc/caddy/Caddyfile` and substitute your domain.

```caddyfile
cockpit.example.com {
    reverse_proxy 127.0.0.1:3457
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

When the domain and ports are reachable, Caddy obtains and renews the certificate, proxies WebSockets, and sets forwarding headers. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) · [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

With an existing HAProxy, Nginx, or other reverse proxy, preserve the original `Host`, forward WebSockets, set `X-Forwarded-Proto: https`, and overwrite `X-Forwarded-For` with the verified source or append the connecting peer's address. Cockpit detects a same-host proxy connected over loopback. Configure trusted proxy addresses if the chain includes remote proxies. [Trusted proxies and Host checks](/en/docs/reference/cli/#shared-token-access-gate)

Check the HTTPS entry point from another device. The anonymous request below should return `401`. Then read the token from `/etc/opencockpit/access.env` in an administrative terminal and open `https://cockpit.example.com/?token=YOUR_TOKEN` in your browser. Cockpit sets a login cookie and removes the token from the URL. If you enable reverse proxy access logs, exclude the `token` query parameter, cookies, and authentication headers.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cockpit.example.com/api/health
```

Five consecutive incorrect tokens from one client IP trigger a ten-minute lockout with HTTP status `429`. HTTP and WebSocket share the counter. After signing in, open a session or a terminal to check that the live connection works.

## Open on your phone

1. On your computer, open Cockpit using a domain or private-network address that your phone can reach.
2. Click the **Open on phone** QR icon in the desktop top bar. Scanning opens `/m` and goes straight to the current session if one is open on your computer.
3. If you switch to Desktop on your phone, use **Mobile** in the bottom-right corner of the narrow desktop layout to switch back.

The QR icon is hidden when Cockpit is opened on `localhost` or another loopback address. With earlier versions, open `/m` directly at the server address on your phone. When token authentication is enabled, the QR code includes the shared access token so the phone can sign in on the first scan. Treat the code like a password.

## Upgrade and roll back

Record the current version with `cockpit -v` and back up the service user's `~/.cockpit` directory. Use the same global npm installation path as before, and let systemd manage the process.

```bash
sudo systemctl stop opencockpit
sudo npm install -g @surething/cockpit@latest && sudo systemctl start opencockpit
```

Check the systemd status, the local health endpoint, and HTTPS sign-in after upgrading. To roll back, replace `PREVIOUS_VERSION` with the version you recorded.

```bash
sudo systemctl stop opencockpit
sudo npm install -g @surething/cockpit@PREVIOUS_VERSION && sudo systemctl start opencockpit
```

For startup and access errors, see [FAQ & Troubleshooting](/en/docs/reference/faq/).
