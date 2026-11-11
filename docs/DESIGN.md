# docker-manager — Technical Design & CLI Contracts

Status: **implemented** — `mods/docker-manager/main.js` + `docker-logic.js`.

---

## 1. Repository & Module Layout

```text
herdr-docker-deck/
├── AGENTS.md
├── README.md
├── RECIPE.md
├── sync.sh
├── .gitignore
├── docs/
│   ├── SPEC.md
│   ├── DESIGN.md
│   └── INTEGRATION.md
├── mods/
│   └── docker-manager/
│       ├── mod.json
│       ├── main.js            # GPUI View class (Panel mode + Inspector Tab mode)
│       ├── docker-logic.js    # Pure, zero-dependency parsing, grouping, argv builders
│       └── icons/             # Tinted SVGs (container, compose, whale,layers, volume, network, play, stop, restart, terminal, logs, trash, broom...)
└── test/
    └── docker-logic.test.js   # Unit tests (run in node:22-alpine container)
```

### Why a two-file split (`main.js` + `docker-logic.js`)?

Following `file-editor` (`file-logic.js`) and `git-graph` (`git-logic.js`), keeping all string parsing, label extraction, Compose/Dockerfile discovery rules, project/service/container tree construction, secret env masking, and CLI `argv` builders inside `docker-logic.js` with zero `gpui-kit` or `herdr` imports lets `node --test` verify 100% of the domain logic deterministically without a running Herdr window or Docker daemon.

---

## 2. Dual-Mode View Architecture

`mods/docker-manager/main.js` exports a single `View` subclass whose mode is chosen from `props()`:

1. **Docker Panel Mode (`!props()?.inspect`)**:
   - Mounted inside the layout's `#panel-body` stack under `"id": "docker"` (or opened in a split pane).
   - Renders:
     - Top toolbar (`h(38)`, `bg(t.chrome)`): engine status badge, **This space / All** scope toggle, refresh button (its icon spins while `refreshing`), and `⋯` menu.
     - Section bar (`h(32)`): `Containers` | `Images` | `Volumes` | `Networks` | `System` + inline filter input.
     - Virtualized main list (`uniform_list` with `Scrollbar.vertical`).
     - Collapsible bottom **Inspector Drawer** (`#docker-inspector-drawer`, default height `220px`, resizable) when a service or container row is selected (`DM-40..43`).
     - In-panel overlays: `#docker-context-menu` + `#docker-context-backdrop`, confirmation modals (`#docker-confirm-dialog`), and parameter modals (`#docker-run-dialog`, `#docker-backup-dialog`).

2. **Inspector Tab Mode (`Boolean(props()?.inspect)`)**:
   - Opened via `run("tab.new", { name, mod: "docker-manager", props: { folder, on, inspect: { kind, id, project, service } } })`.
   - Renders a full-pane header bar (`h(38)`, `bg(t.chrome)`) with status dot, target breadcrumb (`project / service` or container/image/volume/network name), lifecycle buttons (`Start`, `Stop`, `Restart`, `Rebuild`, `Logs`, `Shell`, `Refresh`), and a sub-view switcher (`Overview` | `Environment` | `Mounts` | `Network` | `Labels` | `Stats` | `Raw JSON`).
   - Re-resolves Compose services by `(project, service)` if the underlying container ID changes after a recreate or rebuild (`DM-46`).

---

## 3. Space Location & Machine Resolution

`resolveDockerContext( { props, spaces, panes, terminals, focused, shared, currentRoot } )` in `docker-logic.js` follows the workspace standard established by `file-editor` and `git-graph`:

1. Explicit `props.folder || props.cwd` and `props.on`.
2. Active space (`spaces().find(s => s.active)`):
   - `machine = space.machine ?? null`
   - If the space is pinned (`shared("spaces.pinned_locations")?.[space.id]`): use that pinned path.
   - Otherwise, if `focused()?.space === space.id && focused()?.cwd`: use `focused().cwd`.
   - Otherwise, a terminal in the active tab of the active space (`panes()` → `terminals()`), falling back to `space.folder`.
3. Every `exec("docker", argv, { cwd, on: machine, timeout })` passes `on: machine` so remote SSH spaces transparently manage the remote machine's Docker daemon (`DM-83`).

---

## 4. Docker CLI Contracts & Parsing

All background commands use `exec("docker", argv, { cwd, on, timeout })` — never shell interpolation (`DM-87`).

### 4.1 Engine Probe & Fast Status Poll (`Containers` + `Compose`)

Run in parallel on init, on space switch, when the panel transitions from hidden to visible, after any action, and every `pollMs` (`3000ms` default) while visible:

