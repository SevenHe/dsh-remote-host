# dsh-remote-host

## Contributing and CI

`CONTRIBUTING.md` describes the edit → build → verify → push loop. CI
(`.github/workflows/ci.yml`) runs on every push and pull request and fails when:

* `lib/shim.js` is stale relative to `src/shim/*.js` (`build-shim.mjs --check`);
* any file the manifest advertises is missing (`verify-manifest.mjs`);
* `market/index.json` is not a valid index (`verify-index.mjs`);
* any shipped source fails `node --check`.

## Releasing

The shim is generated, so a release is: edit sources, rebuild, bump, commit, push, then
refresh the index entry.

```sh
node scripts/build-shim.mjs            # regenerate lib/shim.js from src/shim
node scripts/build-shim.mjs --check    # CI gate: fails when the build is stale
node --check lib/index.js && node --check lib/client.js

# bump the version in package.json, then record the new commit in market/index.json:
git commit -am "release: vX.Y.Z"
git push
```

`market/index.json` lists one `versions[]` entry per release, with
`source.type: "git"`, the repository URL and the **full 40-hex commit** that contains the
release. Keep entries in descending version order; a published entry is immutable — new
builds get a new commit and a new entry.

Two rules that keep the plugin shippable:

* **Never commit a token or cookie.** `~/.dsh-github-token` (mode 0600) and the remote
  cookie belong outside the repository; `.gitignore` blocks the common spellings.
* **Never commit a host identity.** Commit authors are the maintainer's neutral address,
  and examples use placeholders (`devbox.example.com:3080`, `/home/user`).

### Install as a community plugin

The repository publishes a plugin index at `market/index.json`, using the format the
app's **Plugins → Discover → Add index source** expects. Once the repository is public,
add:

```
https://raw.githubusercontent.com/SevenHe/dsh-remote-host/main/market/index.json
```

and the plugin appears under Discover with its version and source commit. Without an
index you can still install from a checkout:

```sh
dsh plugin --profile <name> add /path/to/dsh-remote-host
```

### Keeping the plugin registered after an app update

The desktop app rewrites `profiles/<name>/package.json` while migrating a profile: it
keeps `dependencies` but drops bundle entries it does not ship, which silently unloads
this plugin after an update. Two idempotent scripts deal with that:

```sh
# repair now (bundle entry + config row, recovered from the newest backup)
node scripts/ensure-profile.mjs --profile desktop
node scripts/ensure-profile.mjs --profile desktop --check   # exit 1 when a repair is needed

# install a LaunchAgent that repairs at login, every 30 min, and whenever the app
# bundle is replaced — i.e. before the next launch after an update
node scripts/install-selfheal.mjs --profile desktop --node "$(command -v node)"
node scripts/install-selfheal.mjs --uninstall
```

`--node` matters when the installer runs inside the app's bundled runtime, which cannot
be executed as node without `ELECTRON_RUN_AS_NODE`. The agent logs to
`~/Library/Logs/dsh-remote-host-ensure.log`.

### Remote workspaces are workspaces

`group: workspace` is the mode that gives the remote side the same shape as the local side:

```yaml
- id: dsh-remote-host
  config:
    upstream: http://devbox.example.com:3080
    authority: devbox.example.com:3080
    mount: /devbox
    label: devbox
    group: workspace      # every remote workspace stays its own shipped group
    sectionHeaders: true  # heading + divider before the merged remote groups
    streams: true
    superagent: remote
```

What the shipped sidebar then renders, top to bottom:

1. `工作区` with its own search / filter / new-workspace controls;
2. each **local** workspace as a collapsible directory with its sessions;
3. a `远端工作区 · <label>` heading and divider (inserted by this plugin);
4. each **remote** workspace as a collapsible directory with its sessions.

Groups in 2 and 4 are the shipped group component: same icons, same session rows, same
times, same expander, same pin / archive / search / drag / context menu. The plugin adds
the heading in 3 and merges the data; it renders no rows of its own.

`group: single` is the alternative: every remote workspace folds into one group named after
`label`, which is useful when a host has too many directories to list.

### Why the shipped list is not replaced

The platform exposes these sidebar slots (measured in the running app):

```
sidebar                              sidebar.panellist
sidebar.workspaces                   sidebar.session.action
sidebar.workspaces.directoryFlow     sidebar.session.row.leading / .trailing
sidebar.workspaces.session.row.action
```

