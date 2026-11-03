# VPS Panel

A web control panel for a single Linux server. It runs **on the server it manages**.

| Page | What you can do |
| --- | --- |
| Dashboard | Live CPU, memory, swap, load, network and disk usage |
| Sites | Health of every hostname the server fronts: DNS, certificate, HTTPS response, backend pods or container, a screenshot thumbnail and a plain-language reason when something is down |
| Services | List systemd units, start / stop / restart, enable / disable at boot, live journal logs |
| Docker | Containers (start, stop, restart, pause, remove, live logs, details, interactive terminal), images (pull, remove), volumes, networks |
| Kubernetes | Apps (restart, scale), pods (CPU, memory, live logs, delete), ingresses with certificate status, warnings |
| Requests | Live view of every request reaching the nginx ingress: status, path, app, client, size, duration |
| Kafka | Brokers, topics (create, delete, partitions, config, read latest messages, produce), consumer groups and lag |
| Processes | Top processes, send signals, listening ports |
| Activity | Audit log of every sign-in and change |

## Stack

- `server/` – Node.js, TypeScript, Express, WebSocket (`ws`), `dockerode`, `kafkajs`, `systeminformation`
- `client/` – React, TypeScript, Vite, TanStack Query
- `ios/` – native SwiftUI iPhone client, see [ios/README.md](ios/README.md)
- `deploy/` – Kubernetes Service and Ingress manifests for exposing the panel through an nginx ingress

In production the server also serves the built client, so there is one process and one port.

## Getting started

### Prerequisites

- Node.js 20 or newer and npm (the repo uses npm workspaces)
- Git
- Optional, depending on which pages you want: Docker (socket access), `kubectl` with a working kubeconfig, Kafka brokers
- On the server: Linux with systemd for the Services page

### 1. Clone and install

```bash
git clone https://github.com/ssandeep2197/VPS-Panel.git
cd VPS-Panel
npm install
```

### 2. Create the admin account

```bash
npm run setup -- --username admin --password 'choose-a-password'
```

This writes `server/.env` with a bcrypt hash of the password and a random `JWT_SECRET`.
Omit `--password` to have a random one generated and printed once. Add `--brokers host:9092`
to configure Kafka, or `--force` to overwrite an existing `.env`.

### 3. Run in development

```bash
npm run dev          # API on :4600, UI on http://localhost:5173
```

The Vite dev server proxies API and WebSocket calls to the Node server, so open the `:5173` URL.
On macOS, Docker and Kafka work; systemd service management only works on Linux.

### 4. Build and run in production mode

```bash
npm run build        # client to client/dist, server to server/dist
npm start            # serves API and UI on http://127.0.0.1:4600
```

Other useful scripts:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks server and client without emitting |
| `npm run passwd` | Changes the admin password at a hidden prompt |

## Deploy to the VPS

Requires Node.js 20+.

```bash
# on the server
git clone https://github.com/ssandeep2197/VPS-Panel.git /opt/vps-panel && cd /opt/vps-panel
npm ci
npm run build
npm run setup -- --username admin --password 'choose-a-password' --brokers localhost:9092
npm start            # http://127.0.0.1:4600
```

### 1. Run it as a service

`/etc/systemd/system/vps-panel.service`:

```ini
[Unit]
Description=VPS Panel
After=network.target docker.service

[Service]
WorkingDirectory=/opt/vps-panel
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
User=panel
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/vps-panel panel
sudo chown -R panel: /opt/vps-panel
sudo usermod -aG docker,systemd-journal panel     # Docker socket + journal access
sudo systemctl enable --now vps-panel
```

### 2. Allow service control without running as root

Set `USE_SUDO=true` in `server/.env` and add `/etc/sudoers.d/vps-panel` (edit with `visudo -f`):

```
panel ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/journalctl
```

Alternatively run the unit as `User=root` and leave `USE_SUDO=false`.

### 3. Put HTTPS in front

The panel listens on `127.0.0.1` by default. Expose it through a reverse proxy with TLS, for example Caddy:

```
panel.example.com {
    reverse_proxy 127.0.0.1:4600
}
```

Then set `TRUST_PROXY=1` in `server/.env`. With nginx, remember to forward WebSocket upgrades for `/ws`.

### 4. Optional: expose through a Kubernetes ingress

If the server already runs an nginx ingress with cert-manager, `deploy/` contains a Service
with a manual Endpoint pointing at the host (`172.17.0.1:4600`, the docker bridge address)
and an Ingress with a Let's Encrypt certificate. Edit the hostname in `deploy/k8s-ingress.yaml`
first, make sure the DNS A record already points at the server, then:

```bash
kubectl apply -f deploy/k8s-service.yaml
kubectl apply -f deploy/k8s-ingress.yaml
```

Set `HOST=172.17.0.1` (or `0.0.0.0` behind a firewall) and `TRUST_PROXY=1` in `server/.env`
so the panel is reachable from the cluster.

## Configuration