| Purpose | `docker` argv | Output format |
|---|---|---|
| Containers list | `["container", "ls", "-a", "--no-trunc", "--format", "{{json .}}"]` | NDJSON (one JSON object per line) |
| Compose projects | `["compose", "ls", "--all", "--format", "json"]` | JSON array: `[{ Name, Status, ConfigFiles }]` |

#### Why `--no-trunc` on `container ls`?

Without `--no-trunc`, `docker ps --format '{{json .}}'` truncates the `Labels` string on containers with long Compose file paths (verified on Docker 29.7: `com.docker.compose.project.config_files` and `desktop.docker.io/binds/...` get cut mid-key). Passing `--no-trunc` preserves the full comma-separated `Labels` field and full container ID.

#### Label Parsing Note

In `docker container ls --format '{{json .}}'`, `Labels` is a comma-separated `k=v` string where values themselves can contain commas — most notably `com.docker.compose.project.config_files=/path/a.yaml,/path/b.yaml`.
`parseContainerLabels(rawLabels)` in `docker-logic.js` splits only on commas that precede a valid label key token (`/[a-z0-9_.-]+=/i`), preserving multi-file paths in `com.docker.compose.project.config_files` intact.

Key labels extracted per container:
- `com.docker.compose.project` → project name
- `com.docker.compose.service` → service name
- `com.docker.compose.container-number` → replica number (`1`, `2`, …)
- `com.docker.compose.oneoff` → `"True"` for `docker compose run` containers
- `com.docker.compose.project.working_dir` → working dir at container creation
- `com.docker.compose.project.config_files` → comma-separated absolute paths
- `com.docker.compose.depends_on` → declared dependencies
- `herdr.docker-manager.source` → absolute Dockerfile path for containers started by this mod (`DM-34`)

### 4.2 Compose & Dockerfile Workspace Discovery (`DM-30..34`)

When `root` changes or `watchFolder(root)` fires:

1. Scan `root` up to depth 3:
   - Local spaces (`machine === null`): `exec("find", [root, "-maxdepth", "3", "(", "-name", ".git", "-o", "-name", "node_modules", "-o", "-name", "vendor", "-o", "-name", "dist", "-o", "-name", "build", "-o", "-name", ".venv", ")", "-prune", "-o", "-type", "f", "(", "-name", "*compose*.y*ml", "-o", "-name", "Dockerfile*", "-o", "-name", "*.Dockerfile", "-o", "-name", "Containerfile", ")", "-print"])`.
2. Group discovered Compose files by folder:
   - Pair `compose.yaml`/`compose.yml`/`docker-compose.yaml`/`docker-compose.yml` automatically with its `*.override.*` sibling (`DM-32`).
   - Keep named environment files (`compose.dev.yaml`, `compose.local.yaml`, `compose.test.yaml`) as distinct entries unless an active project's `config_files` label already combines them.
3. Resolve declared services per Compose target:
   - `exec("docker", ["compose", ...fileFlags, "config", "--format", "json"], { cwd: fileDir, on: machine })`
   - Cache result by `(filePath, mtime)` so unchanged files are parsed at most once per session.

### 4.3 Tree Merge Algorithm (`buildContainerTree`)

`buildContainerTree({ containers, composeLs, discoveredCompose, discoveredDockerfiles, spaceRoot, scope })` in `docker-logic.js`:

1. **Compose Projects**:
   - Keyed by `projectName`.
   - Merges containers carrying `com.docker.compose.project === projectName`, rows from `docker compose ls`, and discovered Compose configs from the workspace.
   - Records `workingDirs: Set<string>` and `configFiles: Set<string>` across all containers of the project. If `workingDirs.size > 1`, sets `mixedSources: true` (`DM-25`).
   - Sets `inSpace = true` if any `workingDir` or `configFile` is equal to or inside `spaceRoot`.
   - Within each project, merges running/stopped containers by `serviceName` with declared services from `compose config`:
     - Services present in `compose config` with 0 containers get a synthetic `status: "not-created"` service node (`DM-24`).
     - Services in an inactive Compose profile without containers go under the project's `inactiveProfiles` group (`DM-33`).
2. **Dockerfile Projects**:
   - Matches containers with label `herdr.docker-manager.source` to discovered Dockerfiles (plus any running container with that label outside the workspace when `scope === "all"`).
3. **Standalone Containers**:
   - Any remaining container without `com.docker.compose.project` or `herdr.docker-manager.source`. Hidden when `scope === "space"` (`DM-36`).
4. **Stable Sorting (`DM-27`)**:
   - Compose projects: `inSpace` first, then alphabetical by project name.
   - Services within a project: declaration order from `compose config` when available, then alphabetical.
   - Replicas within a service: numeric by `container-number`.

### 4.4 Deep Inspection (`DM-40..46`)

