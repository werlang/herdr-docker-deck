# docker-manager — Functional Specification

Status: **implemented** — see `mods/docker-manager/`. Requirement ids stay stable; `partly` items are tracked in `RECIPE.md`.

Requirement IDs (`DM-xx`) are stable: reference them from code comments, tests, and commits.

---

## 1. Goal

A native Herdr panel to see and operate everything Docker on the space's machine, without leaving Herdr or typing CLI commands:

- containers grouped by **Compose project → service → container**;
- lifecycle for whole projects **and** individual services (start, stop, restart, up, down, remove, rebuild);
- projects that come from a **Compose file** *or* a plain **Dockerfile**;
- quick **inspection** of a service (project, name, image, ports, volumes, networks, env, health…);
- **logs** and **shell** terminals in one right-click;
- **images, volumes, networks** management plus **hygiene** (disk usage, prune, volume backup/restore).

Inspiration: Microsoft's [vscode-containers](https://github.com/microsoft/vscode-containers) (Container Tools). See §10 for the parity table.

### Non-goals (v1)

- Registry browsing / push / login (Docker Hub, GHCR, ACR).
- Docker contexts switching, Kubernetes, Swarm, Podman-specific features.
- Compose/Dockerfile language services (IntelliSense, linting). `file-editor` already highlights the files.
- Dev Containers.
- Editing compose files from the panel (the panel opens them in `file-editor`).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Project** | A Compose project: containers sharing the `com.docker.compose.project` label, plus services declared in a discovered compose file that have no container yet. |
| **Service** | A Compose service (`com.docker.compose.service`). May have 0..n containers (replicas, one-off `run` containers). |
| **Dockerfile project** | A Dockerfile found in the space, plus the containers this mod started from it (label `herdr.docker-manager.source=<abs path>`). |
| **Standalone container** | A container with neither Compose nor `herdr.docker-manager.source` labels. |
| **Space root** | The folder the panel resolves for the active space (same rules as `file-editor`/`git-graph`: pinned location → focused cwd → `space.folder`). |
| **Machine** | The space's `machine` (`null` = this computer). Every Docker command runs there. |

---

## 3. Entry points

| ID | Requirement |
|---|---|
| DM-01 | A **Docker** top button sits next to **Files** and **Changes** in the tab bar (`tabs-ref`). Clicking it selects the `docker` child of the `panel-body` stack and shows the panel; clicking it again while active hides the panel (same toggle behaviour as Files/Changes). See INTEGRATION §1. |
| DM-02 | The panel remembers its last section and scroll per space, like the other panel children. |
| DM-03 | `herdr-app do pane.split --direction right --mod docker-manager` opens the same panel in a split pane. |
| DM-04 | Compose files and Dockerfiles opened in `file-editor` get a Docker action group in their tab header (§8). |
| DM-05 | A full-size **inspector tab** can be opened for any container/service (§6.2). |

---

## 4. Panel layout

```
┌──────────────────────────────────────────┐
│ ● Docker 29.7  [This space|All] ⟳  ⋯     │  toolbar (h 38, bg chrome)
│ [Containers][Images][Volumes][Networks][System] │  section switcher
│ 🔍 filter…                                │
├──────────────────────────────────────────┤
│ ▾ biofisqui-pelotas   ●4/4  compose.dev  │  project row
│     ▸ web     ● healthy  :3000→3000      │  service row
│     ▸ api     ● up 12h   :8080→8080      │
│ ▾ myapp (not created)  compose.yaml      │  discovered, dimmed
│     ○ db      not created                 │
│ ▾ Dockerfiles                             │
│     ▸ tools/Dockerfile   ● 1 running     │
│ ▾ Standalone                              │
│     ● redis-test   up 2d                  │
├──────────────────────────────────────────┤
│ Details: web (biofisqui-pelotas)    ⤢ ✕  │  inspector drawer (§6.1)
│ Image  biofisqui-web  Ports 3000→3000 …  │
└──────────────────────────────────────────┘
```

