/**
 * Docker Manager — Native GPUI Docker & Compose management panel.
 *
 * Implements the panel layout, toolbar, section switcher, filter input,
 * virtualized containers tree, live polling, and inspector drawer.
 *
 * References:
 * - docs/SPEC.md: DM-10 (Toolbar), DM-11 (Section switcher), DM-12 (Filter box),
 *   DM-13 (Virtualized list), DM-14 (Row interactions), DM-15 (Engine detection),
 *   DM-20..27 (Containers tree), DM-40..43 (Inspector drawer)
 * - docs/DESIGN.md: Section 2 (Dual-Mode View Architecture), Section 4 (CLI Contracts)
 */

import { View, div, svg, uniform_list } from "gpui-kit";
import {
  v_flex,
  h_flex,
  Input,
  InputState,
  v_resizable,
  resizable_panel,
  Scrollbar,
  Editor,
  EditorState,
} from "gpui-base";
import {
  theme,
  props,
  shared,
  setShared,
  exec,
  run,
  terminals,
  spaces,
  panes,
  focused,
  layout,
  notify,
  settings,
} from "herdr";
import {
  normalizeContainerInspect,
  resolveDockerContext,
  buildContainerTree,
  flattenContainerRows,
  matchesFilter,
  parseComposeLs,
  engineStateFromResults,
  isLayoutNodeVisible,
  formatPortMappings,
  buildContextMenuItems,
  requiresConfirm,
  confirmKind,
  validateConfirmInput,
  buildActionArgs,
  findReusableTerminal,
  terminalPlacement,
  contextMenuPosition,
  buildInspectTabProps,
  inspectTabName,
  resolveInspectorTarget,
  maskEnvEntries,
  parseDockerStats,
  formatBytes,
  formatRelativeTime,
  formatUptime,
  normalizeImageInspect,
  normalizeVolumeInspect,
  normalizeNetworkInspect,
  prettyJson,
  buildSyntaxTheme,
} from "./docker-logic.js";

/** Available section keys in panel mode (DM-11). */
const SECTIONS = [
  { id: "containers", label: "Containers", icon: "container" },
  { id: "images", label: "Images", icon: "layers" },
  { id: "volumes", label: "Volumes", icon: "volume" },
  { id: "networks", label: "Networks", icon: "network" },
  { id: "system", label: "System", icon: "system" },
];

export default class DockerManager extends View {
  /**
   * Initializes the Docker Manager view (DM-02).
   *
   * @param {Record<string, any>} _props
   * @param {import("gpui-kit").ViewContext} cx
   */
  init(_props, cx) {
    this.closed = false;
    const p = props() || {};

    // Mode determination
    this.inspectMode = Boolean(p.inspect);
    this.inspectTarget = p.inspect || null;

    // Panel state
    this.section = "containers";
    this.scope = shared("docker-manager.scope") || "all"; // "all" | "space" (DM-35, DM-36)
    this.expandState = shared("docker-manager.expanded") || {};
    this.engineStatus = "connected"; // "connected" | "daemon-down" | "cli-missing"
    this.engineVersion = "Docker";
    this.engineError = null;

    // Selection & Drawer state
    this.selectedKey = null;
    this.selectedRow = null;
    this.inspectData = null;
    this.inspectLoading = false;

    // R3 Context menu, confirmations, and busy states
    this.busyTargets = new Map();
    this.contextMenu = null;
    this.confirmDialog = null;
    this.rootOrigin = null;
    this.rootBounds = null;
    this.width = 0;
    this.height = 0;

    // Polling & context tracking
    this.pollSeq = 0;
    this.wasVisible = false;
    this.root = null;
    this.machine = null;
    this.tree = { projects: [], dockerfiles: [], standalone: [] };
    this.rows = [];

    // Filter input state (retained)
    this.filterText = "";
    this.filterInput = InputState.new({ placeholder: "Filter containers, images, ports…" });
    this.filterInput.on("change", (_e, cx) => {
      this.filterText = (this.filterInput.value() || "").toLowerCase().trim();
      this.updateRows();
      cx.notify();
    });

    // Initial load
    this.wasVisible = this.isViewVisible();
    this.refresh(cx);

    // Fast visibility check: promotes hidden -> visible into immediate refresh
    cx.timer.every(100, (cx) => {
      const visible = this.isViewVisible();
      const justOpened = visible && !this.wasVisible;
      this.wasVisible = visible;
      if (justOpened) {
        this.poll(cx);
      }
    });

    // Background poll every 3s while visible
    cx.timer.every(3000, (cx) => {
      if (this.isViewVisible()) {
        this.poll(cx);
      }
    });
  }

  /**
   * Lifecycle cleanup.
   *
   * @param {import("gpui-kit").AsyncContext} _cx
   */
  async close(_cx) {
    this.closed = true;
    this.pollSeq++;
    if (this.filterInput) {
      this.filterInput.release();
      this.filterInput = null;
    }
    if (this.confirmDialog?.inputState) {
      this.confirmDialog.inputState.release();
      this.confirmDialog = null;
    }
  }

  /**
   * Determines if this view is currently visible in the layout.
   *
   * @returns {boolean}
   */
  isViewVisible() {
    const p = props() || {};
    if (p.panel) {
      const root = layout();
      return isLayoutNodeVisible(root, (n) => n?.id === "docker" || n?.content?.mod === "docker-manager");
    }
    const spaceList = spaces() || [];
    const activeSpace = spaceList.find((s) => s.active);
    if (!activeSpace) {
      const root = layout();
      return isLayoutNodeVisible(root, (n) => n?.id === "docker" || n?.content?.mod === "docker-manager");
    }
    const activeTab = (activeSpace.tabs ?? []).find((t) => t.active);
    if (!activeTab) {
      const root = layout();
      return isLayoutNodeVisible(root, (n) => n?.id === "docker" || n?.content?.mod === "docker-manager");
    }
    const allPanes = panes() || [];
    if (p.pane) {
      const myPane = allPanes.find((pane) => pane.pane === p.pane);
      if (myPane) return myPane.tab === activeTab.id;
    }
    return allPanes.some((pane) => pane.tab === activeTab.id && pane.mod === "docker-manager");
  }

