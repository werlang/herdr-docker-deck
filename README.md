# Herdr Docker Manager (`docker-manager`)

A native GPUI **Docker & Compose Manager** mod for Herdr, inspired by Microsoft's [`vscode-containers`](https://github.com/microsoft/vscode-containers). Inspect and control Compose projects, individual services, standalone containers, Dockerfiles, images, volumes, networks, and system disk hygiene without leaving your workspace.

> **Status**: Specification & Architecture phase. See [`docs/SPEC.md`](docs/SPEC.md), [`docs/DESIGN.md`](docs/DESIGN.md), and [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

---

## Key Features

- **Compose-First Container Tree**:
  - Automatically groups running and stopped containers by **Compose Project → Service → Container (replica)**.
  - Discovers `compose.yaml` / `docker-compose.yml` files and `Dockerfile`s in the active space, surfacing uncreated services (`not created`) alongside live containers.
  - Scope toggle between **This space** and **All** containers on the machine.
- **Project, Service & Container Lifecycle**:
  - Right-click any Compose project or individual service to run **Up**, **Up (build)**, **Start**, **Stop**, **Restart**, **Rebuild** (`up -d --build --force-recreate --no-deps <service>`), **Recreate**, **Pull**, **Down**, or **Remove**.
  - Build and run plain `Dockerfile`s with remembered tags, port mappings, and one-click **Rebuild & replace**.
- **One-Click Logs & Shell Terminals**:
  - Open streaming `docker compose logs -f` or `docker logs -f` in a dedicated Herdr terminal tab (or `Alt`-click to split down).
  - Attach an interactive shell (`docker exec -it <container> bash/sh`) directly from the right-click menu.
- **Quick Inspector Drawer & Full Inspector Tabs**:
  - Click any service or container to inspect its project, name, image, health status, clickable host ports, volume mounts, networks, and dependencies in a bottom drawer.
  - Double-click (or choose **Inspect**) to open a full Herdr tab with **Overview**, **Environment** (with secret masking), **Mounts**, **Network**, **Labels**, **Live Stats**, and **Raw JSON**.
- **Editor Header Actions (`file-editor` integration)**:
  - Opening any `compose*.yaml` or `Dockerfile` in `file-editor` displays contextual **Up ▾** / **Build ▾** and **Show in Docker** actions right in the file header bar.
- **Images, Volumes, Networks & System Hygiene**:
  - Inspect, tag, pull, run, and prune images.
  - Browse volume contents in a read-only helper container, check volume sizes, **Backup** volumes to `.tar.gz`, **Restore** from archive, or **Clone** volumes.
  - Inspect network subnets and connected container IPs.
  - View `docker system df` usage cards, run a detailed **Size check** (`docker system df -v`), and execute granular **System Prune** with reclaimable space previews.

---

## Documentation Index

| Document | Description |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | Full functional specification (`DM-01`..`DM-123`), UI wireframes, context menu tables, confirmation rules, and `vscode-containers` comparison. |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Technical design, `main.js` + `docker-logic.js` architecture, exact `docker` CLI JSON/NDJSON formats, and unit test suite plan. |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | Integration specs for the layout's `panel-body` stack, the top **Docker** button in `tabs-ref`, and file header actions in `file-editor`. |
| [`RECIPE.md`](RECIPE.md) | Herdr mod recipe (`What you see`, `How it behaves`, `Built from`, `Watch out`, `Done when`). |

---

## Layout Wiring

Add the `docker` block to the `panel-body` stack in your personal layout (`~/.config/herdr-app/layouts/<name>.json`):

```json
{
  "id": "docker",
  "type": "block",
  "content": {
    "mod": "docker-manager"
  }
}
```

Or open `docker-manager` directly in a split pane:

```sh
herdr-app do pane.split --direction right --mod docker-manager
```