`sidebar.workspaces` is the **whole block** — its header carries the shipped search, filter
and new-workspace controls — and there is no slot for the list body alone. Replacing it
therefore costs those controls; the per-row slots (`row.leading`, `row.trailing`,
`row.action`) exist for additive changes only.

So the plugin never replaces the list. Remote workspaces are merged as one shipped group
titled `远端工作区 · <label>`, an optional `sectionHeaders` stylesheet draws a divider
above it, and every row behaviour (pin, archive, search, drag, context menu, expander) is
the shipped implementation.

### Sidebar: native by default

The supported configuration leaves the shipped sidebar alone. The shim merges the
mounted host's workspaces into it as **one native group** titled
`远端工作区 · <label>`, so remote sessions are shipped rows:

- pin, archive, search, drag, context menu and keyboard behaviour are the app's own,
  because nothing re-implements them;
- the plugin's client half does nothing at all in this mode (it returns before touching
  a slot), so no rendering code of ours runs in the renderer.

```yaml
- id: dsh-remote-host
  config:
    upstream: http://devbox.example.com:3080
    authority: devbox.example.com:3080
    mount: /devbox
    label: devbox        # the group reads "远端工作区 · devbox"
    streams: true
    superagent: remote
```

#### `sidebar: sections` is experimental

An earlier design replaced `sidebar.workspaces` with a two-section list. It works
functionally (pin, archive, search and open reuse the shipped services and the shipped
sprite icons) but it has **crashed the renderer** with `EXC_BREAKPOINT` in V8 more than
once, with no reproducible trigger from outside the app. It stays available behind
`sidebar: sections` for experimentation and must not be enabled in a profile you rely
on. Everything below about pin/archive/search applies to the shipped rows in native
mode, which needs none of it.

### Sidebar capabilities (experimental sections mode)

The opt-in two-section sidebar (`sidebar: sections`) adds a remote section next to the
local one, and keeps the native behaviours working for **both**:

| capability | how |
|---|---|
| pin / unpin | row action → `ctx.uiWorkspace.pinSession/unpinSession` |
| archive / unarchive | row action → `ctx.uiWorkspace.archiveSession/unarchiveSession`; archived rows live behind the 已归档 toggle |
| open session | `ctx.uiWorkspace.openSession` |
| search | the input above the list filters both sections by title |
| pinned ordering | pinned sessions float into a 置顶 group at the top of their section |