  /**
   * Resolves the current workspace directory and machine target.
   *
   * @returns {{ root: string | null, machine: string | null }}
   */
  getContext() {
    return resolveDockerContext({
      props: () => props(),
      spaces: () => spaces(),
      panes: () => panes(),
      focused: () => focused(),
      shared: (k) => shared(k),
      currentRoot: this.root,
    });
  }

  /**
   * Triggers an immediate refresh.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  refresh(cx) {
    this.poll(cx);
  }

  /**
   * Polls Docker state from the daemon.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  poll(cx) {
    if (this.closed) return;
    const seq = ++this.pollSeq;
    const ctx = this.getContext();
    this.root = ctx.root;
    this.machine = ctx.machine;

    cx.spawn(async (cx) => {
      try {
        const [contRes, compRes, verRes] = await Promise.allSettled([
          exec("docker", ["container", "ls", "-a", "--no-trunc", "--format", "{{json .}}"], {
            on: this.machine,
            timeout: 6000,
          }),
          exec("docker", ["compose", "ls", "--all", "--format", "json"], {
            on: this.machine,
            timeout: 6000,
          }),
          exec("docker", ["version", "--format", "{{json .}}"], {
            on: this.machine,
            timeout: 6000,
          }),
        ]);

        if (this.closed || this.pollSeq !== seq) return;

        // Engine probe evaluation
        const engineState = engineStateFromResults({
          info: null,
          versionProbe: verRes.status === "fulfilled" ? verRes.value : { error: verRes.reason },
        });

        if (engineState.reachable) {
          this.engineStatus = "connected";
          this.engineVersion = engineState.version ? `Docker ${engineState.version}` : "Docker";
          this.engineError = null;
        } else {
          this.engineStatus = engineState.status;
          this.engineVersion = "Docker";
          this.engineError = engineState.error;
        }

        // Parse NDJSON containers
        const rawContainers = [];
        if (contRes.status === "fulfilled" && contRes.value?.stdout) {
          const lines = contRes.value.stdout.trim().split("\n");
          for (const line of lines) {
            const l = line.trim();
            if (!l) continue;
            try {
              rawContainers.push(JSON.parse(l));
            } catch {}
          }
        }

        // Parse Compose projects
        const composeLs =
          compRes.status === "fulfilled" && compRes.value?.stdout
            ? parseComposeLs(compRes.value.stdout)
            : [];

        // Build container tree
        this.tree = buildContainerTree({
          containers: rawContainers,
          composeLs,
          spaceRoot: this.root,
          scope: this.scope,
        });

        this.updateRows();
        cx.notify();
      } catch (err) {
        if (this.closed || this.pollSeq !== seq) return;
        this.engineStatus = "daemon-down";
        this.engineError = err?.message || String(err);
        cx.notify();
      }
    });
  }

  /**
   * Updates `this.rows` by flattening the tree and applying filter.
   */
  updateRows() {
    let rows = flattenContainerRows(this.tree, this.expandState);
    if (this.filterText) {
      rows = rows.filter((r) => matchesFilter(r, this.filterText));
    }
    this.rows = rows;
  }

  /**
   * Handles row clicks in the uniform list.
   *
   * @param {string} key
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleRowClick(key, cx) {
    const row = this.rows.find((r) => r.key === key);
    if (!row) return;

    if (row.type === "project") {
      this.expandState[row.name] = !row.expanded;
      setShared("docker-manager.expanded", this.expandState);
      this.updateRows();
      cx.notify();
      return;
    }

    if (row.type === "dockerfile") {
      this.expandState[row.path] = !row.expanded;
      setShared("docker-manager.expanded", this.expandState);
      this.updateRows();
      cx.notify();
      return;
    }

    if (row.type === "service") {
      this.selectedKey = key;
      this.selectedRow = row;

      if (row.hasReplicas) {
        const k = `${row.project}/${row.service}`;
        this.expandState[k] = !row.expanded;
        setShared("docker-manager.expanded", this.expandState);
        this.updateRows();
      }

      const targetContId = row.containerId || row.data?.containers?.[0]?.id;
      if (targetContId) {
        this.inspectLoading = true;
        this.inspectData = null;
        cx.notify();
        cx.spawn(async (cx) => {
          await this.fetchInspect(targetContId);
          cx.notify();
        });
      } else {
        this.inspectData = null;
        this.inspectLoading = false;
        cx.notify();
      }
      return;
    }

    if (row.type === "container") {
      this.selectedKey = key;
      this.selectedRow = row;

      if (row.containerId) {
        this.inspectLoading = true;
        this.inspectData = null;
        cx.notify();
        cx.spawn(async (cx) => {
          await this.fetchInspect(row.containerId);
          cx.notify();
        });
      } else {
        this.inspectData = null;
        this.inspectLoading = false;
        cx.notify();
      }
    }
  }

  /**
   * Fetches container inspection data.
   *
   * @param {string} containerId
   */
  async fetchInspect(containerId) {
    if (!containerId) return;
    try {
      const res = await exec("docker", ["inspect", "--format", "{{json .}}", containerId], {
        on: this.machine,
        timeout: 5000,
      });
      if (res?.stdout) {
        this.inspectData = normalizeContainerInspect(res.stdout);
      }
    } catch {
      this.inspectData = null;
    } finally {
      this.inspectLoading = false;
    }
  }

