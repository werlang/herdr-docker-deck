# docker-manager — Cross-Mod & Layout Integration Spec

Status: **partially implemented** — §1 layout wiring and the §2 `tabs-ref` **Docker** button are implemented (button left of **Files**); the §3 `file-editor` header actions remain specified, not implemented.

Following Herdr's mod independence rule, `docker-manager`, `tabs-ref`, and `file-editor` live in separate repositories and remain independently installable. Neither `tabs-ref` nor `file-editor` imports code or assets from `docker-manager`; instead, they detect `mods/docker-manager/mod.json` at runtime, keep their own local SVG icons, and coordinate through layout commands and `shared()` keys.

---

## 1. Personal Layout Wiring (`~/.config/herdr-app/layouts/<name>.json`)

Add a `"docker"` block child to the `"panel-body"` stack alongside `"files"` and `"changes"`:

```json
{
  "id": "panel",
  "type": "column",
  "children": [
    {
      "id": "panel-body",
      "type": "stack",
      "children": [
        {
          "id": "files",
          "type": "block",
          "content": {
            "mod": "file-editor"
          }
        },
        {
          "id": "changes",
          "type": "block",
          "content": {
            "mod": "git-graph",
            "props": {
              "panel": true
            }
          }
        },
        {
          "id": "docker",
          "type": "block",
          "content": {
            "mod": "docker-manager"
          }
        }
      ],
      "active": "files"
    }
  ],
  "size": {
    "px": 368
  },
  "min": 280,
  "max": 900,
  "hidden": true
}
```

Ensure `shared("workspace.panels")` includes `"docker"` (or let `tabs-ref` include `"docker"` automatically whenever the `"docker"` block is present in `panel-body`).

---

## 2. Top Bar Button in `herdr-tab-actions` (`mods/tabs-ref`)

### Requirement (`DM-01`)

Add a **Docker** button next to **Files** and **Changes** in the top tab bar (`mods/tabs-ref/main.js`).

### Behavior & Wiring

1. **Discovery**:
   - Check whether `find(body, "docker")` exists in the current `layout()` (or `"docker"` is listed in `shared("workspace.panels")`).
   - `enabled` panels list in `tabs-ref` — a configured `workspace.panels` keeps its say, and `docker` is added when the block exists:
     ```js
     const dockerPanel = Boolean(find(body, "docker"));
     const configured = shared("workspace.panels") ?? ["files", "changes"];
     const enabled = dockerPanel && !configured.includes("docker")
       ? [...configured, "docker"]
       : configured;
     ```
2. **Icon Asset**:
   - Store a self-contained tinted SVG at `herdr-tab-actions/mods/tabs-ref/docker.svg` (never reference `mods/docker-manager/...` so `tabs-ref` stays standalone).
3. **Button Rendering**:
   ```js
   .when(enabled.includes("docker") && dockerPanel, el =>
     el.child(panelButton("docker", "Docker", "mods/tabs-ref/docker.svg"))
   )
   .when(enabled.includes("files"), el =>
     el.child(panelButton("files", "Files", "mods/files/file.svg"))
   )
   .when(enabled.includes("changes"), el =>
     el.child(panelButton("changes", "Changes", "mods/changes/changes.svg"))
   )
   ```
4. **Per-Space Panel Memory**:
   - `syncPanel(space, panel, body, enabled)` in `tabs-ref` already persists the active `panel-body` child ID per `space.id` in `this.panels[space.id]`. Adding `"docker"` to `enabled` automatically gives the Docker pane the exact same per-space toggle and restore behavior as `Files` and `Changes`.

---

## 3. Associated File Header Actions in `herdr-file-editor` (`mods/file-editor`)

### Requirement (`DM-04`, `DM-90..94`)

When a Compose file or `Dockerfile` is open in `file-editor` (Tab Mode), show contextual Docker actions directly in the 38px editor header bar.

### 3.1 File Detection (`mods/file-editor/file-logic.js`)

Add a pure helper `detectDockerFileKind(filePath)`:

- **`"compose"`**: basename matches `/^(?:docker-)?compose(?:\.[a-z0-9_-]+)*\.ya?ml$/i` (e.g., `compose.yaml`, `compose.yml`, `docker-compose.yml`, `compose.dev.yaml`, `docker-compose.override.yml`).
- **`"dockerfile"`**: basename matches `/^(?:Dockerfile(?:\.[a-z0-9_-]+)*|[a-z0-9_.-]+\.Dockerfile|Containerfile(?:\.[a-z0-9_-]+)*)$/i`.
- **`null`**: any other file.

### 3.2 Optional Mod Presence Check

Following `tabs-ref` and `pane-plus`:
- `file-editor` checks every 15s via `readTextFile("~/.config/herdr-app/mods/docker-manager/mod.json")` (or relative check) whether `docker-manager` is installed.
- If `docker-manager` is not installed, no Docker header controls are rendered (`DM-94`).
- All icons used in the `file-editor` header live inside `mods/file-editor/` (`mods/file-editor/icons/docker.svg`, `play.svg`, etc.).

### 3.3 Header Controls & Actions (`DM-90..93`)

In `#file-editor-tab`'s header action group (left of the `Save` / `Wrap` / `Split` icons):

1. **For `"compose"` files (`DM-90`)**:
   - Primary button **Compose Up** (`docker compose -f <file> up -d`) + dropdown chevron `▾` opening an in-editor action menu:
     - **Up** (`docker compose -f <file> up -d`)
     - **Up (build)** (`docker compose -f <file> up -d --build`)
     - **Down** (`docker compose -f <file> down`)
     - **Restart** (`docker compose -f <file> restart`)
     - **Pull** (`docker compose -f <file> pull`)
     - **Build** (`docker compose -f <file> build`)
     - **Logs** (`docker compose -f <file> logs -f --tail 500`)
   - **Show in Docker** icon button (`docker.svg`): opens the Docker panel and focuses the matching Compose project.
2. **For `"dockerfile"` files (`DM-91`)**:
   - Primary button **Build ▾** with:
     - **Build image** (`docker build -t <folder>:dev -f <file> .`)
     - **Build & run in Docker…** (delegates to `docker-manager`'s Build & Run dialog via shared state)
   - **Show in Docker** icon button (`docker.svg`): opens the Docker panel and focuses the matching Dockerfile row.
3. **Dirty File Guard (`DM-92`)**:
   - While `this.dirty === true` (unsaved changes in the editor), the **Up** / **Build** buttons are disabled with tooltip `"Save file before running Docker action"`.
4. **Execution in Split Terminal (`DM-92`)**:
   - Clicking an action opens a visible terminal split below the editor:
     ```js
     run("terminal.open", {
       place: "down",
       folder: fileDir,
       name: `docker: ${basename}`,
       argv: ["docker", ...args]
     });
     ```

### 3.4 Cross-Mod Handoff Protocol (`shared("docker-manager.request")`)

When the user clicks **Show in Docker** or **Build & run in Docker…** in `file-editor`:

```js
setShared("docker-manager.request", {
  ts: Date.now(),
  action: "reveal", // or "build-run"
  kind: dockerKind, // "compose" | "dockerfile"
  file: absFilePath,
  folder: workspaceRoot
});
run("layout.select", { stack: "panel-body", child: "docker" });
run("layout.show", { id: "panel" });
```

`docker-manager` watches `shared("docker-manager.request")` in `render()` / poll loop, consumes any request with `ts > this.lastHandledRequestTs`, switches to the `Containers` section, expands and selects the project or Dockerfile matching `file`, and (when `action === "build-run"`) opens the Build & Run modal prefilled for that Dockerfile.
