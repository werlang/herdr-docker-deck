# herdr-docker-deck

Source of truth for the `docker-manager` Herdr app mod (`mods/docker-manager/`), published as **Docker Manager**: a native GPUI Docker & Compose management panel and tabbed resource inspector inspired by Microsoft's [`vscode-containers`](https://github.com/microsoft/vscode-containers).

## Specifications & Design Docs

- [`docs/SPEC.md`](docs/SPEC.md) — Functional requirements (`DM-01`..`DM-123`), UI layout, right-click action matrices, volume backup/restore, system hygiene, and `vscode-containers` parity table.
- [`docs/DESIGN.md`](docs/DESIGN.md) — Technical architecture, dual-mode GPUI `View` design, `docker-logic.js` pure functions, exact `docker` / `docker compose` CLI JSON contracts, label parsing, and unit test plan.
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — Integration specifications for the personal layout (`#panel-body` stack), `herdr-tab-actions` (`tabs-ref` top **Docker** button), and `herdr-file-editor` (Compose & `Dockerfile` header actions).

---

## Rule: Always Update the Herdr Live Folder

Herdr reads active mods from `~/.config/herdr-app/mods/<name>`. After any code change in this repository, run:

```sh
./sync.sh
```

The script copies `mods/docker-manager` to `~/.config/herdr-app/mods/docker-manager` and runs `herdr-app check`. Never edit files in `~/.config/herdr-app/mods/` directly.

---

## Architecture Overview

`docker-manager` operates in two modes based on `props().inspect`:

1. **Docker Panel Mode (`!props().inspect`)**:
   - Docks in the right-hand `panel-body` stack (`"id": "docker"`) toggled by the top **Docker** button in `tabs-ref` (alongside **Files** and **Changes**), or opens in any split pane.
   - Sections: **Containers** (grouped by Compose Project → Service → Container, plus **Dockerfiles** and **Standalone**), **Images**, **Volumes**, **Networks**, and **System** (disk usage, size check, granular prune).
   - Right-clicking any project, service, container, Dockerfile, image, volume, or network opens `#docker-context-menu` with lifecycle actions (`Up`, `Down`, `Start`, `Stop`, `Restart`, `Rebuild`, `Recreate`, `Remove`), **Logs** (`docker compose logs -f` / `docker logs -f` in a Herdr terminal), and **Shell** (`docker exec -it ... sh/bash` in a Herdr terminal).
   - Selecting a service or container opens a collapsible bottom **Inspector Drawer** showing project, service, image, health, published ports (clickable to open in browser), volumes/mounts, networks, and compose config paths.

2. **Inspector Tab Mode (`Boolean(props().inspect)`)**:
   - Opens a full-size Herdr tab (`tab.new`) for deep inspection of a service, container, image, volume, or network.
   - Sub-views: **Overview**, **Environment** (with automatic secret masking and reveal toggle), **Mounts**, **Network**, **Labels**, **Stats** (live CPU/Memory/IO via `docker stats --no-stream`), and **Raw JSON**.

---

## GPUI & Runtime Invariants

- **No `null` or `undefined` in `.child()`**: Always use `.when(cond, el => el.child(...))`.
- **No sync `cx` across `await`**: Read synchronous event properties first, then wrap async work in `cx.spawn(async (cx) => ...)`.
- **Argv-only execution**: Always invoke `exec("docker", argv, { cwd, on: machine })` with validated identifiers; never interpolate container/volume/project names into a shell string.
- **No local Node.js assumption**: Run unit tests inside a Docker container:
  ```sh
  docker run --rm -v "$PWD":/work -w /work node:22-alpine node --test test/
  ```
- **Mod independence**: Never import assets from other custom mods (`tabs-ref`, `file-editor`). Keep all icons in `mods/docker-manager/icons/` or reference shipped Herdr icons.