  /**
   * Copies a value to clipboard with notification toast (DM-43).
   *
   * @param {any} val
   * @param {import("gpui-kit").ViewContext} cx
   * @param {string} [label]
   */
  copyValue(val, cx, label = "") {
    if (val === null || val === undefined || val === "") return;
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    cx.write_to_clipboard(str);
    try {
      notify({
        title: label ? `${label} copied` : "Copied to clipboard",
        body: str.length > 50 ? `${str.slice(0, 50)}…` : str,
      });
    } catch {}
  }

  /**
   * Renders the top toolbar (DM-10).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderToolbar(t, cx) {
    const isConnected = this.engineStatus === "connected";
    const statusColor = isConnected ? t.done || "#2ea043" : t.blocked || "#e05252";

    return h_flex()
      .h(38)
      .w_full()
      .px(10)
      .items_center()
      .justify_between()
      .bg(t.chrome)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(div().w(7).h(7).rounded_full().bg(statusColor))
          .child(
            div()
              .font_semibold()
              .text_size(12)
              .text_color(t.foreground)
              .child(this.engineVersion)
          )
      )
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(
            h_flex()
              .items_center()
              .rounded(5)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .p(2)
              .gap(2)
              .child(
                div()
                  .px(6)
                  .py(2)
                  .rounded(3)
                  .text_size(10.5)
                  .cursor_pointer()
                  .when(this.scope === "space", (el) =>
                    el.bg(t.selected).text_color(t.foreground).font_semibold()
                  )
                  .when(this.scope !== "space", (el) =>
                    el.text_color(t.dim).hover((s) => s.text_color(t.foreground))
                  )
                  .on_click((_e, cx) => {
                    this.scope = "space";
                    setShared("docker-manager.scope", "space");
                    this.updateRows();
                    cx.notify();
                  })
                  .child("Space")
              )
              .child(
                div()
                  .px(6)
                  .py(2)
                  .rounded(3)
                  .text_size(10.5)
                  .cursor_pointer()
                  .when(this.scope === "all", (el) =>
                    el.bg(t.selected).text_color(t.foreground).font_semibold()
                  )
                  .when(this.scope !== "all", (el) =>
                    el.text_color(t.dim).hover((s) => s.text_color(t.foreground))
                  )
                  .on_click((_e, cx) => {
                    this.scope = "all";
                    setShared("docker-manager.scope", "all");
                    this.updateRows();
                    cx.notify();
                  })
                  .child("All")
              )
          )
          .child(
            div()
              .w(24)
              .h(24)
              .rounded(4)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.refresh(cx))
              .child(svg("mods/docker-manager/icons/refresh.svg").size(12).text_color(t.muted))
          )
      );
  }

  /**
   * Renders the section switcher bar (DM-11).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderSectionSwitcher(t, _cx) {
    return h_flex()
      .h(32)
      .w_full()
      .px(8)
      .items_center()
      .gap(4)
      .bg(t.surface)
      .border_b_1()
      .border_color(t.border)
      .children(
        SECTIONS.map((sec) => {
          const isActive = this.section === sec.id;
          return div()
            .id(sec.id)
            .px(8)
            .py(3)
            .rounded(4)
            .text_size(11)
            .cursor_pointer()
            .when(isActive, (el) =>
              el.bg(t.selected).text_color(t.foreground).font_semibold()
            )
            .when(!isActive, (el) =>
              el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            )
            .child(sec.label);
        })
      );
  }

  /**
   * Renders the filter input (DM-12).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderFilterBar(t, _cx) {
    return h_flex()
      .h(32)
      .w_full()
      .px(8)
      .items_center()
      .bg(t.background)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .h(24)
          .px(6)
          .items_center()
          .rounded(4)
          .bg(t.input)
          .border_1()
          .border_color(t.border)
          .child(
            Input.new(this.filterInput)
              .h_full()
              .w_full()
              .text_size(11)
              .text_color(t.foreground)
          )
      );
  }

  /**
   * Renders a single row element for `uniform_list`.
   * Note: Event handlers must NOT be attached inside this method.
   *
   * @param {any} row
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderRow(row, t, _cx) {
    const isSelected = this.selectedKey === row.key;
    const indent = 8 + (row.depth || 0) * 16;

    if (row.type === "project") {
      const statusColor =
        row.status === "ok"
          ? t.done || "#2ea043"
          : row.status === "warning"
          ? t.working || "#d29922"
          : row.status === "error"
          ? t.blocked || "#e05252"
          : t.muted;

      const baseFiles = (row.configFiles || [])
        .map((f) => f.slice(f.lastIndexOf("/") + 1))
        .join(", ");

      return h_flex()
        .h(28)
        .w_full()
        .pl(indent)
        .pr(8)
        .items_center()
        .gap(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .when(isSelected, (el) => el.bg(t.selected))
        .child(
          svg(
            row.expanded
              ? "mods/docker-manager/icons/chevron-down.svg"
              : "mods/docker-manager/icons/chevron-right.svg"
          )
            .size(10)
            .text_color(t.dim)
        )
        .child(div().w(6).h(6).rounded_full().bg(statusColor))
        .child(svg("mods/docker-manager/icons/compose.svg").size(13).text_color(t.muted))
        .child(
          div()
            .text_size(11.5)
            .font_medium()
            .text_color(t.foreground)
            .child(row.name)
        )
        .child(
          div()
            .text_size(10.5)
            .text_color(t.dim)
            .child(`●${row.runningCount}/${row.totalCount}`)
        )
        .when(Boolean(baseFiles), (el) =>
          el.child(div().text_size(10).text_color(t.dim).child(baseFiles))
        )
        .when(row.inSpace, (el) =>
          el.child(
            div()
              .px(4)
              .py(1)
              .rounded(3)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(9.5)
              .text_color(t.accent)
              .child("this space")
          )
        )
        .when(row.mixedSources, (el) =>
          el.child(div().text_size(10).text_color(t.working).child("⚠ mixed sources"))
        )
        .when(this.busyTargets.has(`project:${row.name}`), (el) =>
          el.child(
            svg("mods/docker-manager/icons/refresh.svg")
              .size(12)
              .spin(900)
              .text_color(t.accent)
          )
        );
    }

    if (row.type === "service") {
      const isNotCreated = row.status === "not-created";
      const statusColor = row.running ? t.done || "#2ea043" : t.dim;

      return h_flex()
        .h(28)
        .w_full()
        .pl(indent)
        .pr(8)
        .items_center()
        .gap(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .when(isSelected, (el) => el.bg(t.selected))
        .when(this.busyTargets.has(`service:${row.project}/${row.name}`), (el) =>
          el.child(
            svg("mods/docker-manager/icons/refresh.svg")
              .size(12)
              .spin(900)
              .text_color(t.accent)
          )
        )
        .when(row.hasReplicas, (el) =>
          el.child(
            svg(
              row.expanded
                ? "mods/docker-manager/icons/chevron-down.svg"
                : "mods/docker-manager/icons/chevron-right.svg"
            )
              .size(10)
              .text_color(t.dim)
          )
        )
        .when(!row.hasReplicas, (el) => el.child(div().w(10).h(10)))
        .when(!isNotCreated, (el) => el.child(div().w(6).h(6).rounded_full().bg(statusColor)))
        .when(isNotCreated, (el) =>
          el.child(div().w(6).h(6).rounded_full().border_1().border_color(t.dim))
        )
        .child(
          div()
            .text_size(11)
            .when(isNotCreated, (el) => el.text_color(t.dim))
            .when(!isNotCreated, (el) => el.text_color(t.foreground))
            .child(row.name)
        )
        .child(
          div()
            .text_size(10)
            .text_color(t.dim)
            .child(isNotCreated ? "not created" : row.status)
        )
        .when(Boolean(row.ports), (el) => {
          const mappings = formatPortMappings(row.ports);
          if (mappings.length === 0) return el;
          return el.children(
            mappings.map((m) => {
              if (m.published) {
                return h_flex()
                  .items_center()
                  .px(4)
                  .py(0.5)
                  .rounded(3)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .child(
                    div()
                      .text_size(10)
                      .text_color(t.foreground)
                      .child(m.text)
                  );
              }
              return div().text_size(10).text_color(t.dim).child(m.text);
            })
          );
        })
        .when(row.hasReplicas, (el) =>
          el.child(div().text_size(10).text_color(t.dim).child(`(${row.containerCount})`))
        );
    }

    if (row.type === "dockerfile") {
      return h_flex()
        .h(28)
        .w_full()
        .pl(indent)
        .pr(8)
        .items_center()
        .gap(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .when(isSelected, (el) => el.bg(t.selected))
        .child(
          svg(
            row.expanded
              ? "mods/docker-manager/icons/chevron-down.svg"
              : "mods/docker-manager/icons/chevron-right.svg"
          )
            .size(10)
            .text_color(t.dim)
        )
        .child(svg("mods/docker-manager/icons/docker.svg").size(12).text_color(t.muted))
        .child(div().text_size(11).text_color(t.foreground).child(row.name))
        .child(div().text_size(10).text_color(t.dim).child(`(${row.containerCount})`));
    }

    // Container row (replica or standalone)
    const statusColor = row.running ? t.done || "#2ea043" : t.dim;
    return h_flex()
      .h(28)
      .w_full()
      .pl(indent)
      .pr(8)
      .items_center()
      .gap(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .when(isSelected, (el) => el.bg(t.selected))
      .when(this.busyTargets.has(`container:${row.containerId || row.id}`), (el) =>
        el.child(
          svg("mods/docker-manager/icons/refresh.svg")
            .size(12)
            .spin(900)
            .text_color(t.accent)
        )
      )
      .child(div().w(6).h(6).rounded_full().bg(statusColor))
      .child(svg("mods/docker-manager/icons/container.svg").size(12).text_color(t.muted))
      .child(div().text_size(11).text_color(t.foreground).child(row.name))
      .when(Boolean(row.shortId), (el) =>
        el.child(div().font_family("monospace").text_size(10).text_color(t.dim).child(row.shortId))
      )
      .child(div().text_size(10).text_color(t.dim).child(row.status))
      .when(Boolean(row.ports), (el) => {
        const mappings = formatPortMappings(row.ports);
        if (mappings.length === 0) return el;
        return el.children(
          mappings.map((m) => {
            if (m.published) {
              return h_flex()
                .items_center()
                .px(4)
                .py(0.5)
                .rounded(3)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .child(
                  div()
                    .text_size(10)
                    .text_color(t.foreground)
                    .child(m.text)
                );
            }
            return div().text_size(10).text_color(t.dim).child(m.text);
          })
        );
      });
  }

  /**
   * Renders the slice of visible rows for `uniform_list`.
   *
   * @param {{ start: number, end: number }} range
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderRowsSlice(range, t, cx) {
    const slice = this.rows.slice(range.start, range.end);
    return slice.map((row) => this.renderRow(row, t, cx));
  }

  /**
   * Renders the main virtualized container list area.
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderListArea(t, cx) {
    if (this.engineStatus === "cli-missing") {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .p(16)
        .gap(8)
        .child(
          div()
            .text_size(12)
            .font_medium()
            .text_color(t.blocked)
            .child("Docker CLI not found")
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.muted)
            .child("Make sure Docker is installed and in your PATH.")
        );
    }

    if (this.engineStatus === "daemon-down") {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .p(16)
        .gap(8)
        .child(
          div()
            .text_size(12)
            .font_medium()
            .text_color(t.blocked)
            .child("Cannot connect to the Docker daemon")
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.muted)
            .child("Is the Docker daemon running?")
        );
    }

    if (this.rows.length === 0) {
      const message = this.filterText
        ? `No containers matching "${this.filterText}"`
        : "No active containers.";

      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .p(16)
        .child(div().text_size(11.5).text_color(t.muted).child(message));
    }

    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .child(
        uniform_list(
          "docker-containers-list",
          this.rows.length,
          (i) => this.rows[i]?.key || String(i),
          (range, cx) => this.renderRowsSlice(range, t, cx)
        )
          .size_full()
          .on_item_click((key, cx) => this.handleRowClick(key, cx))
          .on_item_secondary_click((key, event, cx) => this.handleRowRightClick(key, event, cx))
      )
      .child(Scrollbar.vertical("docker-containers-list").absolute().inset_0());
  }

  /**
   * Renders a key-value field inside the inspector drawer (DM-41, DM-43).
   *
   * @param {string} label
   * @param {any} value
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   * @param {{ isCode?: boolean, copyVal?: any }} [opts]
   */
  renderDrawerField(label, value, t, _cx, { isCode = false, copyVal = null } = {}) {
    if (value === null || value === undefined || value === "") return null;
    const strVal = String(value);
    const toCopy = copyVal !== null ? copyVal : strVal;

    return h_flex()
      .w_full()
      .py(2)
      .px(8)
      .items_start()
      .gap(8)
      .hover((s) => s.bg(t.hover))
      .rounded(3)
      .child(
        div()
          .w(110)
          .flex_shrink_0()
          .text_size(10.5)
          .text_color(t.dim)
          .child(label)
      )
      .child(
        div()
          .flex_1()
          .text_size(11)
          .text_color(t.foreground)
          .cursor_pointer()
          .when(isCode, (el) => el.font_family("monospace"))
          .on_click((_e, cx) => this.copyValue(toCopy, cx, label))
          .child(strVal)
      );
  }

