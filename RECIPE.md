# Docker Manager

A native Docker & Compose deck for Herdr: inspect and operate Compose projects, individual services, Dockerfiles, standalone containers, images, volumes, networks, and system disk usage from a docked sidebar panel or full-size inspector tabs.

![Docker Manager](preview.png)

## What you see

- **Top bar button** (`tabs-ref`): a **Docker** toggle button beside **Files** and **Changes** that opens or hides the `docker` slot in the right-hand panel.
- **Panel toolbar** (`38px`, `t.chrome`): live Docker engine status dot + version, **This space / All** scope switcher, refresh button, and `⋯` hygiene menu.
- **Section strip** (`32px`): **Containers**, **Images**, **Volumes**, **Networks**, and **System**, plus an instant filter bar.
- **Containers tree**:
  - **Compose projects** with aggregate running count (`●4/4`), compose file basename, **"this space"** badge, and expandable service rows.
  - **Service rows** with health/state dot, service name, status (`healthy`, `up 12h`, `not created`), and clickable published ports (`:3000→3000`).
  - **Dockerfiles** discovered in the active workspace and their containers.
  - **Standalone** containers.
- **Inspector drawer**: a collapsible bottom pane (`220px`) displaying the selected service or container's project, image, container ID, health log, ports, mounts, networks, and compose files.
- **Inspector tab**: a full-pane Herdr tab with **Overview**, **Environment** (secrets masked by default), **Mounts**, **Network**, **Labels**, **Stats**, and **Raw JSON**.
- **File header actions** (`file-editor`): opening any `compose*.yaml` or `Dockerfile` adds **Up ▾** / **Build ▾** and **Show in Docker** controls to the editor toolbar.

## How it behaves

- Clicking a service or container selects it and updates the bottom **Inspector drawer**; double-clicking opens a dedicated **Inspector tab**.
- Right-clicking any row opens an in-panel context menu clamped to the panel bounds:
  - **Compose project**: `Up`, `Up (build)`, `Start`, `Stop`, `Restart`, `Pull`, `Build`, `Logs (all services)`, `Open compose file`, `Down`, `Down + remove volumes`.
  - **Service**: `Start`, `Stop`, `Restart`, `Up (this service)`, `Rebuild` (`up -d --build --force-recreate --no-deps`), `Recreate`, `Logs`, `Shell`, `Inspect`, `Open port in browser`, `Remove`.
  - **Dockerfile**: `Build image…`, `Build & run…`, `Rebuild & replace`, `Open Dockerfile`.
  - **Volume**: `Inspect`, `Browse` (read-only Alpine shell), `Size`, `Backup…` (`.tar.gz`), `Restore…`, `Clone…`, `Remove`.
  - **Image / Network**: `Inspect`, `Run` / `Disconnect`, `Prune`, `Remove`.
- Choosing **Logs** or **Shell** opens a Herdr terminal tab (`Alt`-click splits down) running `docker compose logs -f` or `docker exec -it <id> bash/sh`, reusing an existing terminal when already open in the space.
- Destructive actions always confirm; data-destroying actions (`down -v`, volume remove/restore, `prune -a`) require typing the target name.

## Built from

- **Mod**: `mods/docker-manager/main.js`, `mods/docker-manager/docker-logic.js`, `mods/docker-manager/mod.json`.
- **Layout block**: `{ "id": "docker", "type": "block", "content": { "mod": "docker-manager" } }` inside `panel-body`.
- **Herdr APIs**: `exec("docker", ...)`, `spaces()`, `panes()`, `terminals()`, `focused()`, `layout()`, `run("terminal.open" | "tab.new" | "layout.select" | "layout.show")`, `pickFolder()`, `readTextFile()`, `watchFolder()`, `shared()`, `setShared()`, `notify()`, `theme()`.
- **External CLI**: `docker` and `docker compose` on the active space's machine (local or remote SSH).

## Watch out

- Always pass `--no-trunc` to `docker container ls --format '{{json .}}'` so long `com.docker.compose.project.config_files` labels are never truncated mid-path.
- `Labels` in `docker container ls` is a comma-separated string where `config_files` itself contains commas; split only on commas followed by `<key>=`.
- Pause the 3s status poll whenever the Docker panel is hidden in the `panel-body` stack so background spaces cost zero CPU/processes.
- Volume backup and restore mount the target volume into a disposable `alpine:3` container; warn before backing up a volume attached to a running database container and refuse restore while any running container mounts the target volume.

## Done when

- `herdr-app check mods/docker-manager` passes with zero errors.
- `docker run --rm -v "$PWD":/work -w /work node:22-alpine node --test test/` passes all unit tests, and `test/mod-safety.test.js` fails if a chained element method does not exist in `gpui-kit.d.ts`.
- Running and stopped containers appear grouped under their Compose project and service, and uncreated services from workspace Compose files appear as `not created`.
- Project and single-service lifecycle actions (`Up`, `Down`, `Start`, `Stop`, `Restart`, `Rebuild`, `Remove`) work from the right-click menu.
- **Logs** and **Shell** open working Herdr terminals for the chosen service or container.
- Images, volumes, and networks can be inspected and pruned, and volume backup/restore round-trips data cleanly.
- The inspector tab (`props.inspect`) resolves its target from `props()` on a timer, never from `render()`, and follows a Compose service across recreation.

## Not in this repository yet

The top **Docker** button in `tabs-ref` and the compose/Dockerfile header actions in `file-editor` live in sibling mods. `docs/INTEGRATION.md` specifies both; each is a separate change so every mod stays publishable alone.