All settings live in `server/.env`; see `server/.env.example` for the full list.

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Listen address (default `127.0.0.1:4600`) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET` | Created by `npm run setup` |
| `USE_SUDO` | Run `systemctl` / `journalctl` through `sudo -n` |
| `PROTECTED_SERVICES` | Services that can never be stopped or disabled from the UI (default `ssh,sshd,vps-panel`) |
| `DOCKER_SOCKET` | Override the Docker socket path |
| `KUBECTL_BIN` | Path to `kubectl` (default `kubectl`); the Kubernetes page is hidden when it is missing |
| `PROTECTED_NAMESPACES` | Namespaces whose workloads cannot be scaled from the UI (default `kube-system,ingress-nginx,cert-manager`) |
| `PUBLIC_URL`, `TMS_ISSUER`, `TMS_CLIENT_ID`, `TMS_CLIENT_SECRET` | Sign in with TMS (see below); `TMS_NAME` is the label on the login screens (default `HW`) |
| `TMS_ADMIN_ROLES`, `TMS_SESSION_HOURS`, `PASSWORD_LOGIN` | Which TMS roles may change things; session length; keep or drop the panel's own password |
| `KAFKA_BROKERS` | Comma separated brokers; SASL/SSL options are in `.env.example` |
| `SITES` | Extra hostnames to check that have no ingress rule in the cluster |
| `THUMBNAILS`, `THUMBNAIL_IMAGE` | Screenshots use headless Chromium in a throwaway Docker container (`zenika/alpine-chrome`, pulled on first use); set `THUMBNAILS=false` to disable |

To change the password, run `npm run passwd` on the server and restart the panel. It asks for the
password at a hidden prompt and changes nothing else. From another machine:

```bash
ssh -t <server> "cd /opt/vps-panel && npm run passwd && systemctl restart vps-panel"
```

Avoid passing a password on a command line through SSH: the local shell rewrites characters such as
`$`, `!` and backticks inside double quotes, so the stored password ends up different from what you typed.

## Sites page

Hostnames are discovered from the cluster's ingress rules every minute (plus `SITES` from `.env`) and checked
from the server itself: DNS record versus the server's IP, the certificate actually served (Let's Encrypt, the
ingress placeholder, expiry), the HTTPS response and time, and what is behind the ingress (pods ready, or for
selector-less services the Docker container on the host bridge). Each failing step becomes a sentence in the
site's "problems" list, so the page says *why* a site is down, not just that it is. Screenshots are refreshed
every 30 minutes, a few per cycle, and stored in `server/data/thumbnails`.

## Sign in with TMS

The TMS platform is an OpenID Connect provider (issuer `https://admin.helloworlds.co.in/platform/oidc`) and the
panel is one of its registered apps, exactly like an app that signs in with Google. People click **Sign in with
HW** (the label is `TMS_NAME`), type their TMS email and password on the TMS page (silently, within 8 hours of any other TMS sign-in), and
come back signed in. Who may open the panel, and as which role, is decided per account in the TMS admin portal
under **Access**; owners (`PLATFORM_ADMIN_EMAILS`) need no grant.

- Flow: authorization code with PKCE (`GET /auth/login` → TMS → `GET /auth/callback`), done with
  [openid-client](https://github.com/panva/openid-client); the discovery document is read at start-up, the id token
  is verified against the TMS keys, and the identity (`sub`, `email`, `name`, `role`) is read from it. The panel then
  issues its own session (8 hours, `TMS_SESSION_HOURS`): an HttpOnly cookie for the web app, a bearer token handed to
  the iPhone app through `vpspanel://signed-in`. The TMS access token is kept server-side (`server/data/sessions.json`)
  so the grant is re-checked with the TMS about once a minute while it lives; a grant removed in the admin portal ends
  the session within a minute during that hour, and at the next sign-in afterwards.
- Roles: `owner` and `admin` may change things; any other role (`viewer`) sees everything but every state-changing
  request answers 403 `READ_ONLY`, and the container shell is refused. Change the list with `TMS_ADMIN_ROLES`.
- Sign-out ends the panel session and, unless `TMS_LOGOUT_EVERYWHERE=false`, sends the browser through the TMS
  logout so the next sign-in asks for the password again.
- Setup, owner's side: register the app on the admin portal's **Apps** page (id `vps-panel`, redirect URL
  `https://panel.example.com/auth/callback`, roles `admin, viewer`, server-side), copy the secret it shows once
  into `TMS_CLIENT_SECRET`, set `PUBLIC_URL` and `TMS_ISSUER`, restart, then grant people on **Access**.
- The panel's own `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` login stays behind "Use the panel's own admin password"
  as the break-glass path for when TMS itself is down, since the panel is the tool to fix it with
  (`PASSWORD_LOGIN=false` removes it).

## Security notes

This panel can stop services, delete containers and kill processes. Treat it like SSH access.

- Never expose port 4600 directly to the internet; use HTTPS, and ideally restrict access by IP or VPN.
- Login is rate limited (10 attempts per 15 minutes) and sessions expire after 12 hours.
- Commands run without a shell and every name is validated, so input cannot be injected into a command.
- Container environment variable *values* are never sent to the browser, only their names.
- Membership of the `docker` group is equivalent to root on the host.

## iPhone app

A native SwiftUI client lives in `ios/`. It needs Xcode 16+ and
[xcodegen](https://github.com/yonaskolb/XcodeGen):

```bash
brew install xcodegen
cd ios
xcodegen generate
open VPSPanel.xcodeproj
```

Run it on a simulator or your phone, enter the panel URL and sign in with the admin account.
See [ios/README.md](ios/README.md) for signing and local-network details.

## License

Released under the [MIT License](LICENSE).