  /**
   * Renders ports in the drawer with clickable URL links (DM-41).
   *
   * @param {any[]} ports
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderDrawerPorts(ports, t, _cx) {
    if (!ports || ports.length === 0) return null;

    return h_flex()
      .w_full()
      .py(2)
      .px(8)
      .items_start()
      .gap(8)
      .child(
        div()
          .w(110)
          .flex_shrink_0()
          .text_size(10.5)
          .text_color(t.dim)
          .child("Ports")
      )
      .child(
        h_flex()
          .flex_1()
          .flex_wrap()
          .gap(6)
          .children(
            ports.map((p) => {
              const hasHost = Boolean(p.hostPort);
              const label = hasHost
                ? `${p.hostPort} → ${p.containerPort}/${p.proto}`
                : `${p.containerPort}/${p.proto}`;
              const url = hasHost ? `http://localhost:${p.hostPort}` : null;

              return h_flex()
                .items_center()
                .gap(4)
                .px(5)
                .py(1)
                .rounded(3)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .when(Boolean(url), (el) =>
                  el.on_click((_e, cx) => cx.open_url(url))
                )
                .when(!url, (el) =>
                  el.on_click((_e, cx) => this.copyValue(label, cx, "Port"))
                )
                .child(
                  div()
                    .font_family("monospace")
                    .text_size(10)
                    .when(Boolean(url), (el) => el.text_color(t.accent).underline())
                    .when(!url, (el) => el.text_color(t.foreground))
                    .child(label)
                );
            })
          )
      );
  }

  /**
   * Renders mounts in the inspector drawer.
   *
   * @param {any[]} mounts
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderDrawerMounts(mounts, t, cx) {
    if (!mounts || mounts.length === 0) return null;
    return v_flex()
      .w_full()
      .children(
        mounts
          .map((m) => {
            const text = `${m.type}: ${m.source} → ${m.destination} (${m.rw ? "rw" : "ro"})`;
            return this.renderDrawerField("Mount", text, t, cx, { copyVal: m.source || text });
          })
          .filter(Boolean)
      );
  }

  /**
   * Renders networks in the inspector drawer.
   *
   * @param {any[]} networks
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderDrawerNetworks(networks, t, cx) {
    if (!networks || networks.length === 0) return null;
    return v_flex()
      .w_full()
      .children(
        networks
          .map((n) => {
            const text = `${n.name} (${n.ipAddress || "no IP"})`;
            return this.renderDrawerField("Network", text, t, cx, { copyVal: n.ipAddress || n.name });
          })
          .filter(Boolean)
      );
  }

  /**
   * Renders the header bar of the inspector drawer.
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderDrawerHeader(t, _cx) {
    const row = this.selectedRow;
    const title = row ? row.service || row.name : "Inspector";
    const sub = row ? (row.project ? `${row.project} / ${row.name}` : row.name) : "";

    return h_flex()
      .h(30)
      .w_full()
      .px(8)
      .items_center()
      .justify_between()
      .bg(t.chrome)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(svg("mods/docker-manager/icons/container.svg").size(12).text_color(t.muted))
          .child(
            div()
              .font_semibold()
              .text_size(11)
              .text_color(t.foreground)
              .child(title)
          )
          .when(Boolean(sub && sub !== title), (el) =>
            el.child(div().text_size(10).text_color(t.dim).child(`(${sub})`))
          )
      )
      .child(
        div()
          .w(18)
          .h(18)
          .rounded(3)
          .items_center()
          .justify_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.selectedRow = null;
            this.selectedKey = null;
            this.inspectData = null;
            cx.notify();
          })
          .child(div().text_size(11).text_color(t.muted).child("✕"))
      );
  }

  /**
   * Renders the collapsible inspector drawer at the bottom of the panel (DM-40..43).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderInspectorDrawer(t, cx) {
    const data = this.inspectData;
    const row = this.selectedRow;

    return v_flex()
      .id("docker-inspector-drawer")
      .size_full()
      .bg(t.background)
      .border_t_1()
      .border_color(t.border)
      .child(this.renderDrawerHeader(t, cx))
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scrollbar()
          .p(6)
          .when(this.inspectLoading, (el) =>
            el.child(
              div().p(12).text_size(11).text_color(t.muted).child("Loading inspection details…")
            )
          )
          .when(!this.inspectLoading && Boolean(data), (el) => {
            const fields = [
              this.renderDrawerField("Container ID", data.shortId || data.id, t, cx, { isCode: true }),
              this.renderDrawerField("Image", data.image, t, cx),
              this.renderDrawerField(
                "Status",
                data.health?.status
                  ? `${data.state?.status} (${data.health.status})`
                  : data.state?.status,
                t,
                cx
              ),
              data.health?.lastLog ? this.renderDrawerField("Health Log", data.health.lastLog, t, cx) : null,
              this.renderDrawerField("Created", data.created, t, cx),
              this.renderDrawerField("Started", data.startedAt, t, cx),
              this.renderDrawerField("Restart Policy", data.restartPolicy?.name, t, cx),
              this.renderDrawerPorts(data.ports, t, cx),
              this.renderDrawerMounts(data.mounts, t, cx),
              this.renderDrawerNetworks(data.networks, t, cx),
              this.renderDrawerField(
                "Command",
                Array.isArray(data.cmd) ? data.cmd.join(" ") : data.cmd,
                t,
                cx,
                { isCode: true }
              ),
              this.renderDrawerField(
                "Entrypoint",
                Array.isArray(data.entrypoint) ? data.entrypoint.join(" ") : data.entrypoint,
                t,
                cx,
                { isCode: true }
              ),
              this.renderDrawerField("Working Dir", data.workingDir, t, cx),
              this.renderDrawerField(
                "Compose Files",
                Array.isArray(data.composeFiles) ? data.composeFiles.join(", ") : data.composeFiles,
                t,
                cx
              ),
              this.renderDrawerField(
                "Depends On",
                Array.isArray(data.dependsOn) ? data.dependsOn.join(", ") : data.dependsOn,
                t,
                cx
              ),
            ].filter(Boolean);

            return el.children(fields);
          })
          .when(!this.inspectLoading && !data && Boolean(row), (el) => {
            const config = row.data?.config;
            const fields = [
              this.renderDrawerField("Status", row.status, t, cx),
              this.renderDrawerField("Service", row.service, t, cx),
              this.renderDrawerField("Project", row.project, t, cx),
              config?.image ? this.renderDrawerField("Image (declared)", config.image, t, cx) : null,
              config?.ports ? this.renderDrawerField("Ports (declared)", JSON.stringify(config.ports), t, cx) : null,
              config?.profiles ? this.renderDrawerField("Profiles", config.profiles.join(", "), t, cx) : null,
            ].filter(Boolean);

            return el.children(fields);
          })
      );
  }

  /**
   * Renders the body area: either split with inspector drawer or single list area.
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderBody(t, cx) {
    if (this.selectedRow) {
      return v_resizable("docker-panel-split")
        .flex_1()
        .min_h(0)
        .child(resizable_panel().child(this.renderListArea(t, cx)))
        .child(
          resizable_panel()
            .size(220)
            .size_range(120, 560)
            .child(this.renderInspectorDrawer(t, cx))
        );
    }
    return this.renderListArea(t, cx);
  }

  /**
   * Updates cached root origin and bounds for clamping popups (DM-14).
   *
   * @param {any} e
   */
  updateRootOrigin(e) {
    if (e.bounds && typeof e.bounds.width === "number" && typeof e.bounds.height === "number") {
      this.rootBounds = e.bounds;
    }
    if (e.position && e.local_position) {
      this.rootOrigin = {
        x: e.position.x - e.local_position.x,
        y: e.position.y - e.local_position.y,
      };
    }
  }

