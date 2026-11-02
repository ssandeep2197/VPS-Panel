# VPS Panel

A web control panel for a single Linux server. It runs **on the server it manages**.

| Page | What you can do |
| --- | --- |
| Dashboard | Live CPU, memory, swap, load, network and disk usage |
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
| `KAFKA_BROKERS` | Comma separated brokers; SASL/SSL options are in `.env.example` |

To change the password, run `npm run passwd` on the server and restart the panel. It asks for the
password at a hidden prompt and changes nothing else. From another machine:

```bash
ssh -t <server> "cd /opt/vps-panel && npm run passwd && systemctl restart vps-panel"
```

Avoid passing a password on a command line through SSH: the local shell rewrites characters such as
`$`, `!` and backticks inside double quotes, so the stored password ends up different from what you typed.

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