When a container row is selected for the drawer or opened in an Inspector Tab:

- `docker inspect --format '{{json .}}' <containerId>`
- Extracted into a normalized `ContainerInspect` object by `normalizeContainerInspect(raw)`:
  - `id`, `shortId`, `name`, `project`, `service`, `image`, `imageId`, `created`, `startedAt`, `finishedAt`, `state` (`status`, `running`, `paused`, `restarting`, `oomKilled`, `dead`, `exitCode`, `error`), `health` (`status`, `failingStreak`, `lastLog`), `restartPolicy` (`name`, `maximumRetryCount`), `ports` (`[{ hostIp, hostPort, containerPort, proto }]`), `mounts` (`[{ type, name, source, destination, rw, driver }]`), `networks` (`[{ name, ipAddress, gateway, macAddress, aliases, networkId }]`), `env` (`[{ key, value, secret }]`), `entrypoint`, `cmd`, `workingDir`, `labels`, `composeFiles`, `dependsOn`.
- Secret masking (`DM-45`): `isSecretEnvKey(key)` matches `/(?:^|_)(?:PASS(?:WORD|PHRASE)?|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|AUTH|CREDENTIAL|CLIENT_SECRET|DATABASE_URL|REDIS_URL|CONNECTION_STRING)(?:$|_)/i`.
- Live stats in Inspector Tab (`Stats` sub-view, `DM-45`):
  - `docker stats --no-stream --format '{{json .}}' <containerId>` every 3s while the tab's `Stats` sub-view is visible.

### 4.5 Lifecycle & Action `argv` Builders (`docker-logic.js`)

`buildComposeArgs(target, subcommandArgs)`:
- When `target.configFiles` exist on disk:
  `["compose", "-p", target.project, "--project-directory", target.workingDir, ...target.configFiles.flatMap(f => ["-f", f]), ...subcommandArgs]`
- When config files are missing/unavailable (e.g., containers started from a deleted temp dir):
  `["compose", "-p", target.project, ...subcommandArgs]` (allowed for `start`, `stop`, `restart`, `down`, `logs`, `rm`; `up`, `build`, `pull` are disabled in the UI per `DM-50..59`).

| Action | `argv` | Execution Mode |
|---|---|---|
| Project Up | `[...composeTarget, "up", "-d"]` | Background `exec` (or terminal if from file header `DM-92`) |
| Project Up (build) | `[...composeTarget, "up", "-d", "--build"]` | Terminal (`terminal.open`) or background `exec` |
| Project Start / Stop / Restart | `[...composeTarget, "start" \| "stop" \| "restart"]` | Background `exec` |
| Project Down | `[...composeTarget, "down"]` | Background `exec` (after confirm `DM-58`) |
| Project Down + Volumes | `[...composeTarget, "down", "-v"]` | Background `exec` (after typed confirm `DM-59`) |
| Service Start / Stop / Restart | `[...composeTarget, "start" \| "stop" \| "restart", service]` | Background `exec` |
| Service Up | `[...composeTarget, "up", "-d", service]` | Background `exec` |
| Service Rebuild (`DM-62`) | `[...composeTarget, "up", "-d", "--build", "--force-recreate", "--no-deps", service]` | Background `exec` + progress toast (or terminal) |
| Service Recreate (`DM-63`) | `[...composeTarget, "up", "-d", "--force-recreate", "--no-deps", service]` | Background `exec` |
| Service Remove (`DM-69`) | `[...composeTarget, "rm", "-s", "-f", service]` | Background `exec` (after confirm) |
| Service Logs (`DM-80`) | `["docker", ...composeTarget, "logs", "-f", "--tail", String(tail), service]` | `terminal.open` |
| Container Logs (`DM-80`) | `["docker", "logs", "-f", "--tail", String(tail), containerId]` | `terminal.open` |
| Container Shell (`DM-81`) | `["docker", "exec", "-it", containerId, "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"]` | `terminal.open` |

### 4.6 Images, Volumes, Networks & Hygiene Commands