  /**
   * Handles right click on an item in the virtualized containers list.
   *
   * @param {string} key
   * @param {any} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleRowRightClick(key, event, cx) {
    const row = this.rows.find((r) => r.key === key);
    if (!row) return;

    const zoom = Number(settings?.()?.zoom) || 1;
    const { x, y } = contextMenuPosition({
      origin: this.rootOrigin,
      bounds: this.rootBounds,
      width: this.width,
      height: this.height,
      zoom,
      event,
      menuWidth: 220,
      menuHeight: 300,
    });

    const target = { ...row.data, ...row };
    const items = buildContextMenuItems(target);

    this.contextMenu = {
      row,
      items,
      x,
      y,
      rawEvent: event,
    };
    cx.notify();
  }

  /**
   * Closes the open context menu.
   *
   * @param {import("gpui-kit").ViewContext} [cx]
   */
  closeContextMenu(cx) {
    this.contextMenu = null;
    if (cx) cx.notify();
  }

  /**
   * Dispatches or prompts for a context menu action.
   *
   * @param {any} item
   * @param {any} row
   * @param {any} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleMenuAction(item, row, event, cx) {
    if (!item || !item.enabled) return;

    if (requiresConfirm(item)) {
      this.openConfirmDialog(item, row, confirmKind(item), cx);
      return;
    }

    if (
      item.id.endsWith(".logs") ||
      item.id === "logs" ||
      item.id.endsWith(".shell") ||
      item.id === "shell"
    ) {
      const alt = Boolean(event?.modifiers?.alt);
      this.openTerminal(item, row, { alt }, cx);
      return;
    }

    if (item.id === "service.inspect" || item.id === "container.inspect" || item.id === "inspect") {
      this.handleRowClick(row.key, cx);
      return;
    }

    if (item.id === "project.open_file") {
      const file = row.data?.configFiles?.[0];
      if (file) {
        run("tab.new", { argv: ["file-editor", file] }).catch(() => {
          cx.write_to_clipboard(file);
          notify({ title: "Copied compose file path", body: file, level: "info" });
        });
      }
      return;
    }

    if (item.id === "dockerfile.open_file") {
      const file = row.path || row.data?.path;
      if (file) {
        run("tab.new", { argv: ["file-editor", file] }).catch(() => {
          cx.write_to_clipboard(file);
          notify({ title: "Copied Dockerfile path", body: file, level: "info" });
        });
      }
      return;
    }

    if (item.id.includes("copy_name") || item.id.includes("copy_id")) {
      const val = item.id.includes("copy_id")
        ? row.containerId || row.id || row.shortId
        : row.project || row.service || row.name;
      this.copyValue(val, cx, "Name");
      return;
    }

    if (item.id.includes("open_port")) {
      const mappings = formatPortMappings(row.ports || row.data?.ports);
      const pub = mappings.find((m) => m.published && m.hostPort);
      if (pub) {
        cx.open_url(`http://localhost:${pub.hostPort}`);
      }
      return;
    }

    // Standard lifecycle action
    this.executeLifecycleAction(item, row, cx);
  }

  /**
   * Opens the confirmation dialog for a destructive action (DM-85..87).
   *
   * @param {any} item
   * @param {any} row
   * @param {"typed" | "plain"} kind
   * @param {import("gpui-kit").ViewContext} cx
   */
  openConfirmDialog(item, row, kind, cx) {
    let expected = "";
    if (kind === "typed") {
      if (item.id.includes("prune")) {
        expected = "prune";
      } else {
        expected = row.project || row.name || row.containerId || row.id;
      }
    }

    const inputState =
      kind === "typed"
        ? InputState.new({ placeholder: `Type "${expected}" to confirm` })
        : null;

    if (inputState) {
      inputState.on("change", (_e, cx) => {
        cx.notify();
      });
    }

    let message = `Are you sure you want to perform "${item.label}"?`;
    if (item.id === "project.down") {
      message = `Stops and removes containers and networks for project "${row.project || row.name}".`;
    } else if (item.id === "project.down_volumes" || item.id === "down -v") {
      message = `Stops containers and DELETES all declared volumes for project "${row.project || row.name}". All volume data will be lost!`;
    } else if (item.id === "container.remove" || item.id === "container.rm") {
      message = `Permanently removes container "${row.name || row.id}".`;
    } else if (item.id === "container.kill") {
      message = `Forcefully terminates container "${row.name || row.id}" with SIGKILL.`;
    } else if (item.id === "service.remove" || item.id === "service.rm") {
      message = `Stops and removes containers for service "${row.service || row.name}".`;
    }

    this.confirmDialog = {
      item,
      row,
      kind,
      expected,
      message,
      inputState,
    };
    cx.notify();
  }

