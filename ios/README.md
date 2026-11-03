# VPS Panel for iPhone

Native SwiftUI client for the VPS Panel API. It talks to the same server and WebSocket
streams as the web UI, so nothing needs to change on the server.

| Tab | Shows |
| --- | --- |
| Dashboard | Host info, live CPU / memory / swap / network with charts, disks |
| Services | systemd units with start / stop / restart / reload / enable / disable and live journal logs |
| Docker | Containers (actions, live logs, details, CPU/memory), images, volumes, networks |
| Kubernetes | Apps (restart, scale), pods (live logs, delete), ingresses with certificate status, warnings |
| Kafka | Brokers, topics (create, delete, partitions, config, latest messages, produce), consumer groups with lag (delete) |
| More | Services (when Kafka takes the fifth tab), Processes and ports (send signals), live ingress Requests, Activity audit log, Settings |

Tabs for systemd, Kubernetes and Kafka are hidden when the server reports they are unavailable. iPhone shows
five tabs, so when Kafka is configured the Services page moves under More. The server features are re-checked
every time the app returns to the foreground, from Settings, or by pulling down on the More list.

## Build and run

Requires Xcode 16+ and [xcodegen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```bash
cd ios
xcodegen generate          # creates VPSPanel.xcodeproj (not committed)
open VPSPanel.xcodeproj
```

Pick your iPhone or a simulator and press Run. To install on a real phone, set your
Apple ID team under *Signing & Capabilities* once; a free Apple ID is enough for personal use
(the app must be reinstalled every 7 days with a free account, or use a paid developer account / TestFlight).

On first launch enter the server address (defaults to `https://panel.helloworlds.co.in`) and
sign in with the panel's admin username and password. The session token is kept in the Keychain.

For local development, `http://localhost:4600` works in the simulator; on a phone use the Mac's
LAN address and keep the server behind your own network. Plain `http://` is only allowed for local
network addresses.

## Not included

- The interactive container terminal (docker-shell channel). Logs are supported.
- Pulling images from the phone.

## UI tests

`VPSPanelUITests` drives the real app in the simulator against a local panel server, so it never needs the
production password. Start the server with throwaway credentials (set `ADMIN_PASSWORD_HASH`, `JWT_SECRET`,
`PORT=4601`, `SITES=...` in the environment), write a JWT signed with that secret to `<dir>/token.txt`, then:

```bash
TEST_RUNNER_VPS_PANEL_TEST_DIR=<dir> xcodebuild test -project VPSPanel.xcodeproj -scheme VPSPanel \
  -destination 'platform=iOS Simulator,name=iPhone 17e' -only-testing:VPSPanelUITests
```

Screenshots of each step are written to `<dir>`.

## TestFlight

Requires a paid Apple Developer Program membership (https://developer.apple.com/programs/enroll/, USD 99 a year,
approval usually takes a day or two). After that, follow the one-time setup at the top of `deploy/testflight.sh`
(an App Store Connect API key and the app record), then every release is one command:

```bash
ios/deploy/testflight.sh
```

It archives a Release build signed for the App Store, uploads it, and the build shows up in TestFlight once Apple
has processed it. Add yourself (and anyone else) as an internal tester in App Store Connect > TestFlight; they
install the TestFlight app from the App Store and get every new build with a push notification. TestFlight builds
last 90 days and are refreshed by uploading again.