None of these reimplement anything: they call the same client services the shipped
sidebar uses, so local sessions behave exactly as before. For remote sessions the shim
forwards the same RPC to the mounted host (its routing rule is "payload mentions a remote
session id"), and the remote's pinned/archived state returns through the merged workspace
stream — so a remote session pins and archives on the remote, persistently.

### Source layout

The browser shim is injected as one classic script inside a single IIFE, so its modules
are *concatenated* rather than imported: they share one scope and rely on declaration
order. `lib/shim.js` is generated — edit `src/shim/*.js` and rebuild.

```sh
node scripts/build-shim.mjs          # regenerate lib/shim.js
node scripts/build-shim.mjs --check  # CI: fail when lib/shim.js is stale
```

| module | contents |
|---|---|
| `src/shim/00-config.js` | mount point, feature flags, shared registries |
| `src/shim/10-state.js` | published remote state (ids, workspace layout) and event bookkeeping |
| `src/shim/20-transport.js` | request classification, mount/mux URL derivation |
| `src/shim/30-streams.js` | the WebSocket face the stream client drives |
| `src/shim/40-workspace.js` | workspace merging, pruning and row labelling |
| `src/shim/50-router.js` | the mux router: two legs, one browser socket, per-stream forwarding |
| `src/shim/60-runtime.js` | socket factory, diagnostics, group refresh, prefetches |
| `src/shim/70-lookup.js` | session-list merge and event-answer rewrite |
| `src/shim/80-install.js` | transport installation, global WebSocket patch, self-update |

That split was verified **byte-identical** to the previous single-file shim: structure
changed, behaviour did not.

## Architecture

Three halves, one idea: the remote host already speaks the app's protocol, so the plugin
relays that protocol instead of inventing a new one.

```
          desktop app (this machine)                  remote harness
  ┌─────────────────────────────────────┐        ┌───────────────────────┐
  │ renderer (dsh-app:// document)      │        │  /api/...       (RPC) │
  │   ├─ client half  lib/client.js     │        │  /api/remote.mux      │
  │   │    sidebar sections, labels     │        │  /orchestrator/api    │
  │   └─ shim        lib/shim.js        │        │  (super agent)        │
  │        per-endpoint routing         │        └───────────┬───────────┘
  └──────────────┬──────────────────────┘                    │
                 │  /devbox/*            /devbox/api/remote.mux
                 ▼                                            ▲
  ┌──────────────────────────────────────────────────────────┴───────┐
  │ host half  lib/index.js                                          │
  │   /devbox http mount · mux upgrade relay · credential relay      │
  │   optional: ssh tunnel · /orchestrator/api proxy                 │
  └──────────────────────────────────────────────────────────────────┘
```

| file | role |
|---|---|
| `lib/index.js` | Host half: `/devbox` prefix mount, mux upgrade relay, index shim injection, host-cookie relay, optional SSH tunnel, and the `/orchestrator/api` proxy used when the super agent follows the remote. |
| `lib/shim.js` | Browser half injected into the page: per-endpoint unary routing, one socket multiplexing the local and remote mux legs, workspace/session/event merging, retry-on-not-found, and reload-on-stale-shim. |
| `lib/client.js` | Client plugin: the opt-in two-section sidebar and the `Superagent · <host>` label. |
| `scripts/setup.mjs` | Mints the remote browser-session cookie and writes the profile patch row. |
| `scripts/ssh-helper-deploy.mjs` | Packages the SSH provider helper, prints the `dsh-ssh` row, and deploys it with `--remote`. |

Surface by surface:

* **unary RPC** — `POST /api/<method>`; the shim inspects endpoint and args, and rewrites the
  URL beneath the mount when the call belongs to the remote.
* **streams** — one browser socket on `/api/remote.mux`; the shim keeps one upstream leg per
  host and forwards each stream to the leg(s) that own it.
* **workspace / session list** — merged bidirectionally so the sidebar can show both hosts.
* **events** — exactly one `ready` frame; remote-tagged waterfalls are answered back to the remote.
* **super agent** — host-level prefix proxy, because its panel calls `/orchestrator/api` with
  plain `fetch`, which never passes through the shim.

Drive a **remote DeepSeek Harness host** from **this** app, natively: the devbox's
sessions, workspaces, tools and environment, rendered by the shipped UI — not a
nested copy of the remote page.

```
this app (Host + official UI)                    remote machine (real DSH)
┌──────────────────────────────────────┐        ┌───────────────────────────┐
│ sidebar 工作区                        │        │ dsh --profile superagent  │
│   opencode        (local sessions)   │  HTTP  │  sessions · tools · env   │
│   my-agent     (devbox sessions)  │◄──────►│  workspaces · models      │
│   …                                  │   WS   │                           │
│ /devbox/*  → relay with remote cookie│        │                           │
└──────────────────────────────────────┘        └───────────────────────────┘
```

## How it works

Nothing is installed on the remote, and the remote keeps running untouched.

1. **Host half** (`lib/index.js`) mounts the remote origin on this Host's own
   origin at `/devbox`:
   - `/devbox/<path>` — HTTP relay with the remote's own session cookie injected
     and `Host` rewritten (the remote fence demands its own authority);
   - `/devbox/api/remote.mux` — WebSocket relay for the remote stream mux;
   - `webServer.tapIndex` — injects the browser shim ahead of app bootstrap.
   The mount sits behind the same connection fence as `/api`, and every failure
   is contained: a broken mount logs and leaves a normal Harness.
2. **Browser shim** (`lib/shim.js`) installs `__DSH_TRANSPORT__` and owns one
   decision per call — local or remote:
   - `/api/session/list` → both hosts, merged into one envelope;
   - any call whose payload names a remote session → `/devbox/...`;
   - `/api/remote.mux` → a router that multiplexes the local and remote mux over
     the client's single socket, routing each `open` frame per session and
     merging two streams:
     * `workspace/follow` — one baseline carrying both hosts' workspace records,
       so the devbox's workspaces appear as real groups in 工作区;
     * `$events` — exactly one `ready` reaches the client (the remote's is kept
       aside), remote `emit`/`waterfall` frames are forwarded, and an answer to a
       remote waterfall is rewritten to the remote's client id and posted to the
       mount, so approvals and questions on a devbox turn are answered where the
       turn actually runs.
   Streams wait for both baselines before the first emit, and a dead remote leg
   settles instead of wedging the sidebar or tearing the connection down.

## Install

```sh
node scripts/setup.mjs \
  --upstream http://devbox.example.com:3080 \
  --ssh devbox \
  --remote-home '~/.local/share/super-agent/dsh' \
  --profile-dir ~/.dsh/profiles/desktop
# restart DSH
```

`--ssh` + `--remote-home` read the remote credential store over SSH and mint the
cookie locally. Without SSH, pass the entry URL the remote printed:
`--token 'http://host:port/?token=…'`.

The installer writes `~/.dsh/dsh-remote-host/cookie.txt` (mode `0600`), a `mount`
/`label` config row in the profile patch, adds the bundle, and links the package
into the profile's `node_modules`. It deliberately does **not** add a
`dependencies` row: a pnpm-managed profile keeps that in sync with
`pnpm-lock.yaml`, and an unknown row would break a frozen install on next boot.
Backups are written as `*.before-remote-host-<stamp>`.

## Configuration

The profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`) carries the mount:

| Key | Meaning |
| --- | --- |
| `upstream` | remote web origin, e.g. `http://devbox.example.com:3080` |
| `authority` | `host:port` the cookie was minted for (defaults to `upstream`'s) |
| `mount` / `label` | same-origin mount path (default `/devbox`) and its display label |
| `windowDays` | how far back remote sessions are shown — anything still running is always included (default `30`) |
| `group` | `single` folds every remote Workspace into one group labelled `label`; `workspace` keeps the remote's own groups (default `single`) |
| `sidebar` | `sections` renders a second top-level section 远端工作区 beside 工作区 (default: off) |
| `cookieFile` | cookie path (default `~/.dsh/dsh-remote-host/cookie.txt`) |
| `sshHost` | OpenSSH alias to reach the remote Host through a local tunnel instead of the network |
| `sshRemoteHost`, `sshRemotePort` | what the tunnel dials on the far side (defaults: `127.0.0.1`, the upstream port) |

Remote sessions are filtered by `windowDays` and folded into a single `devbox` group
by default, so a devbox with dozens of projects contributes one readable group
instead of a wall of them (`group: workspace` keeps the remote's own grouping).

The shim prefetches the remote session table at install: the client restores the
previously selected Session during boot, which can precede the first
`session/list`, and an unrouted remote Session would otherwise look "not found".

## Revert

```sh
cd ~/.dsh/profiles/desktop
cp package.json.before-remote-host-<stamp> package.json
cp cordis.patch.yml.before-remote-host-<stamp> cordis.patch.yml
rm node_modules/dsh-remote-host && rm -rf ~/.dsh/dsh-remote-host
```

## Two-section sidebar (`sidebar: sections`)

The sidebar has one list slot, `sidebar.workspaces`, and no section list beside it, so a
second top-level section means rendering the list yourself. With `sidebar: sections`
the browser half replaces that occupant and renders:

* **工作区** — the local workspaces and their sessions;
* **远端工作区 · <label>** — the mounted host's workspaces and sessions, rows labelled
  `<workspace> · <title>` so one host still reads as host → workspace → session.

Verified in a real browser: 12 local sessions under 工作区, 88 remote sessions under
远端工作区 · devbox, and clicking a remote row opens its history.

Two facts learned from the runtime, both worth keeping:

* **A single slot cannot be replaced at the same priority.** Registration throws
  `single slot "sidebar.workspaces" already has a registration at priority 0 … register at
  a different priority to shadow it (lowest renders)`; the replacement therefore
  registers at `priority: -1`.
* **Rows outside any workspace would otherwise reappear as 未分组**, so the group is
  built from every visible remote session, not only from those a workspace record claims.

### Super agent: drive the remote instance (`superagent: remote`)

The super agent plugin serves its own routes with `ctx.webServer.register` — they live
under `/orchestrator` and `/orchestrator/api/`, **not** under `/api/`, which is why no
`/api/superagent/*` endpoint exists. Requests carry a management marker header
(`x-orchestrator-request`); without it the host answers
`403 {"error":"Management request marker required"}`.

With `superagent: remote` the shim re-points `/orchestrator/*` at the mount, so the
panel reads and writes the **mounted** instance instead of a second local one. Verified
against a live pair with the production config:

```
local  /orchestrator/api/tickets → 404
remote /orchestrator/api/tickets → 200 {"items":[{"title":"设计 bytedmysql SQL 注入漏洞的自闭环方案…"}]}
through the app:  200, 1 ticket, detailLoading:false
```

The mount proxy forwards the marker header (only `origin`/`referer`/`sec-fetch-*` are
stripped), so the real UI's requests reach the remote unchanged.

The panel's own code calls `/orchestrator/api/…` with plain `fetch`, which never
touches the browser shim — so a shim-level rewrite was not enough (the panel kept
rendering the local instance's empty state). With `superagent: remote` the **host**
now proxies the `/orchestrator/api` prefix (and upgrades under `/orchestrator`) to the
mounted host, so the panel reads the remote instance whatever transport it uses.

Proof: in a profile with **no** local super agent plugin, `/orchestrator/api/tickets`
answers `{"items":[],"total":0}` with status 200 through the proxy, where it used to be
404 (no local route at all) — and the body is byte-identical to the remote's own
response. The super agent page itself stays local so it cannot clash with the route the
plugin registers.

### Retry-on-not-found (why a remote session sometimes hung forever)

Routing a session stream needs the remote id table, and that table only arrives after
the first `session/list`. A page that restored the previously open session — or a click
during boot — could therefore be classified **local**; the local host answered
`session/not-found` and the UI waited on a stream that would never produce frames. It
was intermittent: the same click succeeded once the table existed.

The router now remembers each open frame and, when the local leg answers
`session/not-found`, re-sends that stream to the remote leg (connecting it on demand)
and swallows the local error. Report key: `retry-remote`. Verified against a live host:
the local leg answered not-found and the same stream was re-issued remotely.

### Shadowing a single slot: what is and is not possible

Registering at a lower priority overrides **rendering** only. The shipped occupant
stays registered, so it still **owns** the child slots: re-declaring
`sidebar.workspaces.directoryFlow` here fails with
`slot "sidebar.workspaces.directoryFlow" is already declared (by an entry in
"sidebar.workspaces" (WC))`. Consequences while `sidebar: sections` is on:

* plugins injecting row actions, row leading/trailing/hover, or the directory flow
  keep waiting for a declarer and render nothing (their injections are harmless);
* archive/pin buttons, drag ordering and the directory picker are therefore absent
  from this list.

### Running local work on the remote host (SSH providers)

The shipped app does **not** bundle the SSH providers, but the registry serves them
(verified with the bundled pnpm):

```sh
pnpm add @deepseek-ai/dsh-ssh @deepseek-ai/dsh-fs-ssh @deepseek-ai/dsh-subprocess-ssh
# resolved: 0.1.6-alpha.1 for all three
```

`@deepseek-ai/dsh-ssh-helper-runtime` is **not** in the registry, so the remote helper
has to be assembled from the installed package: `dsh-ssh/lib/helper.js` plus its
sibling chunks (`protocol-*.js`, `schemas-*.js`, `stream-security-*.js`) and its
runtime deps (`@deepseek-ai/cordis`, `zod`, `@deepseek-ai/dsh-fs`). Install that tree
outside the workspace, then configure `dsh-ssh` (fields verified against the package
docs): `host` (OpenSSH alias), `node` / `helper` / `workspace` (absolute remote paths),
`helperHash` (lowercase SHA-256 of the helper entry), optionally `requestTimeoutMs`,
`maxFrameBytes`, `maxPending`, `leaseMs`; PTC additionally needs `bootstrapPath` +
`bootstrapHash`. `dsh-fs-ssh` and `dsh-subprocess-ssh` take **no** configuration — they
ride the same connection, and file-effect mode belongs to `sandboxPolicy`.

#### Verified wiring (0.2.2-rc.3)

Three pitfalls, each hit and confirmed on a live host:

1. **Install the providers at the app's version.** The npm `latest` tag is still
   `0.1.6-alpha.1`, which the runtime refuses:
   `Plugin @deepseek-ai/dsh-ssh@0.1.6-alpha.1 is incompatible with dsh 0.2.2-rc.3 …
   disabling profile plugin row`. Pin explicitly:
   `pnpm add @deepseek-ai/dsh-ssh@0.2.2-rc.3 @deepseek-ai/dsh-fs-ssh@0.2.2-rc.3
   @deepseek-ai/dsh-subprocess-ssh@0.2.2-rc.3`.
2. **They are plugins, not bundles.** Listing them in `dsh.profile.bundles` fails with
   `declares no dsh.bundle in its package.json`; they go in `- insert:` rows.
3. **`node` lives inside `launch` in 0.2.2-rc.3** (the 0.1.x docs put it top-level,
   which the schema rejects: `$.launch expected { kind: "node-script", node: string … }`).

With those three fixed and the helper *deliberately absent*, the host proves the whole
transport chain: `dsh-ssh` launches `ssh devbox /usr/bin/node <helper>`, the remote Node
runs, and the failure is exactly `Error: SSH helper disconnected; outcome is unknown`
with `dsh-fs-ssh`/`dsh-subprocess-ssh` `pending (waiting for service: ssh)`. Deploying
the helper file is then the only remaining step.

`scripts/ssh-helper-deploy.mjs` automates the deployment: it builds a **hermetic**
helper tree (a hoisted install of `@deepseek-ai/dsh-ssh`, since pnpm otherwise
leaves cordis/zod/dsh-fs under `.pnpm`), computes the SHA-256 of the helper entry,
tars it, and — without `--dry-run` — copies it to `--remoteDir` on the SSH host and
prints the ready-to-paste `dsh-ssh` config row.

```sh
pnpm add @deepseek-ai/dsh-ssh @deepseek-ai/dsh-fs-ssh @deepseek-ai/dsh-subprocess-ssh
DSH_PNPM=<app>/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs \
  node scripts/ssh-helper-deploy.mjs --profile ~/.dsh/profiles/desktop --dry-run \
    --remote devbox --workspace /home/<user>
```

#### Verified working configuration (0.2.2-rc.3 + deployed helper)

A headless profile where files, processes and the sandbox all live on the remote host:

```yaml
# the local providers must be REPLACED, not run alongside: they own the same
# services and registration fails with
#   service "fs" has been registered at <SandboxedFileSystem>
- id: fs-sandbox
  disabled: true
- id: subprocess
  disabled: true
- id: sandbox
  disabled: true
- insert:
    - id: dsh-ssh
      name: '@deepseek-ai/dsh-ssh'
      config:
        host: devbox
        helper: /home/<user>/.dsh/ssh-helper/package/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
        helperHash: <sha256 of that file>
        workspace: /home/<user>
        launch: { kind: node-script, node: /usr/bin/node }
    - id: dsh-fs-ssh
      name: '@deepseek-ai/dsh-fs-ssh'
    - id: dsh-subprocess-ssh
      name: '@deepseek-ai/dsh-subprocess-ssh'
    - id: dsh-sandbox-ssh
      name: '@deepseek-ai/dsh-sandbox-ssh'
```

The base bundle's row ids are `fs-sandbox`, `subprocess` and `sandbox` (read from
`@deepseek-ai/dsh-base/cordis.patch.yml`; `fs-sandbox` is what owns the `fs` service).
With that composition the boot log is clean — no `did not activate`, no `pending` —
and a helper process appears on the remote host, which means the digest check passed and
the handshake succeeded.

Known limit: `session/create` still runs its **project-directory check** against the
host's local filesystem (`ENOENT … mkdir '/home/<user>'` on macOS), so a session cannot
be created with a remote-only `cwd`. The remote fs/subprocess/sandbox services are live
for tool execution; that workspace bootstrap step is a separate local path.

Earlier verification notes: the three providers install from the registry (0.1.6-alpha.1), the
packaged tree is 10.3 MiB and self-contained, and importing the staged helper resolves
every dependency (`IMPORT_OK`; the helper prints its own `dsh-ssh-sandbox:` entry
diagnostic). Deploying it to a host is the remaining step and writes to that host.

That arrangement runs the Harness (model transport, session storage) locally while
files and processes live on the remote — a local superagent with remote hands. It is
a deployment step (writes to the remote host), not something this plugin performs.

Local events are authoritative: when the local host has raised a waterfall of a given
name, a same-named waterfall from the remote leg is dropped (`events-skip-remote`).
Forwarding both let the last answer win, which is precisely how a host-owned concern
such as accounts or settings could show the remote's view. Honest status: this is a
defensive rule — in a live session with 56 groups and a remote session open, no
same-name collision was observed, so it is **not** evidence for the account symptom.

Hover and selection use an injected stylesheet (`#dsh-remote-host-rows`), because inline
styles cannot express `:hover`; the colours are the shipped row's own
`rgba(38, 49, 72, 0.06)`. Rows and groups carry `data-dsh-rh-row` so the rules apply to
exactly this list (67 tagged nodes: 11 session rows plus 56 groups in the live app).

### Metric parity with the shipped list

Measured from the shipped browser's computed styles, then matched exactly (sizes are
`em` against `--dsh-content-font-size`, so they still scale):

| property | shipped | this list |
|---|---|---|
| row font-size / weight | 14px / 400 | 14px / 400 |
| row padding | `0 8px 0 9px` | `0 8px 0 9px` |
| row gap | 6px | 6px |
| row radius | 12px | 12px |
| row height | 32px | 32px (`2.29em`) |
| row box | 264×32 | 264×32 |
| session indent | empty leading slot | empty leading slot |
| section header | 14px / 400 / rgb(129,133,140) | same |

The size complaint traced to the header, which had been 13px at weight 600: the shipped
header is **14px at weight 400**, i.e. larger and lighter. Secondary text (times, counts)
is also 14px there, only muted.

Sidebar typography follows the app's own tokens — `--dsh-content-font-size` and
`--dsh-content-font-size-secondary`, which the appearance settings write on
`document.body` — with `em` padding so rows grow with them. Hardcoded pixels looked
right at the default size and wrong at every other size.

The fetch wrapper only retries locally for calls it actually rerouted. A pass-through
request that fails has already reached the Host once; retrying it duplicated POSTs
(login, approvals, session writes). Everything that is not a remote-routed call now
goes straight to the original `fetch`, so unrelated traffic never touches this plugin.

An empty remote id set is never published (`publish-skip-empty`): it would classify
every remote session as local, which is how sessions appeared under 未分组 after a
while. The browser half also keeps the last known-good set and does not render
ungrouped rows while classification is unknown.

Rendering rules the sections list had to learn from live use:

* **Child sessions are not rows.** Subagent sessions (`parentSessionId` set) are not
  reachable from the sidebar natively and their history does not open here either, so
  they are filtered out. Archived ids from the workspace baseline are filtered too.
* **Sessions outside every workspace get their own collapsible 未分组 group.** Rendering
  them loose under 工作区 made collapsing a workspace look broken, because the loose
  rows stayed.
* **Remote groups mirror the remote's own workspaces.** The host publishes
  `__DSH_REMOTE_HOST_STATE__` (id set + workspaces with their session ids), so the
  remote section renders 工作区 → 会话 exactly like the local one, with the
  `<workspace> · ` row prefix stripped inside its own group. Remote groups start
  collapsed (a devbox has dozens of workspaces); local ones start expanded.
* **The disclosure control is a 16px SVG triangle.** Text glyphs at 11px were unreadable.

Trade-off: while enabled, this list is ours, so native-only affordances inside it
(pins, row context menus, drag ordering, the archive button) are not rendered. Turn
it off by removing the key.

Both halves learned the same lesson the hard way: a merged-stream consumer that
refetches on every frame closes a loop with the host's group refresh. The host now
skips emitting an unchanged baseline (comparing workspace ids and member counts) and
the browser half refetches only when the published remote id set grows, which took
`session/list` merges from dozens per page load down to three.

The remote section splits by **session identity**, not by workspace membership: the
host publishes the remote id set on `globalThis.__DSH_REMOTE_HOST_IDS__`, so a remote
session that no workspace record claims still lands under 远端工作区 instead of the
client's ungrouped bucket.

## Local superagent

`dsh-superagent` is a normal DSH bundle (`dsh.bundle.patch` + `dsh.client`), so it runs
locally as well. Verified install shape:

```sh
cd ~/.dsh/profiles/desktop
dsh-pnpm add "file:/Users/me/Workspace/dsh-superagent-local/dsh-superagent-<rev>.tgz"
# then add "dsh-superagent" to dsh.profile.bundles and configure it:
#   - id: dsh-superagent
#     config:
#       stateDir: /Users/me/.dsh/superagent-state   # must be absolute
```

Verified in an isolated profile: the bundle activates, creates
`<stateDir>/orchestrator.sqlite`, and adds a **Superagent** entry to the sidebar. A
relative or `~` `stateDir` is rejected by the plugin's config schema, and that failure
is only a warning — the host keeps running.

## Diagnostics

The mount answers a local report route that never reaches the remote:

```sh
# read the latest snapshot the browser shim published
curl -s --cookie "$(cat /tmp/cookie)" http://127.0.0.1:<port>/devbox/__dsh_remote_host__/report
```

The shim publishes `{ previousKeys, hasRpc, rpcKeys, hasFetch, hasCreateWebSocket,
streamBaseUrl, href, origin, events[] }` on install and after the list merge, so a
carrier mismatch is visible instead of guessed.

## Carrier support

`installConnection` prefers a fully decoded carrier (`transport.rpc`) over
`transport.fetch`, and the desktop shell may publish its carrier after page
scripts run. The shim therefore wraps whichever carrier exists, wraps `rpc` when
present, and re-adopts a carrier that appears late, so routing is installed in
either ordering.

* **SSH is a transport, not a second authority.** With `sshHost` set the mount dials
  `127.0.0.1:<free port>` (an `ssh -N -L` tunnel) while `Host` and the cookie keep
  naming the remote's own authority, so the credential stays valid. Verified with the
  direct upstream deliberately unreachable: 88 sessions came back through the tunnel.
* **A newly seen group starts collapsed.** The sidebar persists per-workspace
  expansion state; a devbox group the UI has never shown opens folded, so its
  rows appear after one click. This is stock client behaviour.
* **`未分组` is not ours.** It holds *local* sessions whose cwd is not part of any
  local workspace record — untouched by this plugin.

## Operational notes (learned the hard way)

* **Install it as a real dependency.** The desktop profile is owned by the app's
  plugin manager; a hand-made `node_modules` symlink outside `pnpm-lock.yaml` is
  dropped the next time the manager rewrites the profile (for example when you
  enable or disable another plugin in the UI). Install with the bundled pnpm:
  `pnpm add file:<repo>` in the profile directory, then let `setup.mjs` add the
  `dsh.profile.bundles` row and the config row. `dsh plugin --profile desktop`
  refuses to run for that profile by design.
* **Stream multiplexing is opt-in** (`streams: true`). Wrapping the mux socket
  is the only part that can stall every connection if a carrier behaves
  differently than a browser WebSocket, so the default leaves the shipped socket
  untouched and merges unary traffic only.
* **The shim is only injected when the mount registered.** A failed mount now
  degrades to a normal Harness instead of a page that depends on a missing route.
* **`link:`, not `file:`.** pnpm installs a `file:` dependency as a *copy*, so
  edits never reach the running app; `link:` keeps `node_modules/dsh-remote-host`
  a symlink to the working tree.
* **Strip the browser hop.** The remote request fence rejects a present
  `Origin` that is not its own authority (and any `sec-fetch-site: cross-site`).
  A same-origin `fetch` sends no `Origin`, so unary worked, while every
  WebSocket upgrade sends one — the relay therefore failed as an abnormal close
  (1006) and no remote stream ever opened. The mount now drops `origin`,
  `referer` and `sec-fetch-*` before forwarding.
* **The mux is caught at `WebSocket` too.** A desktop carrier resolves the mux
  URL itself and constructs `WebSocket` directly, never calling
  `transport.createWebSocket`; the shim therefore also patches the global
  constructor for the exact `/api/remote.mux` pathname and keeps every other
  socket native.
* **The shim is read on every index render**, so a page reload (Cmd+R) picks up a
  shim fix without restarting the Host. `lib/index.js` itself still needs a Host
  restart, because the module is imported once.
* **Host-side log**: `/tmp/dsh-remote-host.log` records apply, each registration,
  and the injection decision — the desktop shell keeps no live log of its own.

## Status

Verified against a real 0.2.2-rc.3 instance:

| Piece | State |
| --- | --- |
| mount + fence + cookie relay | verified (remote answers 200, 85 sessions) |
| mux upgrade through the mount | verified (`101`, opens) |
| shim injection into the index | verified |
| `session/list` merge + per-session routing | verified (unit) |
| `workspace/follow` merge (devbox group in 工作区) | verified (unit) |
| `$events` merge: one ready, remote waterfalls, answers routed back | verified (unit) |
| window filter + Workspace pruning | verified (unit); real remote baseline = 53 Workspaces |
| mux carrier URL contract (absolute URL form) | verified (unit): local + `/devbox` legs open |
| a real remote session snapshot streamed through the mount | verified against the live devbox host |

## Limits

* **Version coupling**: the remote must speak the same payloads (0.2.2-rc.3 on
  both ends here). The embedded data is the remote's own; the UI is this app's.
* **Credential**: `cookie.txt` is a full owner credential for the remote Host —
  treat it like an API key (mode `0600`, never synced). Re-run setup when it
  expires (30 days) or the remote credential store is recreated.
* **Reachability**: the relay speaks plain HTTP to the remote; use SSH
  forwarding or a trusted network when that hop is not already private.
* The mount is only as safe as the local Host's own access policy — it is
  admitted by the same connection fence as `/api`.