| ID | Requirement |
|---|---|
| DM-10 | **Toolbar**: engine status dot + version (green = reachable, red = daemon down, grey = CLI missing), scope toggle **This space / All** (§5.3), refresh button, `⋯` menu (Hygiene, Open Docker Desktop, Copy diagnostics). |
| DM-11 | **Section switcher**: Containers (default), Images, Volumes, Networks, System. Visual language matches `file-editor`/`git-graph` (24 px icon buttons, `theme()` colors, no hardcoded hex). |
| DM-12 | **Filter box** filters the current section by name, image, service, project, port (substring, case-insensitive). `Esc` clears it. |
| DM-13 | Rows are virtualized (`uniform_list`) so 500+ containers/images scroll smoothly. |
| DM-14 | Every row has a hover state, a selected state, and a right-click context menu (§7). Double-click on a container/service row opens the inspector tab. |
| DM-15 | **Engine unavailable** empty state: explains whether the CLI is missing or the daemon is unreachable, with **Retry** and, on macOS, **Start Docker Desktop** (`open -a Docker`). |
| DM-16 | Long or slow operations show a row spinner (native `.spin()`), never block the UI thread, and report failures with a toast containing the first lines of stderr plus a "Copy full error" action. |

---

## 5. Containers section

### 5.1 Grouping

| ID | Requirement |
|---|---|
| DM-20 | Top-level groups, in order: **Compose projects** (one row each, sorted: projects of the current space first, then by name), **Dockerfiles**, **Standalone**. Empty groups are hidden. |
| DM-21 | A project row shows: chevron, name, running/total count (`●3/4`), aggregate status color (all running = ok, some = warning, none = muted, any unhealthy/restarting = error), and the basename(s) of its compose file(s). A badge **"this space"** marks projects whose working dir or config files are inside the space root. |
| DM-22 | Under a project, one row per **service**: status dot, service name, health/status text (`healthy`, `up 12h`, `exited (1) 3m ago`, `not created`), published ports (`3000→3000`). |
| DM-23 | A service with more than one container (scale > 1, one-off `run` containers) expands to its containers (`web-1`, `web-2`, `run-a1b2`). A single-container service shows container actions directly on the service row. |
| DM-24 | **Discovered but not created** services (§5.2) appear dimmed with a hollow dot and status `not created`. A project with no container at all shows `(not created)` after its name. |
| DM-25 | **Mixed sources warning**: when containers of one project come from different `working_dir`s (two checkouts using the same project name), the project row shows a warning icon whose tooltip lists the folders. Actions use the folder of the space when it is one of them, otherwise ask which folder to use. |
| DM-26 | Expanded/collapsed state persists per project name in mod state. Projects of the current space start expanded; others start collapsed. |
| DM-27 | Status refreshes automatically (§9.2) and after every action. Rows never jump: sort order is stable between refreshes. |

### 5.2 Compose file and Dockerfile discovery

