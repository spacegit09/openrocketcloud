# Rocket in Cloud

The real [OpenRocket](https://openrocket.info) with **live sharing and account sync**: sign in with a Google account,
open a rocket design, and edit it together with your team in real time. Everyone runs the genuine
OpenRocket 24.12, with the same physics engine, the same windows and dialogs, and the same results.
The only addition is that everyone's edits appear in everyone else's OpenRocket within a moment.

**Live:** <https://rocketincloud.com> · **About the code:**
<https://spacegit09.github.io/openrocketcloud/>

There are two ways to run it:

- **In the browser, on Base44** (what the live site uses): OpenRocket runs inside each person's
  browser, and Base44 hosts the site, sign-in and live sharing. No server of your own. See
  [Browser version on Base44](#browser-version-on-base44-no-server).
- **Self-hosted with Docker**: each person gets OpenRocket on your server, streamed to their
  browser. Full desktop speed and the 3D view. Most of this README covers this version.

## How the self-hosted version works

```
 Browser (any OS)                       Server (Docker host)
┌──────────────────────┐   HTTPS   ┌────────────────────────────┐   Docker   ┌──────────────────────────────┐
│ Dashboard: designs,  │──────────▶│ Node server                │──────────▶│ One container per person      │
│ sharing, upload/down │           │  • Google sign-in          │           │ per open design:              │
│                      │           │  • projects, sharing, DB   │   VNC     │  Xvnc + openbox               │
│ Session: OpenRocket  │◀──────────│  • VNC proxy (authorised)  │◀─────────▶│  OpenRocket-24.12.jar         │
│ screen (noVNC) +     │    SSE    │  • live-share hub ◀────────┼───────────┤  (official, unmodified)      │
│ presence & activity  │◀──────────│    (orders & merges edits) │ WebSocket │  + live-share bridge (same JVM)│
└──────────────────────┘           └────────────────────────────┘           └──────────────────────────────┘
```

- **Unchanged OpenRocket.** The session image downloads the official `OpenRocket-24.12.jar`
  (checksum-pinned) and runs it as is. Nothing in OpenRocket is reimplemented or patched.
- **Live share bridge** (`worker/bridge`). A small Java module starts OpenRocket in the same JVM
  and watches the open design. When you edit, OpenRocket's own change events say which components
  you touched. The bridge snapshots the design with OpenRocket's own `.ork` writer and sends only
  what changed, one component property at a time. Remote edits are applied with the same property
  setters OpenRocket's file loader uses, in place, so dialogs you have open stay open. Structural
  changes (adding, removing or moving parts) reload the rocket the way OpenRocket's undo does.
- **Merging.** The server puts all edits to a design in one order and keeps the authoritative copy.
  Different properties merge cleanly; for the same property at the same moment, the last edit wins.
  Edits made while offline are re-sent when the connection returns.
- **Undo** reverts your own edits only. OpenRocket's undo restores a whole-rocket snapshot, so the
  bridge keeps collaborators' later changes instead of rolling them back.
- **Simulations** are shared, results included. OpenRocket re-runs out-of-date simulations by itself
  after every change. Each result records the exact design it was computed for, so results for an
  older version of the design are shown as out of date and never as current.

## Browser version on Base44 (no server)

`web/` is a second way to run Rocket in Cloud: OpenRocket runs inside each person's browser
([CheerpJ](https://cheerpj.com), Java in WebAssembly), and [Base44](https://base44.com) hosts
everything else for free: the website, Google sign-in, the design list and sharing, custom motors,
and live sharing. Nothing runs on your own computer or server.

```
 Browser (each person)                                     Base44
┌──────────────────────────────────┐   WebSocket   ┌──────────────────────────────┐
│ OpenRocket-web.jar (CheerpJ)     │◀────────────▶│ DesignRoom actor, one per    │
│  + live-share bridge (BrowserLink)│  via the page │ design: orders and merges    │
│ dashboard / design page          │               │ edits, stores the design,    │
└──────────────────────────────────┘               │ edit history, saved copies   │
                                                   │ Design + Motor records       │
                                                   └──────────────────────────────┘
```

- **Same OpenRocket.** `scripts/build-web-jars.sh` makes `OpenRocket-web.jar` from the official
  jar by removing only what a browser cannot use: native libraries for Windows, macOS and Linux,
  the GraalJS engine behind the *Scripting* simulation extension, and Photo Studio's sky images.
  Simulation results match desktop OpenRocket (checked to 8–13 significant digits).
- **Same live sharing.** The bridge from `worker/bridge` runs unchanged; in the browser its
  connection goes through the page (`worker/bridge/web/orcloud/bridge/BrowserLink.java`) to the
  `DesignRoom` Base44 actor, which runs the same merge and edit-history code as the Node hub
  (`web/base44/actors/DesignRoom/room.js`, using `server/src/model.js` and `edits.js`).
- **Browser fixes** (`worker/bridge/web`): Java's XML setup is warmed up on one thread, the plugin
  list is precomputed (OpenRocket's class-path scanner cannot run under CheerpJ), and running
  simulations pause briefly so the window stays responsive.
- **Limits:** no 3D view (no OpenGL); OpenRocket takes 20–30 s to open the first time; simulations
  run about 15× slower than desktop (1–4 s each); "Update flight estimates in design window"
  (Preferences → Design) starts switched off, because its background simulation makes every edit
  wait 1–2 s; *Save As* and exports download straight to your computer. CheerpJ's free licence is
  for personal and non-commercial use.

Build and deploy (needs Docker, Node 20+ and the Base44 CLI: `npm install -g base44`):

```bash
scripts/build-web-jars.sh       # OpenRocket-web.jar and orcloud-web.jar into web/public/or/
cd web && npm install
base44 login
base44 link --create --name "My OpenRocket"   # once per checkout
base44 deploy --build --yes                   # site, actor, records, Google sign-in
```

Tests: `npm test` (the room and `.ork` handling) and `node test/e2e.mjs` (two headless Chrome
windows running the real OpenRocket against a local stand-in for the actor).

## Installing the self-hosted version

On any machine with Docker (a Linux server for a team, or Docker Desktop on Mac/Windows to try
it), run:

```bash
curl -fsSL https://raw.githubusercontent.com/spacegit09/openrocketcloud/main/install.sh | bash
```

The installer asks where people will open it (this computer only, or a public domain with
automatic HTTPS) and for optional Google sign-in keys. It then downloads ready-made images from
GitHub Packages and starts everything in `~/openrocketcloud`. Run it again to update; settings and
designs are kept.

Without Google keys, a local install turns on a test sign-in (any email, localhost only), so you
can try it right away. To try two people on one computer, use `http://localhost:8080` in one tab
and `http://127.0.0.1:8080` in another. They keep separate sign-ins.

### Build from source

```bash
git clone https://github.com/spacegit09/openrocketcloud && cd openrocketcloud
cp .env.example .env    # set DEV_LOGIN=true to try without Google
docker compose up -d --build
```

The first build downloads OpenRocket and a Java runtime (a few minutes). Opening a design starts
its OpenRocket in about 5–20 seconds.

## Google sign-in

1. Open [Google Cloud Console](https://console.cloud.google.com/), then create or pick a project.
2. **APIs & Services → OAuth consent screen**: choose *External*, enter the app name and
   support email, and add the scopes `openid`, `email` and `profile`. While the app is in
   *Testing*, only the test users you list can sign in. Click **Publish app** to allow any Google
   account. These basic scopes need no Google review.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type *Web
   application*. Under *Authorized redirect URIs* add `PUBLIC_URL` + `/auth/google/callback`, for
   example `http://localhost:8080/auth/google/callback` and
   `https://rocket.example.com/auth/google/callback`.
4. Put the client ID and secret into `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and
   run `docker compose up -d`.

To limit who can sign in, set `ALLOWED_EMAIL_DOMAINS=gmail.com,yourschool.org` and/or
`ALLOWED_EMAILS=a@gmail.com,b@gmail.com`.

## Front door on Base44 (optional)

Instead of setting up Google sign-in yourself, you can put a free [Base44](https://base44.com) site in
front of the server (`frontdoor/`). People open the Base44 address and sign in with Google there,
and the site sends them on to OpenRocket with a one-time pass that expires after a minute. The
server tells the site its current address every time it starts, so the Base44 link keeps working
even when the server's own address changes (for example a Cloudflare quick tunnel on a laptop).
Base44 only hosts the sign-in page; OpenRocket itself still runs on your server.

```bash
npm install -g base44
cd frontdoor && npm install
base44 login
base44 link --create --name "My OpenRocket"
openssl rand -hex 32                      # the shared secret
base44 secrets set ENGINE_SECRET=<secret>
base44 deploy --build --yes               # prints the App URL
```

Then set `BASE44_APP_URL=<App URL>` and `BASE44_SECRET=<secret>` in `.env` and run
`docker compose up -d`. The site allows Google accounts only (`frontdoor/base44/auth/config.jsonc`);
`ALLOWED_EMAIL_DOMAINS` and `ALLOWED_EMAILS` still apply on the server.

## Deploying to the cloud

Any Linux server with Docker works (x86-64 or ARM). For example, a Google Cloud, AWS or DigitalOcean
VM with 4 vCPUs and 16 GB RAM comfortably serves about 10 people with designs open at once. Each
open design runs one OpenRocket, typically 0.6–1 GB of RAM, capped by `SESSION_MEMORY_MB`.

1. Point a DNS name (e.g. `rocket.example.com`) at the server and open ports 80 and 443.
2. Copy this folder to the server, `cp .env.example .env`, and set:
   `PUBLIC_URL=https://rocket.example.com`, `DOMAIN=rocket.example.com`, the Google client ID and
   secret, and `DEV_LOGIN=false`.
3. Start with automatic HTTPS (Caddy and Let's Encrypt):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
   ```

**Backups.** All designs, sharing and version history live in the `orcloud-data` volume, in one
SQLite database:

```bash
docker run --rm -v openrocket-cloud_orcloud-data:/data -v "$PWD":/backup alpine tar czf /backup/orcloud-backup.tgz /data
```

**Security notes.**

- The server controls Docker through `/var/run/docker.sock` (it starts and stops session
  containers), so treat the host as dedicated to this app.
- Session containers run as an unprivileged user with a read-only root filesystem, no Linux
  capabilities, and memory, CPU and process limits.
- Session containers sit on an internal network: they can reach the server but not the internet.
- The live-share hub listens on a separate port that is never published.

## Using it

- **New design**: blank (exactly like OpenRocket's *File → New*), one of OpenRocket's example
  designs, or upload an `.ork` file (drag and drop works too).
- **Share**: invite people by their Google email as *Can edit* or *Can view*. Viewers see every
  change live and can click around, but nothing they change is shared; it snaps back.
- **Saving** is continuous. **Download .ork** gives a file that opens in desktop OpenRocket.
  **Saved copies** keeps a downloadable copy every 10 minutes while people are editing.
- **Edit history** (clock button in the session, or ⋯ on a design): who changed what and when,
  e.g. "Nose cone · Length: 10 cm → 14 cm". **Undo these changes** reverts one person's edit,
  keeping anything changed again since; **Restore to before this** puts the whole design back to
  that moment. Reverts are shared live and can themselves be undone. OpenRocket's automatic
  simulation re-runs are not listed.
- **Motors** (dashboard): upload custom motor files (`.eng` RASP or `.rse` RockSim). They appear in
  OpenRocket's motor selector next to the built-in motors. Everyone a design is shared with gets
  the custom motors of all its members, so collaborators always see the same motors. Reopen
  OpenRocket to load motors added while it's open.
- **Files**: anything you save or export inside OpenRocket (simulation CSV, PDF reports, RockSim
  or 3D exports, Save As) appears under the folder button, ready to download.
- **Who's here**: avatars show who has the design open and which part each person has selected.
  The bar shows recent changes ("Mina edited Fin set").
- **Mac keyboards**: ⌘-shortcuts are sent as Ctrl-shortcuts, which is what OpenRocket expects on
  the Linux machine it runs on. Copy and paste go through your browser's clipboard; allow
  clipboard access when asked.
- OpenRocket closes itself after 15 idle minutes (`SESSION_IDLE_MINUTES`). Your work is saved.

What is per person: window layout, selection, open dialogs, undo history, and OpenRocket
preferences such as units, which are remembered for you across sessions.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | Address users open; used for the Google redirect URI and cookie security |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google OAuth client |
| `BASE44_APP_URL`, `BASE44_SECRET` | — | Sign in through a Base44 front door instead (see above) |
| `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS` | empty (anyone) | Restrict sign-in |
| `HTTP_BIND`, `HTTP_PORT` | `127.0.0.1`, `8080` | Where the site listens on the host |
| `MAX_SESSIONS` | `20` | OpenRocket instances running at once (server-wide) |
| `MAX_SESSIONS_PER_USER` | `2` | Designs one person can have open at once |
| `SESSION_MEMORY_MB`, `SESSION_CPUS` | `1536`, `2` | Limits per OpenRocket instance |
| `SESSION_IDLE_MINUTES` | `15` | Close OpenRocket after this long without a viewer |
| `DOMAIN` | — | Host name for `docker-compose.https.yml` |
| `DEV_LOGIN` | `false` | Sign in as any email without Google (localhost only) |
| `DEBUG_OPS` | `false` | Log every merged edit (server and bridges) |

## Known limits

- Two people changing *the same field* at the same instant: the later one wins.
- If someone adds, removes or moves parts, other people's open component dialogs close. That is
  the same thing OpenRocket does on undo.
- OpenRocket's simulations use a fresh random turbulence seed on every run. A re-run of a simulation
  that is already up to date stays on your screen and is not broadcast.
- *File → Open* or *New* inside the cloud OpenRocket opens a separate, unshared window. Shared
  designs are created on the dashboard.
- Keyboard input methods (e.g. Korean IME) don't compose through the remote screen. Paste text
  instead.

## Development

```
worker/            OpenRocket session image
  Dockerfile       downloads the official jar, builds the bridge
  bridge/src/      live-share bridge (Java 17, no dependencies besides OpenRocket)
  bridge/web/      browser start-up and CheerpJ fixes (BrowserLink, WebMain, plugin list, ...)
  bridge/test/     SelfTest: checks the sync model against real OpenRocket on all example designs
  rootfs/          session entrypoint (Xvnc + openbox + OpenRocket), window manager config
web/               browser version (Base44 project)
  base44/          DesignRoom actor (room.js), Design and Motor records, sign-in settings
  src/             dashboard and design page (vanilla JS), .ork zip handling, CheerpJ start-up
  test/            room tests, local stand-in for the actor, two-browser end-to-end test
frontdoor/         optional Base44 sign-in site for the self-hosted server
docs/              GitHub Pages: a guide to the code
server/            Node 24 server (Express, ws, dockerode, SQLite)
  src/model.js     server twin of the bridge's Model.java (must stay identical in behaviour)
  public/          dashboard and session page (vanilla JS, noVNC)
  test/            parity tests against fixtures generated by the Java self-test
```

Run everything with `scripts/test.sh`. It runs the bridge self-test inside the worker image
against the real OpenRocket (all 17 bundled example designs), then the server tests, including
Java/Node parity. Set `DEBUG_OPS=true` to watch edits flow between sessions in
`docker compose logs -f server`.

## License

GPL-3.0-or-later, like OpenRocket, which this runs and links against. OpenRocket is © the
OpenRocket team; see <https://github.com/openrocket/openrocket>. This project is not affiliated
with or endorsed by the OpenRocket project.