  /**
   * Closes the confirmation dialog and releases retained state.
   *
   * @param {import("gpui-kit").ViewContext} [cx]
   */
  closeConfirmDialog(cx) {
    if (this.confirmDialog?.inputState) {
      this.confirmDialog.inputState.release();
    }
    this.confirmDialog = null;
    if (cx) cx.notify();
  }

  /**
   * Executes a lifecycle action in the background via exec("docker", argv, ...).
   *
   * @param {any} item
   * @param {any} row
   * @param {import("gpui-kit").ViewContext} cx
   */
  executeLifecycleAction(item, row, cx) {
    const targetKey =
      row.type === "project"
        ? `project:${row.name}`
        : row.type === "service"
        ? `service:${row.project}/${row.name}`
        : `container:${row.containerId || row.id}`;

    const target = { ...row.data, ...row };
    const argv = buildActionArgs(item, target);
    this.busyTargets.set(targetKey, item.label);
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const cwd = target.workingDir || undefined;
        const res = await exec("docker", argv, { cwd, on: this.machine });
        if (res.code !== 0) {
          notify({
            title: `${item.label} failed`,
            body: res.stderr || `Exit code ${res.code}`,
            level: "error",
          });
        } else {
          notify({
            title: `${item.label} succeeded`,
            body: row.name || row.project || row.id,
            level: "info",
          });
        }
      } catch (err) {
        notify({
          title: `${item.label} error`,
          body: String(err?.message || err),
          level: "error",
        });
      } finally {
        this.busyTargets.delete(targetKey);
        this.poll(cx);
        cx.notify();
      }
    });
  }

  /**
   * Opens or focuses a logs or shell terminal in Herdr (DM-80..83).
   *
   * @param {any} item
   * @param {any} row
   * @param {{ alt?: boolean }} opts
   * @param {import("gpui-kit").ViewContext} _cx
   */
  openTerminal(item, row, { alt = false } = {}, _cx) {
    const place = terminalPlacement({ alt, preference: "tab" });
    const target = { ...row.data, ...row };
    const argv = buildActionArgs(item, target);
    const spaceId = this.getContext()?.spaceId;

    const termList = typeof terminals === "function" ? terminals() : [];
    const existing = findReusableTerminal(termList, argv, spaceId);
    if (existing) {
      if (existing.tab) run("tab.select", { id: existing.tab });
      if (existing.pane) run("pane.focus", { pane: existing.pane });
      return;
    }

    run("terminal.open", {
      argv,
      folder: target.workingDir || undefined,
      place,
    });
  }

  /**
   * Renders the floating context menu (DM-14).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderContextMenu(t, _cx) {
    const cMenu = this.contextMenu;
    if (!cMenu) return null;

    return div()
      .id("docker-context-menu-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => this.closeContextMenu(cx))
      .on_mouse_down("right", (_e, cx) => this.closeContextMenu(cx))
      .child(
        v_flex()
          .id("docker-context-menu")
          .absolute()
          .left(cMenu.x)
          .top(cMenu.y)
          .w(220)
          .p(4)
          .rounded(6)
          .bg(t.popover || t.surface)
          .border_1()
          .border_color(t.border)
          .shadow_lg()
          .text_size(11)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .children(
            cMenu.items.map((item) => {
              if (item.enabled) {
                return h_flex()
                  .id(`docker-menu-item-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`)
                  .h(24)
                  .px(8)
                  .gap(6)
                  .items_center()
                  .rounded(3)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((event, cx) => {
                    this.closeContextMenu(cx);
                    this.handleMenuAction(item, cMenu.row, event, cx);
                  })
                  .child(
                    div()
                      .flex_1()
                      .truncate()
                      .text_color(item.danger ? t.error || "#ef4444" : t.foreground)
                      .child(item.label)
                  );
              }

              return h_flex()
                .id(`docker-menu-item-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`)
                .h(item.reason ? 30 : 24)
                .px(8)
                .gap(6)
                .items_center()
                .rounded(3)
                .opacity(0.45)
                .cursor_not_allowed()
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .child(
                      div()
                        .truncate()
                        .text_color(t.dim)
                        .child(item.label)
                    )
                    .when(Boolean(item.reason), (el) =>
                      el.child(
                        div()
                          .text_size(9)
                          .text_color(t.dim)
                          .truncate()
                          .child(item.reason)
                      )
                    )
                );
            })
          )
      );
  }

  /**
   * Renders in-panel confirmation dialog for destructive actions (DM-85..87).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderConfirmDialog(t, _cx) {
    const dlg = this.confirmDialog;
    if (!dlg) return null;

    const isValid =
      dlg.kind === "typed"
        ? validateConfirmInput(dlg.kind, dlg.inputState?.value() || "", dlg.expected)
        : true;

    return div()
      .id("docker-confirm-backdrop")
      .absolute()
      .inset_0()
      .items_center()
      .justify_center()
      .on_mouse_down("left", (_e, cx) => this.closeConfirmDialog(cx))
      .child(
        v_flex()
          .id("docker-confirm-dialog")
          .w(360)
          .p(16)
          .gap(12)
          .rounded(8)
          .bg(t.popover || t.surface)
          .border_1()
          .border_color(t.border)
          .shadow_lg()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            div()
              .font_semibold()
              .text_size(13)
              .text_color(t.foreground)
              .child(dlg.item.label)
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(dlg.message)
          )
          .when(dlg.kind === "typed", (el) =>
            el.child(
              v_flex()
                .w_full()
                .gap(4)
                .child(
                  div()
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .child(`Type "${dlg.expected}" to confirm:`)
                )
                .child(
                  div()
                    .w_full()
                    .h(28)
                    .px(6)
                    .bg(t.surface)
                    .border_1()
                    .border_color(isValid ? t.border : t.error || "#ef4444")
                    .rounded(4)
                    .items_center()
                    .child(Input.new(dlg.inputState).size_full())
                )
            )
          )
          .child(
            h_flex()
              .w_full()
              .justify_end()
              .gap(8)
              .child(
                div()
                  .id("confirm-cancel-btn")
                  .px(10)
                  .py(4)
                  .rounded(4)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.closeConfirmDialog(cx))
                  .child(div().text_size(11).text_color(t.foreground).child("Cancel"))
              )
              .child(
                div()
                  .id("confirm-action-btn")
                  .px(10)
                  .py(4)
                  .rounded(4)
                  .when(!isValid, (el) => el.opacity(0.4).cursor_not_allowed())
                  .when(isValid, (el) =>
                    el
                      .cursor_pointer()
                      .bg(t.error || "#ef4444")
                      .hover((s) => s.opacity(0.9))
                      .on_click((_e, cx) => {
                        const item = dlg.item;
                        const row = dlg.row;
                        this.closeConfirmDialog(cx);
                        this.executeLifecycleAction(item, row, cx);
                      })
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color("#ffffff")
                      .font_medium()
                      .child(dlg.item.label)
                  )
              )
          )
      );
  }

  /**
   * Renders the view (GPUI render cycle).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  render(cx) {
    const t = theme();

    return v_flex()
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .on_size_change((size, _cx) => {
        this.width = size.width;
        this.height = size.height;
      })
      .on_mouse_down("left", (e, _cx) => this.updateRootOrigin(e))
      .on_mouse_down("right", (e, _cx) => this.updateRootOrigin(e))
      .child(this.renderToolbar(t, cx))
      .child(this.renderSectionSwitcher(t, cx))
      .child(this.renderFilterBar(t, cx))
      .child(this.renderBody(t, cx))
      .when(Boolean(this.contextMenu), (el) => el.child(this.renderContextMenu(t, cx)))
      .when(Boolean(this.confirmDialog), (el) => el.child(this.renderConfirmDialog(t, cx)));
  }
}
