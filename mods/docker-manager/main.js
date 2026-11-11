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
  formatRestartPolicy,
  formatImageLabel,
  formatDrawerPortRows,
  formatDrawerMounts,
  formatDrawerNetworks,
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
   * Initializes the Docker Manager view (DM-02, DM-44).
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

    if (this.inspectMode) {
      this.initInspectMode(p, cx);
      return;
    }

    this.initPanelMode(p, cx);
  }

  /**
   * Initializes full-size inspector tab mode (DM-44..46).
   *
   * @param {Record<string, any>} p
   * @param {import("gpui-kit").ViewContext} cx
   */
  initInspectMode(p, cx) {
    this.inspectTarget = p.inspect || null;
    this.inspectSubView = "overview";
    this.inspectData = null;
    this.rawInspectJson = "";
    this.inspectLoading = true;
    this.inspectError = null;
    this.targetGone = false;
    this.statsData = null;
    this.statsLoading = false;
    this.statsToken = 0;
    this.lastStatsUpdate = 0;
    this.revealedEnvKeys = new Set();
    this.revealAllSecrets = false;
    this.jsonEditorState = null;
    this.busyTargets = new Map();
    this.confirmDialog = null;

    const ctx = this.getContext();
    this.root = p.folder || ctx.root;
    this.machine = p.on || ctx.machine;

    this.wasVisible = this.isViewVisible();

    this.loadInspectTab(cx);

    // Live stats poll: only while the tab's Stats sub-view is visible
    cx.timer.every(3000, (cx) => {
      if (this.closed) return;
      if (this.inspectSubView === "stats" && this.isViewVisible()) {
        this.pollInspectStats(cx);
      }
    });
  }

  /**
   * Initializes panel mode (DM-10..43).
   *
   * @param {Record<string, any>} _p
   * @param {import("gpui-kit").ViewContext} cx
   */
  initPanelMode(_p, cx) {
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
    this.statsToken = 0;
    if (this.jsonEditorState) {
      try {
        this.jsonEditorState.release();
      } catch {}
      this.jsonEditorState = null;
    }
    if (this.filterInput) {
      try {
        this.filterInput.release();
      } catch {}
      this.filterInput = null;
    }
    if (this.confirmDialog?.inputState) {
      try {
        this.confirmDialog.inputState.release();
      } catch {}
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
    if (this.inspectMode) {
      const spaceList = spaces() || [];
      const activeSpace = spaceList.find((s) => s.active);
      if (!activeSpace) return true;
      const activeTab = (activeSpace.tabs ?? []).find((t) => t.active);
      if (!activeTab) return true;
      if (p.tab) return activeTab.id === p.tab;
      return activeTab.mod === "docker-manager";
    }
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

    const now = Date.now();
    if (this.lastClickKey === key && now - (this.lastClickTime || 0) < 350) {
      this.lastClickKey = null;
      this.lastClickTime = 0;
      if (row.type === "service" || row.type === "container") {
        this.openInspectTab(row, cx);
        return;
      }
    }
    this.lastClickKey = key;
    this.lastClickTime = now;

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
   * @param {{ isCode?: boolean, copyVal?: any, truncate?: boolean }} [opts]
   */
  renderDrawerField(label, value, t, _cx, { isCode = false, copyVal = null, truncate = false } = {}) {
    if (value === null || value === undefined || value === "") return null;
    const strVal = String(value);
    const toCopy = copyVal !== null ? copyVal : strVal;

    return h_flex()
      .w_full()
      .py(1.5)
      .px(8)
      .items_center()
      .gap(8)
      .hover((s) => s.bg(t.hover))
      .rounded(3)
      .child(
        div()
          .w(105)
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
          .when(truncate, (el) => el.truncate())
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
    const rows = formatDrawerPortRows(ports);
    if (rows.length === 0) return null;

    return h_flex()
      .w_full()
      .py(1.5)
      .px(8)
      .items_center()
      .gap(8)
      .child(
        div()
          .w(105)
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
            rows.map((p) =>
              h_flex()
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
                .when(Boolean(p.url), (el) =>
                  el.on_click((_e, cx) => cx.open_url(p.url))
                )
                .when(!p.url, (el) =>
                  el.on_click((_e, cx) => this.copyValue(p.copyVal, cx, "Port"))
                )
                .child(
                  div()
                    .font_family("monospace")
                    .text_size(10)
                    .when(Boolean(p.url), (el) => el.text_color(t.accent).underline())
                    .when(!p.url, (el) => el.text_color(t.foreground))
                    .child(p.label)
                )
            )
          )
      );
  }

  /**
   * Renders mounts in the inspector drawer (DM-41).
   *
   * @param {any[]} mounts
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderDrawerMounts(mounts, t, _cx) {
    const rows = formatDrawerMounts(mounts);
    if (rows.length === 0) return null;

    return h_flex()
      .w_full()
      .py(1.5)
      .px(8)
      .items_center()
      .gap(8)
      .child(
        div()
          .w(105)
          .flex_shrink_0()
          .text_size(10.5)
          .text_color(t.dim)
          .child("Mounts")
      )
      .child(
        h_flex()
          .flex_1()
          .flex_wrap()
          .gap(6)
          .children(
            rows.map((m) =>
              h_flex()
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
                .on_click((_e, cx) => {
                  this.copyValue(m.copyVal, cx, m.isNamed ? "Volume" : "Mount");
                  if (m.isNamed) {
                    this.section = "volumes";
                    cx.notify();
                  }
                })
                .child(
                  div()
                    .font_family("monospace")
                    .text_size(10)
                    .when(m.isNamed, (el) => el.text_color(t.accent).underline())
                    .when(!m.isNamed, (el) => el.text_color(t.foreground))
                    .truncate()
                    .child(m.text)
                )
            )
          )
      );
  }

  /**
   * Renders networks in the inspector drawer (DM-41).
   *
   * @param {any[]} networks
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderDrawerNetworks(networks, t, _cx) {
    const rows = formatDrawerNetworks(networks);
    if (rows.length === 0) return null;

    return h_flex()
      .w_full()
      .py(1.5)
      .px(8)
      .items_center()
      .gap(8)
      .child(
        div()
          .w(105)
          .flex_shrink_0()
          .text_size(10.5)
          .text_color(t.dim)
          .child("Networks")
      )
      .child(
        h_flex()
          .flex_1()
          .flex_wrap()
          .gap(6)
          .children(
            rows.map((n) =>
              h_flex()
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
                .on_click((_e, cx) => {
                  this.copyValue(n.copyVal, cx, "Network");
                  this.section = "networks";
                  cx.notify();
                })
                .child(
                  div()
                    .font_family("monospace")
                    .text_size(10)
                    .text_color(t.accent)
                    .underline()
                    .truncate()
                    .child(n.text)
                )
            )
          )
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
        h_flex()
          .items_center()
          .gap(4)
          .child(
            div()
              .id("docker-drawer-open-tab-btn")
              .w(18)
              .h(18)
              .rounded(3)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .tooltip("Open in new tab")
              .on_click((_e, cx) => {
                if (this.selectedRow) {
                  this.openInspectTab(this.selectedRow, cx);
                }
              })
              .child(svg("mods/docker-manager/icons/external.svg").size(11).text_color(t.muted))
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
          )
      );
  }

  /**
   * Renders overview fields for container/service/image/volume/network (DM-41, DM-45).
   * Shared between bottom drawer and full inspector tab Overview.
   *
   * @param {any} data
   * @param {any} row
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   * @returns {import("gpui-kit").Element[]}
   */
  renderOverviewFields(data, row, t, cx) {
    if (!data && row) {
      const config = row.data?.config;
      return [
        this.renderDrawerField("Status", row.status, t, cx),
        this.renderDrawerField("Service", row.service, t, cx),
        this.renderDrawerField("Project", row.project, t, cx),
        config?.image ? this.renderDrawerField("Image (declared)", config.image, t, cx) : null,
        config?.ports ? this.renderDrawerField("Ports (declared)", JSON.stringify(config.ports), t, cx) : null,
        config?.profiles ? this.renderDrawerField("Profiles", config.profiles.join(", "), t, cx) : null,
      ].filter(Boolean);
    }

    if (!data) return [];

    // Image inspect data
    if (data.tags !== undefined && data.architecture !== undefined) {
      return [
        this.renderDrawerField("Image ID", data.shortId || data.id, t, cx, { isCode: true, copyVal: data.id }),
        this.renderDrawerField("Tags", (data.tags || []).join(", "), t, cx),
        this.renderDrawerField("Size", data.sizeFormatted || formatBytes(data.size), t, cx),
        this.renderDrawerField("Created", formatRelativeTime(data.created) || data.created, t, cx),
        this.renderDrawerField("OS / Architecture", `${data.os} / ${data.architecture}`, t, cx),
        this.renderDrawerField("Command", (data.cmd || []).join(" "), t, cx, { isCode: true }),
        this.renderDrawerField("Entrypoint", (data.entrypoint || []).join(" "), t, cx, { isCode: true }),
      ].filter(Boolean);
    }

    // Volume inspect data
    if (data.mountpoint !== undefined && data.driver !== undefined && data.scope !== undefined && data.options !== undefined) {
      return [
        this.renderDrawerField("Name", data.name, t, cx, { isCode: true }),
        this.renderDrawerField("Driver", data.driver, t, cx),
        this.renderDrawerField("Mountpoint", data.mountpoint, t, cx, { isCode: true }),
        this.renderDrawerField("Created", formatRelativeTime(data.createdAt) || data.createdAt, t, cx),
        this.renderDrawerField("Scope", data.scope, t, cx),
      ].filter(Boolean);
    }

    // Network inspect data
    if (data.subnet !== undefined && data.gateway !== undefined && data.containers !== undefined) {
      return [
        this.renderDrawerField("Name", data.name, t, cx),
        this.renderDrawerField("Network ID", data.shortId || data.id, t, cx, { isCode: true, copyVal: data.id }),
        this.renderDrawerField("Driver", data.driver, t, cx),
        this.renderDrawerField("Scope", data.scope, t, cx),
        this.renderDrawerField("Subnet", data.subnet, t, cx, { isCode: true }),
        this.renderDrawerField("Gateway", data.gateway, t, cx, { isCode: true }),
        this.renderDrawerField("Internal", String(data.internal), t, cx),
        this.renderDrawerField("Containers", String((data.containers || []).length), t, cx),
      ].filter(Boolean);
    }

    // Standard container inspect data
    const isUnhealthy =
      data.health?.status === "unhealthy" || data.state?.status === "unhealthy";
    const lastHealthLog =
      isUnhealthy && data.health?.lastLog
        ? data.health.lastLog.replace(/\r?\n/g, " ").trim()
        : null;

    const cmdStr = Array.isArray(data.cmd) ? data.cmd.join(" ") : data.cmd || "";
    const entrypointStr = Array.isArray(data.entrypoint)
      ? data.entrypoint.join(" ")
      : data.entrypoint || "";
    const composeFilesStr = Array.isArray(data.composeFiles)
      ? data.composeFiles.join(", ")
      : data.composeFiles || "";
    const dependsOnStr = Array.isArray(data.dependsOn)
      ? data.dependsOn.join(", ")
      : data.dependsOn || "";

    const imageDisplay = formatImageLabel(
      data.image,
      data.shortImageId || data.imageShortId
    );
    const restartPolicyDisplay = formatRestartPolicy(data.restartPolicy);

    return [
      this.renderDrawerField("Container ID", data.shortId || data.id, t, cx, {
        isCode: true,
        copyVal: data.id || data.shortId,
      }),
      this.renderDrawerField("Name", data.name, t, cx),
      this.renderDrawerField("Image", imageDisplay, t, cx, {
        copyVal: data.image || data.shortImageId || imageDisplay,
      }),
      this.renderDrawerField(
        "Status",
        data.health?.status
          ? `${data.state?.status} (${data.health.status})`
          : data.state?.status,
        t,
        cx
      ),
      lastHealthLog
        ? this.renderDrawerField("Health Check", lastHealthLog, t, cx, {
            truncate: true,
            copyVal: data.health.lastLog,
          })
        : null,
      this.renderDrawerField("Restart Policy", restartPolicyDisplay, t, cx),
      this.renderDrawerPorts(data.ports, t, cx),
      this.renderDrawerMounts(data.mounts, t, cx),
      this.renderDrawerNetworks(data.networks, t, cx),
      this.renderDrawerField("Command", cmdStr, t, cx, {
        isCode: true,
        truncate: true,
        copyVal: cmdStr,
      }),
      this.renderDrawerField("Entrypoint", entrypointStr, t, cx, {
        isCode: true,
        truncate: true,
        copyVal: entrypointStr,
      }),
      this.renderDrawerField("Project", data.project, t, cx),
      this.renderDrawerField("Service", data.service, t, cx),
      this.renderDrawerField(
        "Started / Created",
        data.startedAt && data.created
          ? `${formatRelativeTime(data.startedAt) || data.startedAt} / ${formatRelativeTime(data.created) || data.created}`
          : data.startedAt || data.created,
        t,
        cx,
        { copyVal: `Started: ${data.startedAt || "-"}, Created: ${data.created || "-"}` }
      ),
      this.renderDrawerField("Working Dir", data.workingDir, t, cx, { isCode: true }),
      this.renderDrawerField("Compose Files", composeFilesStr, t, cx, {
        truncate: true,
        copyVal: composeFilesStr,
      }),
      this.renderDrawerField("Depends On", dependsOnStr, t, cx, {
        truncate: true,
        copyVal: dependsOnStr,
      }),
    ].filter(Boolean);
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
          .when(!this.inspectLoading && Boolean(data || row), (el) =>
            el.children(this.renderOverviewFields(data, row, t, cx))
          )
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
      this.openInspectTab(row, cx);
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
   * Opens an inspector tab or selects an existing one (DM-44).
   *
   * @param {any} target
   * @param {import("gpui-kit").ViewContext} [_cx]
   */
  openInspectTab(target, _cx) {
    if (!target) return;
    const tabObj = buildInspectTabProps(target, { folder: this.root, on: this.machine });
    const name = inspectTabName(target);
    const targetInspect = tabObj.props.inspect;

    const activeSpace = (spaces() || []).find((s) => s.active);
    const existing = (activeSpace?.tabs || []).find((t) => {
      if (t.mod !== "docker-manager") return false;
      const tInspect = t.props?.inspect;
      if (!tInspect) return false;
      if (targetInspect.project && targetInspect.service) {
        return (
          tInspect.project === targetInspect.project &&
          tInspect.service === targetInspect.service
        );
      }
      return tInspect.id === targetInspect.id && tInspect.kind === targetInspect.kind;
    });

    if (existing) {
      run("tab.select", { id: existing.id }).catch(() => {});
    } else {
      run("tab.new", {
        name,
        mod: "docker-manager",
        props: tabObj.props,
      }).catch(() => {});
    }
  }

  /**
   * Loads inspection data for the active inspector tab (DM-44..46).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  loadInspectTab(cx) {
    if (this.closed) return;
    this.inspectLoading = true;
    this.inspectError = null;
    this.targetGone = false;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const target = this.inspectTarget || {};
        const kind = target.kind || "container";
        let id = target.id || target.containerId || target.name || "";

        // Re-resolve Compose service across recreation if tree is available
        if (target.project && target.service && this.tree) {
          const resolved = resolveInspectorTarget(target, this.tree);
          if (resolved) {
            id = resolved;
          }
        }

        if (!id && !target.project && !target.service) {
          this.inspectLoading = false;
          this.targetGone = true;
          cx.notify();
          return;
        }

        let argv = ["inspect", "--format", "{{json .}}", id];
        if (kind === "volume") {
          argv = ["volume", "inspect", "--format", "{{json .}}", id];
        } else if (kind === "network") {
          argv = ["network", "inspect", "--format", "{{json .}}", id];
        } else if (kind === "image") {
          argv = ["inspect", "--format", "{{json .}}", id];
        }

        const res = await exec("docker", argv, {
          cwd: this.root,
          on: this.machine,
          timeout: 10000,
        });

        if (this.closed) return;

        if (res.code === 0 && res.stdout.trim()) {
          const rawStdout = res.stdout.trim();
          this.rawInspectJson = prettyJson(rawStdout);

          if (kind === "image") {
            this.inspectData = normalizeImageInspect(rawStdout);
          } else if (kind === "volume") {
            this.inspectData = normalizeVolumeInspect(rawStdout);
          } else if (kind === "network") {
            this.inspectData = normalizeNetworkInspect(rawStdout);
          } else {
            this.inspectData = normalizeContainerInspect(rawStdout);
          }

          if (this.jsonEditorState) {
            try {
              this.jsonEditorState.release();
            } catch {}
            this.jsonEditorState = null;
          }
          this.jsonEditorState = EditorState.new({
            language: "json",
            value: this.rawInspectJson,
            readonly: true,
            line_numbers: true,
            soft_wrap: false,
            font_size: 12,
            syntax: buildSyntaxTheme(theme()),
          });

          this.targetGone = false;
          this.inspectLoading = false;
          cx.notify();

          if (this.inspectSubView === "stats") {
            this.pollInspectStats(cx);
          }
        } else {
          this.targetGone = true;
          this.inspectData = null;
          this.inspectLoading = false;
          cx.notify();
        }
      } catch (err) {
        if (this.closed) return;
        this.inspectError = err.message || String(err);
        this.inspectLoading = false;
        cx.notify();
      }
    });
  }

  /**
   * Polls live container resource usage stats (DM-45).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  pollInspectStats(cx) {
    if (this.closed || !this.inspectMode || this.inspectSubView !== "stats") return;
    const kind = this.inspectTarget?.kind || "container";
    if (kind !== "container" && kind !== "service") return;
    const targetId = this.inspectData?.id || this.inspectTarget?.id;
    if (!targetId) return;

    const token = ++this.statsToken;
    this.statsLoading = !this.statsData;

    cx.spawn(async (cx) => {
      try {
        const res = await exec(
          "docker",
          ["stats", "--no-stream", "--format", "{{json .}}", targetId],
          { cwd: this.root, on: this.machine, timeout: 5000 }
        );
        if (token !== this.statsToken || this.closed) return;
        this.statsLoading = false;
        if (res.code === 0 && res.stdout) {
          this.statsData = parseDockerStats(res.stdout);
          this.lastStatsUpdate = Date.now();
          cx.notify();
        }
      } catch {
        if (token === this.statsToken && !this.closed) {
          this.statsLoading = false;
        }
      }
    });
  }

  /**
   * Switches inspector tab sub-view (DM-45).
   *
   * @param {string} id
   * @param {import("gpui-kit").ViewContext} cx
   */
  switchSubView(id, cx) {
    if (this.inspectSubView === id) return;
    this.inspectSubView = id;
    if (id === "stats") {
      this.statsToken++;
      this.pollInspectStats(cx);
    } else {
      this.statsToken++;
    }
    cx.notify();
  }

  /**
   * Opens terminal logs or shell for the inspected container or service (DM-46).
   *
   * @param {"logs" | "shell"} mode
   * @param {import("gpui-kit").ViewContext} cx
   */
  openInspectTerminal(mode, cx) {
    const isService = Boolean(this.inspectTarget?.project && this.inspectTarget?.service);
    const fakeRow = {
      type: isService ? "service" : "container",
      project: this.inspectTarget?.project || null,
      service: this.inspectTarget?.service || null,
      name: this.inspectData?.name || this.inspectTarget?.id || "",
      containerId: this.inspectData?.id || this.inspectTarget?.id || "",
      id: this.inspectData?.id || this.inspectTarget?.id || "",
      data: {
        composeFiles: this.inspectData?.composeFiles || [],
        workingDir: this.inspectData?.workingDir || this.root || null,
      },
    };
    const item = {
      id:
        mode === "logs"
          ? isService
            ? "service.logs"
            : "container.logs"
          : isService
            ? "service.shell"
            : "container.shell",
    };
    this.openTerminal(item, fakeRow, { alt: false }, cx);
  }

  /**
   * Handles lifecycle action from inspector tab header (DM-46).
   *
   * @param {string} actionName
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleInspectLifecycle(actionName, cx) {
    const isService = Boolean(this.inspectTarget?.project && this.inspectTarget?.service);
    const row = {
      type: isService ? "service" : "container",
      project: this.inspectTarget?.project || null,
      service: this.inspectTarget?.service || null,
      name: this.inspectData?.name || this.inspectTarget?.id || "",
      containerId: this.inspectData?.id || this.inspectTarget?.id || "",
      id: this.inspectData?.id || this.inspectTarget?.id || "",
      data: {
        composeFiles: this.inspectData?.composeFiles || [],
        workingDir: this.inspectData?.workingDir || this.root || null,
      },
    };
    const item = {
      id: isService ? `service.${actionName}` : `container.${actionName}`,
      label: actionName.charAt(0).toUpperCase() + actionName.slice(1),
      danger: actionName === "stop" || actionName === "down",
    };
    if (requiresConfirm(item)) {
      this.openConfirmDialog(item, row, confirmKind(item), cx);
    } else {
      this.executeLifecycleAction(item, row, cx);
    }
  }

  /**
   * Renders the full-size inspector tab (DM-44..46).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderInspectTab(cx) {
    const t = theme();

    return v_flex()
      .id("docker-inspect-tab-root")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .on_size_change((size, _cx) => {
        this.width = size.width;
        this.height = size.height;
      })
      .on_mouse_down("left", (e, _cx) => this.updateRootOrigin(e))
      .on_mouse_down("right", (e, _cx) => this.updateRootOrigin(e))
      .child(this.renderInspectHeader(t, cx))
      .child(this.renderInspectSubViewBar(t, cx))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .when(this.inspectLoading, (el) =>
            el.child(
              v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap(8)
                .child(div().text_size(12).text_color(t.muted).child("Loading inspection data…"))
            )
          )
          .when(!this.inspectLoading && Boolean(this.inspectError), (el) =>
            el.child(this.renderInspectError(t, cx))
          )
          .when(!this.inspectLoading && !this.inspectError && this.targetGone, (el) =>
            el.child(this.renderInspectGone(t, cx))
          )
          .when(!this.inspectLoading && !this.inspectError && !this.targetGone && Boolean(this.inspectData), (el) =>
            el.child(this.renderInspectActiveSubView(t, cx))
          )
      )
      .when(Boolean(this.confirmDialog), (el) => el.child(this.renderConfirmDialog(t, cx)));
  }

  /**
   * Renders the inspector tab header bar (DM-46).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderInspectHeader(t, cx) {
    const data = this.inspectData;
    const target = this.inspectTarget || {};
    const kind = target.kind || "container";
    const isRunning = data?.state?.status === "running";
    const isService = Boolean(target.project && target.service);

    // Status dot color
    let statusBg = t.muted || "#94a3b8";
    if (this.targetGone) {
      statusBg = t.error || "#ef4444";
    } else if (isRunning) {
      statusBg =
        data?.health?.status === "unhealthy"
          ? t.warning || "#f59e0b"
          : t.success || "#22c55e";
    } else if (data?.state?.status === "restarting") {
      statusBg = t.warning || "#f59e0b";
    }

    // Target icon
    let iconPath = "mods/docker-manager/icons/container.svg";
    if (isService) iconPath = "mods/docker-manager/icons/compose.svg";
    else if (kind === "image") iconPath = "mods/docker-manager/icons/layers.svg";
    else if (kind === "volume") iconPath = "mods/docker-manager/icons/volume.svg";
    else if (kind === "network") iconPath = "mods/docker-manager/icons/network.svg";

    return h_flex()
      .id("docker-inspect-header")
      .h(38)
      .w_full()
      .px(12)
      .items_center()
      .justify_between()
      .bg(t.chrome)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .min_w(0)
          .child(div().size(8).rounded_full().bg(statusBg))
          .child(svg(iconPath).size(14).text_color(t.accent))
          .when(isService, (el) =>
            el.child(
              h_flex()
                .items_center()
                .gap(4)
                .min_w(0)
                .child(
                  div()
                    .font_semibold()
                    .text_size(12)
                    .text_color(t.dim)
                    .child(target.project)
                )
                .child(div().text_size(11).text_color(t.dim).child("/"))
                .child(
                  div()
                    .font_bold()
                    .text_size(12.5)
                    .text_color(t.foreground)
                    .truncate()
                    .child(target.service)
                )
                .when(Boolean(data?.name), (sub) =>
                  sub.child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(`(${data.name})`)
                  )
                )
            )
          )
          .when(!isService, (el) => {
            let label = data?.name || target.id || "Resource";
            if (kind === "image") {
              label = data?.tags?.[0] || data?.shortId || target.id || "Image";
            }
            return el.child(
              h_flex()
                .items_center()
                .gap(6)
                .min_w(0)
                .child(
                  div()
                    .font_bold()
                    .text_size(12.5)
                    .text_color(t.foreground)
                    .truncate()
                    .child(label)
                )
                .when(Boolean(data?.shortId && data?.name), (sub) =>
                  sub.child(
                    div()
                      .font_family("monospace")
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(`(${data.shortId})`)
                  )
                )
            );
          })
      )
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .flex_shrink_0()
          .child(
            this.renderInspectHeaderBtn(
              "docker-inspect-copy-id",
              "Copy ID",
              null,
              (_e, cx) => {
                const idToCopy = data?.id || target.id || "";
                cx.write_to_clipboard(idToCopy);
                notify({
                  title: "Copied ID",
                  body: idToCopy.slice(0, 12),
                  level: "info",
                });
              },
              t
            )
          )
          .when(Boolean(data && (kind === "container" || kind === "service")), (el) =>
            el
              .when(!isRunning, (b) =>
                b.child(
                  this.renderInspectHeaderBtn(
                    "docker-inspect-start",
                    "Start",
                    "mods/docker-manager/icons/play.svg",
                    (_e, cx) => this.handleInspectLifecycle("start", cx),
                    t
                  )
                )
              )
              .when(isRunning, (b) =>
                b.child(
                  this.renderInspectHeaderBtn(
                    "docker-inspect-stop",
                    "Stop",
                    "mods/docker-manager/icons/stop.svg",
                    (_e, cx) => this.handleInspectLifecycle("stop", cx),
                    t
                  )
                )
              )
              .child(
                this.renderInspectHeaderBtn(
                  "docker-inspect-restart",
                  "Restart",
                  "mods/docker-manager/icons/restart.svg",
                  (_e, cx) => this.handleInspectLifecycle("restart", cx),
                  t
                )
              )
              .when(isService, (b) =>
                b.child(
                  this.renderInspectHeaderBtn(
                    "docker-inspect-rebuild",
                    "Rebuild",
                    null,
                    (_e, cx) => this.handleInspectLifecycle("rebuild", cx),
                    t
                  )
                )
              )
              .child(
                this.renderInspectHeaderBtn(
                  "docker-inspect-logs",
                  "Logs",
                  "mods/docker-manager/icons/logs.svg",
                  (_e, cx) => this.openInspectTerminal("logs", cx),
                  t
                )
              )
              .child(
                this.renderInspectHeaderBtn(
                  "docker-inspect-shell",
                  "Shell",
                  "mods/docker-manager/icons/terminal.svg",
                  (_e, cx) => this.openInspectTerminal("shell", cx),
                  t
                )
              )
          )
          .child(
            this.renderInspectHeaderBtn(
              "docker-inspect-refresh",
              "Refresh",
              "mods/docker-manager/icons/refresh.svg",
              (_e, cx) => this.loadInspectTab(cx),
              t
            )
          )
      );
  }

  /**
   * Renders a button in the inspector tab header.
   */
  renderInspectHeaderBtn(id, label, iconPath, onClick, t) {
    return h_flex()
      .id(id)
      .px(8)
      .py(3)
      .rounded(4)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .items_center()
      .gap(4)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .when(Boolean(iconPath), (el) =>
        el.child(svg(iconPath).size(11).text_color(t.muted))
      )
      .child(
        div()
          .text_size(10.5)
          .text_color(t.foreground)
          .font_medium()
          .child(label)
      );
  }

  /**
   * Renders the inspector sub-view switcher bar (DM-45).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderInspectSubViewBar(t, _cx) {
    const subViews = [
      { id: "overview", label: "Overview", icon: "container" },
      { id: "env", label: "Environment", icon: "docker" },
      { id: "mounts", label: "Mounts", icon: "volume" },
      { id: "network", label: "Network", icon: "network" },
      { id: "labels", label: "Labels", icon: "layers" },
      { id: "stats", label: "Stats", icon: "whale" },
      { id: "json", label: "Raw JSON", icon: "compose" },
    ];

    return h_flex()
      .id("docker-inspect-subview-bar")
      .h(32)
      .w_full()
      .px(8)
      .items_center()
      .gap(4)
      .bg(t.chrome)
      .border_b_1()
      .border_color(t.border)
      .children(
        subViews.map((sv) => {
          const isActive = this.inspectSubView === sv.id;
          return h_flex()
            .id(`docker-inspect-subview-${sv.id}`)
            .px(10)
            .py(3)
            .rounded(4)
            .items_center()
            .gap(5)
            .cursor_pointer()
            .when(isActive, (el) =>
              el
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
            )
            .when(!isActive, (el) =>
              el.hover((s) => s.bg(t.hover))
            )
            .on_click((_e, cx) => this.switchSubView(sv.id, cx))
            .child(
              svg(`mods/docker-manager/icons/${sv.icon}.svg`)
                .size(11)
                .text_color(isActive ? t.accent : t.muted)
            )
            .child(
              div()
                .text_size(11)
                .when(isActive, (el) => el.font_semibold().text_color(t.foreground))
                .when(!isActive, (el) => el.text_color(t.muted))
                .child(sv.label)
            );
        })
      );
  }

  /**
   * Renders the active sub-view content (DM-45).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderInspectActiveSubView(t, cx) {
    switch (this.inspectSubView) {
      case "overview":
        return this.renderInspectOverview(t, cx);
      case "env":
        return this.renderInspectEnv(t, cx);
      case "mounts":
        return this.renderInspectMounts(t, cx);
      case "network":
        return this.renderInspectNetwork(t, cx);
      case "labels":
        return this.renderInspectLabels(t, cx);
      case "stats":
        return this.renderInspectStats(t, cx);
      case "json":
        return this.renderInspectRawJson(t, cx);
      default:
        return this.renderInspectOverview(t, cx);
    }
  }

  /**
   * Renders the Overview sub-view reusing drawer field renderers (DM-41, DM-45).
   */
  renderInspectOverview(t, cx) {
    const fields = this.renderOverviewFields(this.inspectData, null, t, cx);
    return v_flex()
      .id("docker-inspect-overview-view")
      .size_full()
      .overflow_y_scrollbar()
      .p(12)
      .gap(2)
      .children(fields);
  }

  /**
   * Renders the Environment sub-view with secret masking and reveal toggle (DM-45).
   */
  renderInspectEnv(t, cx) {
    const rawEnv = this.inspectData?.env || [];
    const revealed = this.revealAllSecrets ? true : this.revealedEnvKeys;
    const entries = maskEnvEntries(rawEnv, revealed);

    if (entries.length === 0) {
      return div()
        .id("docker-inspect-env-view")
        .p(24)
        .text_size(11.5)
        .text_color(t.muted)
        .child("No environment variables defined.");
    }

    return v_flex()
      .id("docker-inspect-env-view")
      .size_full()
      .child(
        h_flex()
          .h(32)
          .w_full()
          .px(12)
          .items_center()
          .justify_between()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .child(
            div()
              .text_size(11)
              .font_medium()
              .text_color(t.dim)
              .child(`${entries.length} environment variables`)
          )
          .child(
            h_flex()
              .id("docker-inspect-env-reveal-all")
              .px(8)
              .py(3)
              .rounded(4)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .items_center()
              .gap(4)
              .on_click((_e, cx) => {
                this.revealAllSecrets = !this.revealAllSecrets;
                cx.notify();
              })
              .child(
                svg("mods/docker-manager/icons/eye.svg")
                  .size(11)
                  .text_color(this.revealAllSecrets ? t.accent : t.muted)
              )
              .child(
                div()
                  .text_size(10.5)
                  .text_color(t.foreground)
                  .child(this.revealAllSecrets ? "Hide secrets" : "Reveal secrets")
              )
          )
      )
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scrollbar()
          .p(12)
          .gap(2)
          .children(
            entries.map((entry) =>
              h_flex()
                .w_full()
                .py(3)
                .px(8)
                .items_center()
                .gap(12)
                .rounded(4)
                .hover((s) => s.bg(t.hover))
                .child(
                  div()
                    .w(220)
                    .flex_shrink_0()
                    .font_family("monospace")
                    .text_size(11)
                    .font_medium()
                    .text_color(entry.secret ? t.accent : t.foreground)
                    .truncate()
                    .child(entry.key)
                )
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .items_center()
                    .gap(6)
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      const orig = Array.isArray(rawEnv)
                        ? (rawEnv.find((s) => typeof s === "string" && s.startsWith(`${entry.key}=`)) || "")
                            .slice(entry.key.length + 1)
                        : (rawEnv[entry.key] ?? "");
                      cx.write_to_clipboard(orig);
                      notify({ title: `Copied ${entry.key}`, level: "info" });
                    })
                    .child(
                      div()
                        .font_family("monospace")
                        .text_size(11)
                        .text_color(entry.masked ? t.dim : t.foreground)
                        .truncate()
                        .child(entry.value)
                    )
                    .when(entry.secret && entry.masked, (el) =>
                      el.child(
                        div()
                          .px(4)
                          .py(0.5)
                          .rounded(3)
                          .bg(t.surface)
                          .border_1()
                          .border_color(t.border)
                          .text_size(9)
                          .text_color(t.dim)
                          .child("secret")
                      )
                    )
                )
                .when(entry.secret, (el) =>
                  el.child(
                    div()
                      .w(20)
                      .h(20)
                      .rounded(3)
                      .items_center()
                      .justify_center()
                      .cursor_pointer()
                      .hover((s) => s.bg(t.surface))
                      .on_click((_e, cx) => {
                        if (this.revealAllSecrets) {
                          this.revealAllSecrets = false;
                          this.revealedEnvKeys = new Set(
                            entries.filter((e) => e.secret && e.key !== entry.key).map((e) => e.key)
                          );
                        } else if (this.revealedEnvKeys.has(entry.key)) {
                          this.revealedEnvKeys.delete(entry.key);
                        } else {
                          this.revealedEnvKeys.add(entry.key);
                        }
                        cx.notify();
                      })
                      .child(
                        svg("mods/docker-manager/icons/eye.svg")
                          .size(11)
                          .text_color(entry.masked ? t.muted : t.accent)
                      )
                  )
                )
            )
          )
      );
  }

  /**
   * Renders the Mounts sub-view (DM-45).
   */
  renderInspectMounts(t, cx) {
    const mounts = this.inspectData?.mounts || [];
    if (mounts.length === 0) {
      return div()
        .id("docker-inspect-mounts-view")
        .p(24)
        .text_size(11.5)
        .text_color(t.muted)
        .child("No mounts configured.");
    }

    return v_flex()
      .id("docker-inspect-mounts-view")
      .size_full()
      .child(
        h_flex()
          .h(32)
          .w_full()
          .px(12)
          .items_center()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .child(div().text_size(11).font_medium().text_color(t.dim).child(`${mounts.length} mounts`))
      )
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scrollbar()
          .p(12)
          .gap(4)
          .children(
            mounts.map((m) =>
              h_flex()
                .w_full()
                .py(4)
                .px(8)
                .items_center()
                .gap(8)
                .rounded(4)
                .hover((s) => s.bg(t.hover))
                .child(
                  div()
                    .w(60)
                    .flex_shrink_0()
                    .px(4)
                    .py(1)
                    .rounded(3)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .text_size(9.5)
                    .text_color(t.accent)
                    .child(m.type || "volume")
                )
                .child(
                  div()
                    .w(50)
                    .flex_shrink_0()
                    .text_size(10)
                    .font_semibold()
                    .text_color(m.rw ? (t.success || "#22c55e") : t.muted)
                    .child(m.rw ? "rw" : "ro")
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      cx.write_to_clipboard(`${m.source} -> ${m.destination}`);
                      notify({ title: "Copied mount path", level: "info" });
                    })
                    .child(
                      div()
                        .font_family("monospace")
                        .text_size(10.5)
                        .text_color(t.foreground)
                        .truncate()
                        .child(m.destination)
                    )
                    .child(
                      div()
                        .font_family("monospace")
                        .text_size(9.5)
                        .text_color(t.dim)
                        .truncate()
                        .child(`from: ${m.source}`)
                    )
                )
            )
          )
      );
  }

  /**
   * Renders the Network sub-view (DM-45).
   */
  renderInspectNetwork(t, cx) {
    const isNetworkTarget = this.inspectTarget?.kind === "network";
    if (isNetworkTarget) {
      const net = this.inspectData || {};
      const containers = net.containers || [];
      return v_flex()
        .id("docker-inspect-network-view")
        .size_full()
        .child(
          h_flex()
            .h(32)
            .w_full()
            .px(12)
            .items_center()
            .bg(t.chrome)
            .border_b_1()
            .border_color(t.border)
            .child(
              div()
                .text_size(11)
                .font_medium()
                .text_color(t.dim)
                .child(`${containers.length} connected containers`)
            )
        )
        .child(
          v_flex()
            .flex_1()
            .overflow_y_scrollbar()
            .p(12)
            .gap(4)
            .children(
              containers.map((c) =>
                h_flex()
                  .w_full()
                  .py(3)
                  .px(8)
                  .items_center()
                  .gap(8)
                  .rounded(4)
                  .hover((s) => s.bg(t.hover))
                  .cursor_pointer()
                  .on_click((_e, cx) => {
                    cx.write_to_clipboard(c.ip || c.name);
                    notify({ title: "Copied container IP", level: "info" });
                  })
                  .child(
                    div()
                      .w(180)
                      .flex_shrink_0()
                      .font_semibold()
                      .text_size(11)
                      .text_color(t.foreground)
                      .truncate()
                      .child(c.name)
                  )
                  .child(
                    div()
                      .w(140)
                      .font_family("monospace")
                      .text_size(10.5)
                      .text_color(t.accent)
                      .child(c.ip || "-")
                  )
                  .child(
                    div()
                      .flex_1()
                      .font_family("monospace")
                      .text_size(10)
                      .text_color(t.dim)
                      .child(c.macAddress || "-")
                  )
              )
            )
        );
    }

    const networks = this.inspectData?.networks || [];
    if (networks.length === 0) {
      return div()
        .id("docker-inspect-network-view")
        .p(24)
        .text_size(11.5)
        .text_color(t.muted)
        .child("No networks connected.");
    }

    return v_flex()
      .id("docker-inspect-network-view")
      .size_full()
      .child(
        h_flex()
          .h(32)
          .w_full()
          .px(12)
          .items_center()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .child(
            div()
              .text_size(11)
              .font_medium()
              .text_color(t.dim)
              .child(`${networks.length} connected networks`)
          )
      )
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scrollbar()
          .p(12)
          .gap(4)
          .children(
            networks.map((net) =>
              h_flex()
                .w_full()
                .py(4)
                .px(8)
                .items_center()
                .gap(12)
                .rounded(4)
                .hover((s) => s.bg(t.hover))
                .child(
                  div()
                    .w(160)
                    .flex_shrink_0()
                    .font_semibold()
                    .text_size(11)
                    .text_color(t.accent)
                    .truncate()
                    .child(net.name)
                )
                .child(
                  div()
                    .w(130)
                    .flex_shrink_0()
                    .font_family("monospace")
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      cx.write_to_clipboard(net.ip);
                      notify({ title: "Copied IP address", level: "info" });
                    })
                    .child(net.ip || "-")
                )
                .child(
                  div()
                    .w(130)
                    .flex_shrink_0()
                    .font_family("monospace")
                    .text_size(10)
                    .text_color(t.dim)
                    .child(`GW: ${net.gateway || "-"}`)
                )
                .child(
                  div()
                    .flex_1()
                    .font_family("monospace")
                    .text_size(10)
                    .text_color(t.dim)
                    .truncate()
                    .child(Array.isArray(net.aliases) ? net.aliases.join(", ") : "-")
                )
            )
          )
      );
  }

  /**
   * Renders the Labels sub-view (DM-45).
   */
  renderInspectLabels(t, cx) {
    const labels = this.inspectData?.labels || {};
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));

    if (entries.length === 0) {
      return div()
        .id("docker-inspect-labels-view")
        .p(24)
        .text_size(11.5)
        .text_color(t.muted)
        .child("No labels defined.");
    }

    return v_flex()
      .id("docker-inspect-labels-view")
      .size_full()
      .child(
        h_flex()
          .h(32)
          .w_full()
          .px(12)
          .items_center()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .child(
            div()
              .text_size(11)
              .font_medium()
              .text_color(t.dim)
              .child(`${entries.length} labels`)
          )
      )
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scrollbar()
          .p(12)
          .gap(2)
          .children(
            entries.map(([key, val]) =>
              h_flex()
                .w_full()
                .py(3)
                .px(8)
                .items_center()
                .gap(12)
                .rounded(4)
                .hover((s) => s.bg(t.hover))
                .cursor_pointer()
                .on_click((_e, cx) => {
                  cx.write_to_clipboard(`${key}=${val}`);
                  notify({ title: `Copied label: ${key}`, level: "info" });
                })
                .child(
                  div()
                    .w(260)
                    .flex_shrink_0()
                    .font_family("monospace")
                    .text_size(10.5)
                    .text_color(t.accent)
                    .truncate()
                    .child(key)
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .font_family("monospace")
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .truncate()
                    .child(String(val))
                )
            )
          )
      );
  }

  /**
   * Renders the Stats sub-view (DM-45).
   */
  renderInspectStats(t, cx) {
    const isRunning = this.inspectData?.state?.status === "running";
    if (!isRunning) {
      return div()
        .id("docker-inspect-stats-view")
        .p(24)
        .text_size(11.5)
        .text_color(t.muted)
        .child("Container is not running — live stats are only available for running containers.");
    }

    const stats = this.statsData;
    if (!stats && this.statsLoading) {
      return div()
        .id("docker-inspect-stats-view")
        .p(24)
        .text_size(11.5)
        .text_color(t.muted)
        .child("Connecting to container stats stream…");
    }

    if (!stats) {
      return div()
        .id("docker-inspect-stats-view")
        .p(24)
        .text_size(11.5)
        .text_color(t.muted)
        .child("No stats data received yet.");
    }

    return v_flex()
      .id("docker-inspect-stats-view")
      .size_full()
      .child(
        h_flex()
          .h(32)
          .w_full()
          .px(12)
          .items_center()
          .justify_between()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(div().size(6).rounded_full().bg(t.success || "#22c55e"))
              .child(div().text_size(10.5).text_color(t.muted).child("Live (refreshes every 3s)"))
          )
          .child(
            h_flex()
              .px(6)
              .py(2)
              .rounded(3)
              .cursor_pointer()
              .hover((s) => s.bg(t.surface))
              .on_click((_e, cx) => this.pollInspectStats(cx))
              .child(svg("mods/docker-manager/icons/refresh.svg").size(11).text_color(t.muted))
          )
      )
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scrollbar()
          .p(16)
          .gap(12)
          .child(
            h_flex()
              .w_full()
              .gap(12)
              .child(this.renderStatCard("CPU USAGE", stats.cpuPerc, null, t))
              .child(this.renderStatCard("MEMORY USAGE", stats.memUsageRaw, stats.memPerc, t))
          )
          .child(
            h_flex()
              .w_full()
              .gap(12)
              .child(this.renderStatCard("NETWORK I/O", stats.netIO, null, t))
              .child(this.renderStatCard("BLOCK I/O", stats.blockIO, null, t))
          )
          .child(
            h_flex()
              .w_full()
              .gap(12)
              .child(this.renderStatCard("PIDS (PROCESSES)", String(stats.pids), null, t))
          )
      );
  }

  /**
   * Renders a statistic display card.
   */
  renderStatCard(title, value, sub, t) {
    return v_flex()
      .flex_1()
      .p(12)
      .rounded(6)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .gap(4)
      .child(div().text_size(10).font_semibold().text_color(t.dim).child(title))
      .child(
        div()
          .font_family("monospace")
          .font_bold()
          .text_size(15)
          .text_color(t.foreground)
          .child(value)
      )
      .when(Boolean(sub), (el) =>
        el.child(div().text_size(10.5).text_color(t.muted).child(sub))
      );
  }

  /**
   * Renders the Raw JSON sub-view (DM-45).
   */
  renderInspectRawJson(t, cx) {
    return v_flex()
      .id("docker-inspect-raw-json-view")
      .size_full()
      .child(
        h_flex()
          .h(32)
          .w_full()
          .px(12)
          .items_center()
          .justify_between()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .child(div().text_size(11).text_color(t.muted).child("docker inspect output (JSON)"))
          .child(
            h_flex()
              .id("docker-inspect-copy-json")
              .px(8)
              .py(3)
              .rounded(4)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .items_center()
              .gap(4)
              .on_click((_e, cx) => {
                const text = this.rawInspectJson || prettyJson(this.inspectData?.raw || this.inspectData || {});
                cx.write_to_clipboard(text);
                notify({ title: "Copied JSON to clipboard", level: "info" });
              })
              .child(div().text_size(10.5).text_color(t.foreground).child("Copy JSON"))
          )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .when(Boolean(this.jsonEditorState), (el) =>
            el.child(Editor.new(this.jsonEditorState).id("docker-raw-json").flex_1().min_h(0))
          )
          .when(!this.jsonEditorState, (el) =>
            el.child(
              v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .child(div().text_size(11).text_color(t.muted).child("Loading JSON…"))
            )
          )
      );
  }

  /**
   * Renders target gone placeholder (DM-46).
   */
  renderInspectGone(t, cx) {
    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .p(32)
      .gap(12)
      .child(svg("mods/docker-manager/icons/trash.svg").size(32).text_color(t.muted))
      .child(
        div()
          .font_semibold()
          .text_size(14)
          .text_color(t.foreground)
          .child("Target is no longer available")
      )
      .child(
        div()
          .text_size(11.5)
          .text_color(t.muted)
          .child("The container or service has been removed or no longer exists.")
      )
      .child(
        div()
          .px(10)
          .py(4)
          .rounded(4)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.loadInspectTab(cx))
          .child(div().text_size(11).text_color(t.foreground).child("Re-check"))
      );
  }

  /**
   * Renders inspect loading error.
   */
  renderInspectError(t, cx) {
    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .p(32)
      .gap(12)
      .child(
        div()
          .font_semibold()
          .text_size(14)
          .text_color(t.error || "#ef4444")
          .child("Failed to load inspection data")
      )
      .child(
        div()
          .text_size(11.5)
          .text_color(t.muted)
          .child(String(this.inspectError))
      )
      .child(
        div()
          .px(10)
          .py(4)
          .rounded(4)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.loadInspectTab(cx))
          .child(div().text_size(11).text_color(t.foreground).child("Retry"))
      );
  }

  /**
   * Renders the Docker Manager panel mode.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  renderPanel(cx) {
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

  /**
   * Renders the view (GPUI render cycle).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  render(cx) {
    if (this.inspectMode) {
      return this.renderInspectTab(cx);
    }
    return this.renderPanel(cx);
  }
}