| Resource / Operation | `docker` argv |
|---|---|
| List images (`DM-100`) | `["image", "ls", "-a", "--no-trunc", "--format", "{{json .}}"]` |
| Image history (`DM-101`) | `["image", "history", "--no-trunc", "--format", "{{json .}}", imageId]` |
| Prune dangling images (`DM-102`) | `["image", "prune", "-f"]` |
| Prune unused images (`DM-102`) | `["image", "prune", "-a", "-f"]` |
| List volumes (`DM-105`) | `["volume", "ls", "--format", "{{json .}}"]` |
| Volume inspect (`DM-106`) | `["volume", "inspect", "--format", "{{json .}}", volumeName]` |
| Browse volume (`DM-106`) | `["docker", "run", "--rm", "-it", "-v", `${volumeName}:/data:ro`, "-w", "/data", helperImage, "sh"]` (via `terminal.open`) |
| Backup volume (`DM-107`) | `["run", "--rm", "-v", `${volumeName}:/data:ro`, "-v", `${destDir}:/backup`, helperImage, "tar", "czf", `/backup/${archiveName}`, "-C", "/data", "."]` |
| Restore volume (`DM-108`) | `["run", "--rm", "-v", `${volumeName}:/data`, "-v", `${srcDir}:/backup:ro`, helperImage, "sh", "-c", `rm -rf /data/* /data/..?* /data/.[!.]* && tar xzf "/backup/${archiveName}" -C /data`]` |
| Clone volume (`DM-109`) | `["volume", "create", destVolume]` then `["run", "--rm", "-v", `${srcVolume}:/from:ro`, "-v", `${destVolume}:/to`, helperImage, "sh", "-c", "cp -a /from/. /to/"]` |
| List networks (`DM-115`) | `["network", "ls", "--no-trunc", "--format", "{{json .}}"]` |
| Network inspect (`DM-116`) | `["network", "inspect", "--format", "{{json .}}", networkId]` |
| Disk usage fast (`DM-120`) | `["system", "df", "--format", "{{json .}}"]` |
| Disk usage verbose (`DM-121`) | `["system", "df", "-v", "--format", "json"]` |
| Builder prune (`DM-122`) | `["builder", "prune", "-f", ...(olderThan7d ? ["--filter", "until=168h"] : [])]` |
| Engine info (`DM-123`) | `["info", "--format", "{{json .}}"]` |

---

## 5. Polling, Concurrency & GPUI Invariants

1. **Visibility-Aware Polling**:
   - The fast poll (`3s`) runs only when the Docker panel is actually shown (`!panel.hidden && body.active === "docker"`) or when the mod is mounted as a visible split/tab pane. While hidden in the stack, background polling pauses completely, and transitioning from hidden → visible triggers an immediate refresh.
2. **Single-Flight Refresh Token**:
   - A `refreshSeq` counter guards async refreshes; if the space or machine switches mid-flight, stale responses are dropped.
3. **Per-Target Busy State**:
   - In-flight lifecycle actions record `this.busyTargets.set(targetKey, actionLabel)` so only the affected row shows a spinning indicator (`.spin(900)`) while the rest of the panel remains interactive (`DM-16`).
4. **GPUI Safety Invariants**:
   - Never pass `null` or `undefined` to `.child()` — always guard optional UI elements with `.when(cond, el => el.child(...))`.
   - Never hold a synchronous event `cx` across an `await` — extract event coordinates/props synchronously, then enter `cx.spawn(async (cx) => { ...; cx.notify(); })`.
   - Clamp context menus inside `panelBounds` measured on mouse move, with a full-pane transparent backdrop to close on outside click.

---

## 6. Unit Test Plan (`test/docker-logic.test.js`)

Because the host machine does not install Node.js locally, unit tests execute inside a container:

```sh
docker run --rm -v "$PWD":/work -w /work node:22-alpine node --test test/*.test.js
```

Test suites in `test/docker-logic.test.js`:
1. **`parseContainerLabels`**: preserves commas inside `com.docker.compose.project.config_files` and bind-mount labels; handles empty labels and values containing `=`.
2. **`buildContainerTree`**:
   - groups Compose containers by `project` → `service` → `container`;
   - synthesizes `not-created` service rows from `compose config` output;
   - separates inactive profile services;
   - flags `mixedSources` when containers of one project report different `working_dir` paths;
   - groups `herdr.docker-manager.source` containers under their Dockerfile;
   - filters by `scope: "space"` vs `scope: "all"`.
3. **`buildComposeArgs` & Action Availability**:
   - includes `-p`, `--project-directory`, and all `-f` flags when config files exist;
   - falls back to `-p <project>` when config files are missing and disables `up`/`build`/`pull` with reason;
   - builds exact `argv` arrays for service `rebuild`, `recreate`, `logs`, `shell`, volume `backup`/`restore`/`clone`.
4. **`normalizeContainerInspect` & `isSecretEnvKey`**:
   - extracts ports, mounts, networks, health log, and masks secret environment variables while leaving ordinary variables readable.
5. **Input Validation (`validateDockerIdentifier`)**:
   - rejects shell metacharacters, path traversal, or empty names before any CLI call (`DM-87`).
6. **File Classification (`classifyDockerFile`)**:
   - recognizes `compose.yaml`, `compose.dev.yaml`, `docker-compose.yml`, `Dockerfile`, `Dockerfile.dev`, `app.Dockerfile`, `Containerfile`, and rejects unrelated YAML files.
