# Herdr Docker Manager (`docker-manager`)

A native GPUI **Docker & Compose Manager** mod for Herdr, inspired by Microsoft's [`vscode-containers`](https://github.com/microsoft/vscode-containers). Inspect and control Compose projects, individual services, standalone containers, Dockerfiles, images, volumes, networks, and system disk hygiene without leaving your workspace.

> **Status**: implemented. `mods/docker-manager/` runs in Herdr: the five sections, Compose/Dockerfile discovery, the lifecycle action matrix, logs/shell terminals, volume backup/restore/clone, system hygiene, inspector drawer and inspector tab.
>
> **Not in this repository**: the `tabs-ref` **Docker** top button and the `file-editor` compose/Dockerfile header actions. Both live in sibling mods (see [`docs/INTEGRATION.md`](docs/INTEGRATION.md)) and each is a separate change, so every mod stays publishable alone. Until then, mount the panel from a layout block or `pane.split` (below).

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

---

## Development

```sh
./sync.sh                                   # copy into ~/.config/herdr-app/mods and herdr-app check
herdr-app check mods/docker-manager         # load the mod once and report what is wrong
docker run --rm -v "$PWD":/w -w /w node:22-alpine node --test test/*.test.js
```

- Unit tests import `mods/docker-manager/docker-logic.js` only; that module is deliberately import-free (no `gpui-kit`, no `herdr`), so it runs under plain Node in a container. `node --test test/` does not expand a directory on Node 22, hence the explicit glob.
- `test/fixtures/` holds real `docker` payloads captured on a Linux host and sanitized by `test/fixtures/sanitize.py` (environment values replaced by `REDACTED`, host identity and absolute project paths removed). Re-capture with the same redaction if you add fixtures.
- `test/mod-safety.test.js` guards the failure mode `herdr-app check` cannot see: a chained element method that does not exist in `gpui-kit.d.ts` loads fine and crashes the frame at render time. It fails (rather than skipping) when the generated `gpui-kit.d.ts` is absent, so run `herdr-app check` first.
- `herdr-app check` regenerates `gpui-kit.d.ts` and `jsconfig.json` inside the mod folder; both are gitignored and excluded by `sync.sh`.
- Verified headlessly on Linux: `Xvfb :99` + `HERDR_APP_HOME=<throwaway dir> herdr-app`, then `herdr-app shot` / `herdr-app status` (its `errors` array reports mod runtime errors).