| ID | Requirement |
|---|---|
| DM-30 | The panel scans the space root (max depth 3, skipping `.git`, `node_modules`, `vendor`, `dist`, `build`, `.venv`) for compose files: `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`, and their `*.override.*` / `compose.<env>.yaml` variants. |
| DM-31 | Each compose file is resolved with `docker compose -f <file> config --format json` to get the project name and declared services (with `build`, `image`, `ports`, `volumes`, `networks`, `profiles`, `depends_on`). Results are cached by file path + mtime. A file that fails to resolve shows the project row with an error icon and the compose error as tooltip; it never breaks the rest of the list. |
| DM-32 | Override files in the same folder are combined the way Compose does by default (`compose.yaml` + `compose.override.yaml`). Other variants (`compose.dev.yaml`) are separate entries unless a running project's `config_files` label already ties them together. |
| DM-33 | Services in an inactive profile are listed under a collapsed "profiles" sub-row and are excluded from **Up** unless chosen explicitly. |
| DM-34 | Dockerfiles found by the same scan (`Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `Containerfile`) appear under **Dockerfiles**, labeled by their path relative to the space root. Their children are the containers started from them (label `herdr.docker-manager.source`). |

### 5.3 Scope

| ID | Requirement |
|---|---|
| DM-35 | **All** (default): every container on the machine, current-space projects first. |
| DM-36 | **This space**: only projects/Dockerfiles discovered in the space root or whose container `working_dir`/`config_files`/`source` label is inside it; standalone containers are hidden. The choice persists in mod state. |

---

## 6. Inspection

### 6.1 Inspector drawer (quick look)

| ID | Requirement |
|---|---|
| DM-40 | Selecting a service/container row opens a details drawer at the bottom of the panel (resizable, collapsible, closes with `Esc` or ✕). Selecting another row swaps its content without flicker. |
| DM-41 | The drawer shows, in compact label/value rows: **name**, **project**, **service**, **container ID** (short, copyable), **image** (+ short ID), **status/health** (+ last health check output when unhealthy), **started / created**, **restart policy**, **ports** (`host:port → container/proto`, host ports clickable → open `http://localhost:<port>`), **volumes/mounts** (type, source, destination, `ro`/`rw`; named volumes link to the Volumes section), **networks** (name, IP, aliases; link to Networks section), **command/entrypoint**, **compose files + working dir**, **depends_on**. |
| DM-42 | For a not-created service, the drawer shows the declared config from `docker compose config` (image/build, ports, volumes, networks, env keys) and an **Up this service** button. |
| DM-43 | Every value has copy-on-click with a toast. |

### 6.2 Inspector tab (full)

| ID | Requirement |
|---|---|
| DM-44 | `Inspect` (context menu, double-click, or ⤢ in the drawer) opens a Herdr tab `tab.new { mod: "docker-manager", props: { inspect: { kind, id, project?, service? } } }`, reused when the same target is already open. |
| DM-45 | Sub-views: **Overview** (DM-41 data), **Environment** (sorted table; values of keys matching `PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL` masked with a reveal toggle), **Mounts**, **Network**, **Labels**, **Stats** (CPU %, mem usage/limit, net I/O, block I/O, PIDs from `docker stats --no-stream`, refreshed every 3 s while visible), **Raw JSON** (pretty `docker inspect` output, copy button). |
| DM-46 | Header actions: Start/Stop/Restart, Logs, Shell, Refresh, Copy ID. The tab follows the container across recreation when it is a Compose service (re-resolves by project + service). |

---

## 7. Actions (context menus)

Menus are in-panel overlays clamped to the panel bounds, closed by any outside press or `Esc` (same pattern as `file-editor`/`git-graph`). Items that do not apply to the current state are **disabled with a reason tooltip**, not hidden, so the menu shape stays predictable. Destructive items are separated at the bottom and always confirm (§7.6).

### 7.1 Project (Compose)

| ID | Item | Command (simplified) |
|---|---|---|
| DM-50 | Up | `docker compose <target> up -d` |
| DM-51 | Up (build) | `docker compose <target> up -d --build` |
| DM-52 | Start / Stop / Restart | `docker compose <target> start\|stop\|restart` |
| DM-53 | Pull images | `docker compose <target> pull` |
| DM-54 | Build | `docker compose <target> build` |
| DM-55 | Logs (all services) | terminal: `docker compose <target> logs -f --tail 500` |
| DM-56 | Open compose file(s) | `file-editor` tab (falls back to copying the path when `file-editor` is missing) |
| DM-57 | Copy project name · Reveal folder in Files | — |
| DM-58 | **Down** | `docker compose <target> down` (confirm) |
| DM-59 | **Down + remove volumes** | `docker compose <target> down -v` (confirm, typed project name required) |

`<target>` = `-p <name>` plus `-f <file>` for each config file and `--project-directory <working_dir>` when the files exist; just `-p <name>` when they don't (enough for start/stop/restart/down/logs/rm). Up/build/pull with missing files are disabled with the reason "compose file not found".

### 7.2 Service

| ID | Item | Command |
|---|---|---|
| DM-60 | Start / Stop / Restart | `docker compose <target> start\|stop\|restart <svc>` |
| DM-61 | Up (this service) | `docker compose <target> up -d <svc>` |
| DM-62 | **Rebuild** | `docker compose <target> up -d --build --force-recreate --no-deps <svc>` |
| DM-63 | Recreate (no build) | `docker compose <target> up -d --force-recreate --no-deps <svc>` |
| DM-64 | Logs | terminal (§7.5) |
| DM-65 | Shell | terminal (§7.5); disabled unless running |
| DM-66 | Inspect | drawer / tab (§6) |
| DM-67 | Open port in browser | submenu with each published port |
| DM-68 | Copy container name / ID | — |
| DM-69 | **Remove** | `docker compose <target> rm -s -f <svc>` (confirm) |

### 7.3 Container (standalone, replica, or Dockerfile-run)

| ID | Item | Command |
|---|---|---|
| DM-70 | Start / Stop / Restart / Pause / Unpause | `docker start\|stop\|restart\|pause\|unpause <id>` |
| DM-71 | Logs · Shell · Inspect · Open port · Copy name/ID | as above, on the container ID |
| DM-72 | **Kill** | `docker kill <id>` (confirm) |
| DM-73 | **Remove** | `docker rm [-f] <id>` (confirm; `-f` offered when running) |

### 7.4 Dockerfile

| ID | Item | Command |
|---|---|---|
| DM-75 | Build image… | dialog: tag (default `<folder>:dev`), context (default: Dockerfile folder), build args. Runs `docker build -t <tag> -f <file> <context>` in a terminal. |
| DM-76 | Build & run… | dialog adds: container name (default `<folder>-dev`), ports (prefilled from `EXPOSE`), env file, run-once vs detached. Builds, then `docker run -d --name <n> --label herdr.docker-manager.source=<abs file> -p … <tag>`. Last used values are remembered per Dockerfile. |
| DM-77 | **Rebuild & replace** | Repeats the last Build & run: build, stop + remove the old container with the same source label and name, run again. Disabled until a Build & run happened. |
| DM-78 | Open Dockerfile | `file-editor` tab. |

### 7.5 Logs and shell terminals

| ID | Requirement |
|---|---|
| DM-80 | **Logs** opens a Herdr terminal via `terminal.open` named `logs: <service or container>` running `docker logs -f --tail 500 <id>` (or `docker compose <target> logs -f --tail 500 <svc>` for a service, so replicas are interleaved and recreated containers keep streaming). |
| DM-81 | **Shell** opens a terminal named `sh: <service or container>` running `docker exec -it <id> sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`. A setting chooses `auto` (bash, else sh — default), `sh`, `bash`, or a custom command. Containers without any shell show a toast instead of a dead terminal. |
| DM-82 | Placement: a new tab in the active space by default; holding `Alt` while choosing the item opens it as a split **down** of the focused pane. If a terminal for the same target is already open in this space, it is focused instead of duplicated. |
| DM-83 | Terminals open in the space's machine, so remote spaces get remote logs/shells. |

### 7.6 Confirmations and safety

| ID | Requirement |
|---|---|
| DM-85 | Every destructive action (remove, down, kill, prune, volume delete/restore) opens an in-panel confirmation dialog naming exactly what will be affected (e.g. "Removes 3 containers and network `myapp_default`"). |
| DM-86 | Actions that delete data (`down -v`, volume remove, volume restore, `prune --volumes`, `system prune -a`) require typing the target name (or `prune`) to enable the confirm button. |
| DM-87 | Commands are always argv arrays (never a shell string) and every name/ID passed to Docker is validated against Docker's naming rules first. |

---

## 8. File header actions (via `file-editor`)

| ID | Requirement |
|---|---|
| DM-90 | When `file-editor` shows a **compose file**, its tab header gets a Docker group: **Up ▾** split button (Up, Up (build), Down, Restart, Pull, Build) and a **Show in Docker** button. |
| DM-91 | When it shows a **Dockerfile**, the group is **Build ▾** (Build image, Build & run) and **Show in Docker**. |
| DM-92 | Up/Build actions run in a visible terminal split down of the editor (`terminal.open { place: "down", folder: <file dir>, argv }`), so output is visible next to the file. The buttons are disabled while the file has unsaved edits, with the tooltip "Save the file first". |
| DM-93 | **Show in Docker** opens the Docker panel and selects/expands the matching project or Dockerfile row. |
| DM-94 | The group appears only when the `docker-manager` mod is installed (live `mods/docker-manager/mod.json` exists), so `file-editor` stays publishable alone. |

---

## 9. Images, Volumes, Networks, System

### 9.1 Images

| ID | Requirement |
|---|---|
| DM-100 | List: repository:tag, short ID, size, created, containers using it (count). `<none>` images are grouped under a collapsible **Dangling** row. Sort by name / size / created. |
| DM-101 | Actions: **Run…** (dialog: name, ports, env, detached), **Inspect** (raw JSON + layers via `docker image history`), **Pull again** (tagged images only), **Tag…**, **Copy ID / name**, **Remove** (confirm; `--force` option when used by stopped containers; disabled with reason when used by running containers). |
| DM-102 | Section actions: **Prune dangling** (`docker image prune -f`), **Prune unused** (`docker image prune -a -f`, typed confirm), both previewing reclaimable size from `docker system df`. |

### 9.2 Volumes

| ID | Requirement |
|---|---|
| DM-105 | List: name (anonymous volumes collapsed under **Anonymous**), driver, owning project (`com.docker.compose.project` label), in-use flag (containers mounting it), size (loaded on demand, §9.4). |
| DM-106 | Actions: **Inspect**, **Browse** (terminal: `docker run --rm -it -v <vol>:/data -w /data alpine sh`, read-only mount by default), **Size**, **Backup…**, **Restore…**, **Clone…**, **Copy name**, **Remove** (typed confirm; disabled with reason while in use). |
| DM-107 | **Backup**: choose a destination folder (`pickFolder`, local machine; a path prompt on remote machines). Writes `<volume>-<YYYYMMDD-HHmmss>.tar.gz` with `docker run --rm -v <vol>:/data:ro -v <dest>:/backup alpine tar czf /backup/<file> -C /data .`. Shows progress spinner, then a toast with the file size and a "Reveal" action. Warns first when containers using the volume are running (backup of live data may be inconsistent) and offers to stop them during the backup. |
| DM-108 | **Restore**: choose a backup folder, pick one of its `*.tar.gz` files, typed confirm, then `docker run --rm -v <vol>:/data -v <dir>:/backup alpine sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* ; tar xzf /backup/<file> -C /data'`. Refused while any running container uses the volume. Restoring into a new volume name is allowed (creates it). |
| DM-109 | **Clone**: creates `<name>-copy` (editable) and copies data with an `alpine` helper container. |
| DM-110 | Section action: **Prune unused volumes** (`docker volume prune -f`, plus `--all` toggle for named volumes on Docker ≥ 23), typed confirm, preview of reclaimable size. |

### 9.3 Networks

| ID | Requirement |
|---|---|
| DM-115 | List: name, driver, scope, owning project, connected container count; built-in `bridge`/`host`/`none` pinned at the bottom and protected from removal. |
| DM-116 | Actions: **Inspect** (subnet, gateway, connected containers with IPs — clicking one selects it in Containers), **Disconnect container…**, **Copy name/ID**, **Remove** (confirm; disabled with reason while containers are connected). |
| DM-117 | Section action: **Prune unused networks** (`docker network prune -f`). |

### 9.4 System (hygiene)

| ID | Requirement |
|---|---|
| DM-120 | **Disk usage** cards from `docker system df`: Images, Containers, Local volumes, Build cache — each with total size, active count, reclaimable size/percent and a bar. |
| DM-121 | **Size check** button runs `docker system df -v --format json` (slow: seconds to tens of seconds; spinner + cancel) and shows the top 10 largest images, volumes, and containers (writable layer), each row linking to its section. Volume sizes learned here fill the Volumes list. |
| DM-122 | **Prune** checklist: stopped containers, dangling images, unused images, unused networks, unused volumes, build cache (`docker builder prune -f`, with "older than 7 days" option via `--filter until=168h`). The confirm dialog shows the expected reclaimable size per checked item; volumes and unused images require the typed confirm. Result toast reports `Total reclaimed space`. |
| DM-123 | **Engine info**: Docker/Compose versions, context, OS/arch, CPUs, memory, storage driver, root dir (from `docker info --format json`). |

---

## 10. vscode-containers parity

| vscode-containers | docker-manager | Note |
|---|---|---|
| Containers view grouped by Compose project | ✅ DM-20..27 | Adds not-created services and Dockerfile groups. |
| Start/Stop/Restart/Remove container | ✅ DM-70..73 | |
| Compose Up / Down / Restart / Logs on group | ✅ DM-50..59 | |
| Compose Up — select services | ✅ DM-61, DM-33 | Per-service Up from the tree. |
| View logs / Attach shell | ✅ DM-80..83 | Herdr terminals, not VS Code terminals. |
| Inspect (JSON document) | ✅ DM-40..46 | Structured drawer + raw JSON. |
| Open in browser (ports) | ✅ DM-67 | |
| Images: run, inspect, tag, pull, push, remove, prune | ✅ except push | Registries are a non-goal. |
| Volumes: inspect, remove, prune | ✅ + backup/restore/clone/browse | |
| Networks: inspect, remove, prune | ✅ | |
| System prune | ✅ DM-122 | Granular checklist with previews. |
| Registries, Contexts, Dev Containers, language services | ❌ | Non-goals (§1). |
| Explorer file context: Compose Up / Build image | ✅ DM-90..93 | Via `file-editor` header. |

---

## 11. Settings (mod state)

| Key | Default | Meaning |
|---|---|---|
| `scope` | `"all"` | `"all"` \| `"space"` (DM-35/36). |
| `shell` | `"auto"` | `"auto"` \| `"sh"` \| `"bash"` \| custom command (DM-81). |
| `logsTail` | `500` | Lines of history for logs terminals. |
| `terminalPlace` | `"tab"` | `"tab"` \| `"down"` default for logs/shell (DM-82). |
| `pollMs` | `3000` | Status refresh while the panel is shown (§DESIGN 4). |
| `helperImage` | `"alpine:3"` | Image used for volume backup/restore/clone/browse. |
| `dockerfileRuns` | `{}` | Last Build & run values per Dockerfile path (DM-76/77). |

---

## 12. Delivery phases

| Phase | Scope | Done when |
|---|---|---|
| **P1 — Read-only panel** | Mod skeleton, engine detection (DM-15), Containers section with grouping (DM-20..27), scope, inspector drawer (DM-40..43), polling. | Panel lists the real machine's containers grouped correctly, including the mixed-sources case, with unit tests for parsing/grouping. |
| **P2 — Lifecycle** | Context menus and actions for projects, services, containers (DM-50..73), confirmations (DM-85..87), logs/shell terminals (DM-80..83). | Every menu item works against a sample compose project; destructive items confirm. |
| **P3 — Files** | Compose/Dockerfile discovery (DM-30..34), not-created services, Dockerfile build/run (DM-75..78), `file-editor` header actions and `tabs-ref` button (INTEGRATION). | Opening a compose file shows working header actions; the Docker top button toggles the panel. |
| **P4 — Resources & hygiene** | Images, Volumes, Networks, System sections (DM-100..123), inspector tab (DM-44..46). | Backup then restore of a volume round-trips data; prune previews match the result. |
| **P5 — Publish** | `RECIPE.md` finalized, `preview.png`, preflight, topic `herdr-mod`. | `herdr-publish` preflight passes. |

---

## 13. Acceptance checklist

- [x] `herdr-app check mods/docker-manager` passes; `herdr-app status` has no errors.
- [x] Unit tests pass (`docker run --rm -v "$PWD":/w -w /w node:22-alpine node --test test/*.test.js`).
- [ ] Containers appear grouped by project → service → container; standalone and Dockerfile groups are correct.
- [ ] Each lifecycle action works for a whole project and a single service.
- [ ] Logs and shell terminals open from the context menu for services and containers.
- [ ] The inspector shows project, name, image, ports, volumes, networks, env (masked), labels, stats.
- [ ] Compose file and Dockerfile tabs in `file-editor` show working header actions.
- [ ] The Docker top button toggles the panel like Files/Changes.
- [ ] Images/volumes/networks can be listed, inspected, removed, pruned; a volume backup restores identically.
- [ ] Daemon stopped → friendly empty state; starting Docker recovers without reopening the panel.
