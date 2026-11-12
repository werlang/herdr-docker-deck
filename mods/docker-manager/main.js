// Herdr mod: docker-manager
// Native panel to observe, inspect, and manage Docker containers, Compose projects,
// images, volumes, networks, and hygiene directly within Herdr.

import { View, div, svg } from "gpui-kit";
import {
  v_flex,
  h_flex,
  InputState,
  Input,
  v_resizable,
  resizable_panel,
} from "gpui-base";
import {
  exec,
  hc,
  spaces,
  panes,
  focused,
  terminals,
  props,
  settings,
  layout,
  theme,
  shared,
  notify,
  closeOverlay,
  run,
  watchFolder,
  readTextFile,
  appHome,
} from "herdr";
import {
  resolveDockerContext,
  parseContainerLabels,
  buildContainerTree,
  normalizeContainerInspect,
  isSecretEnvKey,
  validateDockerIdentifier,
  classifyDockerFile,
  buildComposeArgs,
  buildComposeUpArgs,
  buildComposeDownArgs,
  buildComposeStartArgs,
  buildComposeStopArgs,
  buildComposeRestartArgs,
  buildComposePullArgs,
  buildComposeBuildArgs,
  buildComposeRebuildArgs,
  buildComposeRecreateArgs,
  buildComposeRmArgs,
  buildComposeLogsArgs,
  buildContainerLogsArgs,
  buildContainerShellArgs,
  buildContainerActionArgs,
  buildContainerRmArgs,
  getProjectMenuItems,
  getServiceMenuItems,
  getContainerMenuItems,
  buildConfirmationSpec,
  findExistingActionTerminal,
  resolveDockerMenuPosition,
  groupDiscoveredComposeFiles,
  parseComposeConfigJson,
  composeProjectNameFromFolder,
  buildHiddenTerminalArgs,
  parseHcTerminalAddress,
  parseHcWaitResult,
  stripAnsiCodes,
  isLightColor,
  parseDockerfileExpose,
  getDockerfileMenuItems,
  buildDockerfileBuildArgs,
  buildDockerfileRunArgs,
  resolveServiceContainerId,
  matchDockerRequestTarget,
  parseDockerSizeBytes,
  isAnonymousVolume,
  buildImageTree,
  getImageMenuItems,
  buildVolumeTree,
  getVolumeMenuItems,
  buildNetworkTree,
  getNetworkMenuItems,
  parseSystemDf,
  parseSystemDfVerbose,
  buildGranularPrunePlan,
  normalizeImageInspect,
  normalizeVolumeInspect,
  normalizeNetworkInspect,
  buildImageRmArgs,
  buildImagePruneArgs,
  buildImageHistoryArgs,
  buildVolumeBackupArgs,
  buildVolumeRestoreArgs,
  buildVolumeCloneArgs,
  buildVolumeBrowseArgs,
  buildVolumePruneArgs,
  buildNetworkInspectArgs,
  buildNetworkPruneArgs,
  buildNetworkRmArgs,
  buildSystemDfArgs,
  buildBuilderPruneArgs,
} from "./docker-logic.js";

/** Helper to cast color string to typed GPUI Color */
const toColor = (c) => /** @type {`#${string}`} */ (c);

export default class DockerManager extends View {
  init(propsData, cx) {
    this.handle = cx.focus_handle();
    this.sections = ["containers", "images", "volumes", "networks", "system"];
    this.activeSection = "containers";
    this.scope = "all"; // "all" | "space" (DM-35..36)
    this.terminalPlace = "tab";

    // Panel size & tracking
    this.panelSize = { width: 368, height: 600 };

    // Filter input (DM-12)
    this.filterQuery = "";
    this.filterInput = InputState.new({ placeholder: "Filter containers, services, ports…" });
    this.filterInput.on("change", (_e, cx) => {
      this.filterQuery = this.filterInput.value().toLowerCase().trim();
      cx.notify();
    });

    // Expansion tracking (DM-26)
    this.expandedGroups = new Set(["projects", "dockerfiles", "standalone", "builtin-networks"]);
    this.expandedProjects = new Set();
    this.userCollapsedProjects = new Set();
    this.expandedServices = new Set();
    this.rowByKey = new Map();
    this.projectByName = new Map();
    this.projectByDisplay = new Map();

    // Double-click tracking (DM-14, DM-44)
    this.lastClickedKey = null;
    this.lastClickTime = 0;

    // Selected item & drawer state (DM-40..43)
    this.selectedTarget = null;
    this.inspectData = null;
    this.inspectLoading = false;
    this.drawerOpen = false;
    this.drawerHeight = 220;

    // Overlays: Context menu, confirmation dialog, toolbar menu (DM-10, DM-14, DM-85..86)
    this.contextMenu = null; // { row, x, y, items }
    this.pendingContextTarget = null; // row key remembered by the row, opened by the panel root
    this.confirmDialog = null; // { title, message, confirmLabel, destructive, typedTarget, onConfirm }
    this.confirmInput = InputState.new("");
    this.confirmInputValue = "";
    this.confirmInput.on("change", (_e, cx) => {
      this.confirmInputValue = this.confirmInput.value();
      cx.notify();
    });
    this.toolbarMenuOpen = false;
    this.lastErrorText = null;

    // Engine probe & state (DM-15)
    this.engineStatus = "probing"; // "ready" | "unavailable" | "probing"
    this.engineVersion = "";
    this.engineError = "";

    // Live data caches
    this.containersRaw = [];
    this.composeLsRaw = [];
    this.discoveredCompose = [];
    this.discoveredDockerfiles = [];
    this.refreshSeq = 0;
    this.refreshing = false; // drives the toolbar refresh spinner
    this.busyTargets = new Map(); // targetKey -> actionLabel
    this.newPaneInstalled = false;
    readTextFile(`${appHome()}/mods/new-pane/mod.json`)
      .then((text) => {
        this.newPaneInstalled = typeof text === "string";
        if (this.newPaneInstalled) cx.notify();
      })
      .catch(() => {});
    this.actionSeq = 0;
    this.busyToasts = new Map(); // targetKey -> { id, seq } for progress notifications

    // Inspector Tab Mode state (DM-44..46)
    this.inspectTabSubView = propsData?.inspect?.subView || "overview"; // overview | env | mounts | network | labels | stats | raw
    this.revealedSecrets = new Set();
    this.liveStats = null;
    this.inspectDataRaw = null;
    this.inspectLoadKey = null;
    // The inspector tab loads off the render path: calling loadInspectData from render() sets
    // inspectLoading and the render-scoped context drops the spawn. `propsData` is not reliable
    // here (it can arrive empty), so poll props() and pick the target up when it is there.
    cx.timer.every(1000, (cx) => {
      if (this.inspectData) return; // loaded: stop costing a tick per second (DESIGN §5.1)
      this.ensureInspectorTarget(cx);
    });
    cx.spawn(async (cx) => {
      await null;
      this.ensureInspectorTarget(cx);
    });
    if (this.inspectTabSubView === "stats" && propsData?.inspect?.id) {
      this.pollStats(propsData.inspect.id, cx);
    }

    // Dockerfile modal & runs state (DM-75..78)
    this.dockerfileRuns = this.loadDockerfileRuns();
    this.dockerfileDialog = null; // { action, filePath, folder, defaultTag, defaultName }
    this.dfTagInput = InputState.new("");
    this.dfContainerNameInput = InputState.new("");
    this.dfPortsInput = InputState.new("");
    this.dfDetached = true;

    // P4 State (Images, Volumes, Networks, System) (DM-100..123)
    this.imagesRaw = [];
    this.volumesRaw = [];
    this.networksRaw = [];
    this.networkInspectMap = {};
    this.systemDfParsed = null;
    this.systemDfVerbose = null;
    this.systemDfLoading = false;
    this.volumeSizes = {};
    this.imageSortBy = "name"; // "name" | "size" | "created"
    this.volumeSortBy = "name"; // "name" | "size" | "created"
    this.imageInUseFirst = false;
    this.volumeInUseFirst = false;
    this.sortMenuOpen = null; // "images" | "volumes" | null
    this.engineInfoRaw = null;
    this.granularPruneSelections = {
      containers: false,
      danglingImages: false,
      unusedImages: false,
      networks: false,
      volumes: false,
      buildCache: false,
      buildCacheOlderThan7d: false,
    };

    // Image dialog state (DM-101)
    this.imageDialog = null; // { action: "run" | "tag", image }
    this.imgRunNameInput = InputState.new("");
    this.imgRunPortsInput = InputState.new("");
    this.imgRunEnvInput = InputState.new("");
    this.imgRunDetached = true;
    this.imgTagInput = InputState.new("");

    // Volume dialog state (DM-107..109)
    this.volumeDialog = null; // { action: "backup" | "restore" | "clone", volume }
    this.volDestDirInput = InputState.new("");
    this.volArchiveNameInput = InputState.new("");
    this.volSrcDirInput = InputState.new("");
    this.volRestoreArchiveInput = InputState.new("");
    this.volCloneDestInput = InputState.new("");
    this.volTypedConfirmInput = InputState.new("");

    // Compose config cache & profile tracking (DM-30..33)
    this.composeConfigCache = new Map();
    this.expandedProfiles = new Set();
    this.watchedCwd = null;
    this.scannedCwd = null;
    this.workspaceDirty = true;

    // Cross-mod request tracking (DM-93, INTEGRATION §3.4)
    this.lastHandledRequestTs = 0;

    // Visibility-aware timer: 3000ms polling (DESIGN §5.1)
    cx.timer.every(3000, (cx) => this.poll(cx));

    // Initial probe and fast refresh
    this.refresh(cx);
  }

  loadDockerfileRuns() {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem("docker-manager.dockerfileRuns") : null;
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  saveDockerfileRuns() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("docker-manager.dockerfileRuns", JSON.stringify(this.dockerfileRuns));
      }
    } catch {}
  }

  /** Checks if this mod instance is currently visible on screen */
  isPanelVisible() {
    const p = props();
    if (p?.inspect || p?.pane) return true;

    const lay = layout();
    if (!lay) return true;

    function findNode(node, id) {
      if (!node) return null;
      if (node.id === id) return node;
      if (node.children) {
        for (const ch of node.children) {
          const found = findNode(ch, id);
          if (found) return found;
        }
      }
      return null;
    }

    const panel = findNode(lay, "panel");
    const panelBody = findNode(lay, "panel-body");
    if (panel && panel.hidden) return false;
    if (panelBody && panelBody.active !== "docker") return false;
    return true;
  }

  /** Polling handler called every 3 seconds */
  poll(cx) {
    if (!this.isPanelVisible()) return;

    const p = props();
    // An inspector tab already has its target; running the full list/workspace
    // refresh there every 3s is pure load. Only the panel needs the sweep.
    if (!p?.inspect) this.refresh(cx);

    // In inspector tab mode, poll live stats if stats sub-view is open
    if (p?.inspect && this.inspectTabSubView === "stats") {
      let cid = p.inspect.id;
      if (p.inspect.project && p.inspect.service) {
        cid = resolveServiceContainerId(this.containersRaw, p.inspect.project, p.inspect.service, cid);
      }
      this.pollStats(cid, cx);
    }
  }

  /** Consumes shared("docker-manager.request") for cross-mod reveal & build-run (DM-93, INTEGRATION §3.4) */
  checkCrossModRequest(cx) {
    const req = shared("docker-manager.request");
    if (req && typeof req === "object" && req.ts && req.ts > (this.lastHandledRequestTs || 0)) {
      this.lastHandledRequestTs = req.ts;
      this.activeSection = "containers";

      const ctx = resolveDockerContext({
        props: props(),
        spaces: spaces(),
        panes: panes(),
        terminals: terminals(),
        focused: focused(),
        shared,
      });

      const tree = buildContainerTree({
        containers: this.containersRaw,
        composeLs: this.composeLsRaw,
        discoveredCompose: this.discoveredCompose,
        discoveredDockerfiles: this.discoveredDockerfiles,
        spaceRoot: ctx.cwd,
        scope: this.scope,
        filter: this.filterQuery,
      });

      const matched = matchDockerRequestTarget(req, tree);
      if (matched) {
        if (matched.type === "project") {
          this.expandedProjects.add(matched.target.name);
          this.selectTarget({ ...matched.target, key: `proj:${matched.target.name}` }, cx);
        } else if (matched.type === "dockerfile") {
          this.expandedProjects.add(matched.target.filePath);
          this.selectTarget({ ...matched.target, key: `df:${matched.target.filePath}` }, cx);
          if (req.action === "build-run") {
            this.openDockerfileModal(matched.target, "build-run", cx);
          }
        }
      }
      cx.notify();
    }
  }

  openDockerfileModal(df, action, cx) {
    // Open with defaults immediately, then fill the EXPOSE-derived fields once the file is read.
    // The read is an await, so it must not run on the event context (AGENTS.md).
    this.buildDockerfileDialog(df, action, "");
    cx.notify();
    cx.spawn(async (cx) => {
      let content = "";
      try {
        content = await readTextFile(df.filePath);
      } catch {
        content = "";
      }
      if (!this.dockerfileDialog || this.dockerfileDialog.filePath !== df.filePath) return;
      this.buildDockerfileDialog(df, action, content);
      cx.notify();
    });
  }

  /** Builds the Dockerfile dialog state from the file text ("" when it could not be read). */
  buildDockerfileDialog(df, action, content) {
    const folder = df.filePath.slice(0, df.filePath.lastIndexOf("/")) || ".";
    const folderName = folder.split("/").pop() || "app";
    const defaultTag = `${folderName}:dev`;
    const defaultName = `${folderName}-dev`;

    let prefilledPorts = "";
    try {
      const exposed = parseDockerfileExpose(content || "");
      if (exposed.length > 0) {
        prefilledPorts = exposed.map((p) => `${p}:${p}`).join(", ");
      }
    } catch {}

    const lastRun = this.dockerfileRuns[df.filePath];
    const tag = lastRun?.tag || defaultTag;
    const containerName = lastRun?.containerName || defaultName;
    const ports = lastRun?.ports
      ? (Array.isArray(lastRun.ports) ? lastRun.ports.join(", ") : String(lastRun.ports))
      : prefilledPorts;
    const detached = lastRun?.detached ?? true;

    this.dfTagInput.set_value(tag);
    this.dfContainerNameInput.set_value(containerName);
    this.dfPortsInput.set_value(ports);
    this.dfDetached = detached;

    this.dockerfileDialog = {
      action,
      filePath: df.filePath,
      fileBasename: df.fileBasename || df.filePath.split("/").pop(),
      relativePath: df.relativePath || df.filePath,
      folder,
      defaultTag,
      defaultName,
    };
  }

  submitDockerfileModal(cx) {
    if (!this.dockerfileDialog) return;
    const dialog = this.dockerfileDialog;
    const action = dialog.action;
    const tag = this.dfTagInput.value().trim() || dialog.defaultTag;

    if (action === "build-image") {
      const buildArgv = buildDockerfileBuildArgs({
        filePath: dialog.filePath,
        contextDir: dialog.folder,
        tag,
      });
      this.dockerfileDialog = null;
      run("terminal.open", {
        name: `build: ${tag}`,
        folder: dialog.folder,
        argv: ["docker", ...buildArgv],
      });
      cx.notify();
      return;
    }

    if (action === "build-run") {
      const containerName = this.dfContainerNameInput.value().trim() || dialog.defaultName;
      const rawPorts = this.dfPortsInput.value().trim();
      const ports = rawPorts ? rawPorts.split(",").map((p) => p.trim()).filter(Boolean) : [];
      const detached = this.dfDetached;

      this.dockerfileRuns[dialog.filePath] = {
        tag,
        containerName,
        ports,
        detached,
      };
      this.saveDockerfileRuns();

      this.dockerfileDialog = null;

      const buildArgv = buildDockerfileBuildArgs({
        filePath: dialog.filePath,
        contextDir: dialog.folder,
        tag,
      });
      const runArgv = buildDockerfileRunArgs({
        filePath: dialog.filePath,
        tag,
        containerName,
        ports,
        detached,
      });

      const ctx = resolveDockerContext({
        props: props(),
        spaces: spaces(),
        panes: panes(),
        terminals: terminals(),
        focused: focused(),
        shared,
      });

      const targetKey = `df:${dialog.filePath}`;
      this.busyTargets.set(targetKey, `Building ${tag}`);
      cx.notify();

      cx.spawn(async (cx) => {
        try {
          const buildRes = await exec("docker", buildArgv, {
            cwd: dialog.folder,
            on: ctx.on,
            timeout: 600000,
          });
          if ((buildRes.code ?? buildRes.exitCode) !== 0) {
            const err = (buildRes.stderr || buildRes.stdout || "Build failed").trim();
            this.lastErrorText = err;
            notify({
              title: "Docker Build Failed",
              body: err.split("\n").slice(0, 3).join("\n"),
              level: "error",
              timeout: 4000,
            });
            this.busyTargets.delete(targetKey);
            cx.notify();
            return;
          }

          if (detached) {
            this.busyTargets.set(targetKey, `Running ${containerName}`);
            cx.notify();
            const runRes = await exec("docker", runArgv, {
              cwd: dialog.folder,
              on: ctx.on,
              timeout: 60000,
            });
            if ((runRes.code ?? runRes.exitCode) !== 0) {
              const err = (runRes.stderr || runRes.stdout || "Run failed").trim();
              this.lastErrorText = err;
              notify({
                title: "Docker Run Failed",
                body: err.split("\n").slice(0, 3).join("\n"),
                level: "error",
                timeout: 4000,
              });
            } else {
              notify({
                title: "Docker Container Started",
                body: `Container ${containerName} is running in background`,
                timeout: 2000,
              });
              this.refresh(cx);
            }
            this.busyTargets.delete(targetKey);
            cx.notify();
          } else {
            this.busyTargets.delete(targetKey);
            cx.notify();
            run("terminal.open", {
              name: `run: ${containerName}`,
              folder: dialog.folder,
              argv: ["docker", ...runArgv],
            });
          }
        } catch (err) {
          this.busyTargets.delete(targetKey);
          notify({
            title: "Docker Build/Run Failed",
            body: err.message,
            level: "error",
            timeout: 4000,
          });
          cx.notify();
        }
      });
    }
  }

  executeDockerfileRebuildReplace(df, cx) {
    const saved = this.dockerfileRuns[df.filePath];
    if (!saved) return;

    const folder = df.filePath.slice(0, df.filePath.lastIndexOf("/")) || ".";
    const tag = saved.tag;
    const containerName = saved.containerName;
    const ports = saved.ports || [];
    const detached = saved.detached ?? true;

    const buildArgv = buildDockerfileBuildArgs({
      filePath: df.filePath,
      contextDir: folder,
      tag,
    });
    const runArgv = buildDockerfileRunArgs({
      filePath: df.filePath,
      tag,
      containerName,
      ports,
      detached,
    });

    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    const targetKey = `df:${df.filePath}`;
    this.busyTargets.set(targetKey, `Rebuilding ${containerName}`);
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const buildRes = await exec("docker", buildArgv, {
          cwd: folder,
          on: ctx.on,
          timeout: 600000,
        });
        if ((buildRes.code ?? buildRes.exitCode) !== 0) {
          const err = (buildRes.stderr || buildRes.stdout || "Build failed").trim();
          this.lastErrorText = err;
          notify({
            title: "Docker Rebuild Failed",
            body: err.split("\n").slice(0, 3).join("\n"),
            level: "error",
            timeout: 4000,
          });
          this.busyTargets.delete(targetKey);
          cx.notify();
          return;
        }

        await exec("docker", ["stop", containerName], { cwd: folder, on: ctx.on, timeout: 30000 });
        await exec("docker", ["rm", containerName], { cwd: folder, on: ctx.on, timeout: 30000 });

        if (detached) {
          const runRes = await exec("docker", runArgv, {
            cwd: folder,
            on: ctx.on,
            timeout: 60000,
          });
          if ((runRes.code ?? runRes.exitCode) !== 0) {
            const err = (runRes.stderr || runRes.stdout || "Run failed").trim();
            this.lastErrorText = err;
            notify({
              title: "Docker Run Failed",
              body: err.split("\n").slice(0, 3).join("\n"),
              level: "error",
              timeout: 4000,
            });
          } else {
            notify({
              title: "Docker Container Replaced",
              body: `Container ${containerName} rebuilt and replaced`,
              timeout: 2000,
            });
            this.refresh(cx);
          }
          this.busyTargets.delete(targetKey);
          cx.notify();
        } else {
          this.busyTargets.delete(targetKey);
          cx.notify();
          run("terminal.open", {
            name: `run: ${containerName}`,
            folder,
            argv: ["docker", ...runArgv],
          });
        }
      } catch (err) {
        this.busyTargets.delete(targetKey);
        notify({
          title: "Docker Rebuild Failed",
          body: err.message,
          level: "error",
          timeout: 4000,
        });
        cx.notify();
      }
    });
  }

  /** Asynchronously queries docker stats for Inspector Tab mode (DM-45) */
  pollStats(containerId, cx) {
    if (!cx && typeof containerId === "object" && containerId !== null) {
      cx = containerId;
      containerId = null;
    }
    const p = props();
    const id = containerId || this.inspectData?.id || p?.inspect?.id;
    if (!id || !cx || typeof cx.spawn !== "function") return;
    const ctx = resolveDockerContext({
      props: p,
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["stats", "--no-stream", "--format", "{{json .}}", id], {
          on: ctx.on,
          timeout: 4000,
        });
        if ((res.code ?? res.exitCode) === 0 && res.stdout.trim()) {
          try {
            this.liveStats = JSON.parse(res.stdout.trim());
          } catch {}
          cx.notify();
        }
      } catch {
        // ignore background stats poll errors
      }
    });
  }

  /** Triggers deep inspect on a resource and opens the drawer */
  selectTarget(item, cx) {
    this.selectedTarget = item;
    this.drawerOpen = true;

    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    if (item.type === "image") {
      this.inspectLoading = true;
      cx.notify();
      cx.spawn(async (cx) => {
        try {
          const [inspRes, histRes] = await Promise.all([
            exec("docker", ["image", "inspect", "--format", "{{json .}}", item.id], { on: ctx.on, timeout: 5000 }),
            exec("docker", buildImageHistoryArgs(item.id), { on: ctx.on, timeout: 5000 }),
          ]);
          if ((inspRes.code ?? inspRes.exitCode) === 0) {
            const raw = JSON.parse(inspRes.stdout.trim());
            let historyRows = [];
            if ((histRes.code ?? histRes.exitCode) === 0) {
              historyRows = histRes.stdout
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .map((l) => {
                  try {
                    return JSON.parse(l);
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean);
            }
            this.inspectDataRaw = raw;
            this.inspectData = normalizeImageInspect(raw, historyRows);
          } else {
            this.inspectDataRaw = null;
            this.inspectData = null;
          }
        } catch {
          this.inspectDataRaw = null;
          this.inspectData = null;
        } finally {
          this.inspectLoading = false;
          cx.notify();
        }
      });
      return;
    }

    if (item.type === "volume") {
      this.inspectLoading = true;
      cx.notify();
      cx.spawn(async (cx) => {
        try {
          const res = await exec("docker", ["volume", "inspect", "--format", "{{json .}}", item.name], {
            on: ctx.on,
            timeout: 5000,
          });
          if ((res.code ?? res.exitCode) === 0) {
            const raw = JSON.parse(res.stdout.trim());
            this.inspectDataRaw = raw;
            this.inspectData = normalizeVolumeInspect(raw, item.usedByContainers);
          } else {
            this.inspectDataRaw = null;
            this.inspectData = null;
          }
        } catch {
          this.inspectDataRaw = null;
          this.inspectData = null;
        } finally {
          this.inspectLoading = false;
          cx.notify();
        }
      });
      return;
    }

    if (item.type === "network") {
      this.inspectLoading = true;
      cx.notify();
      cx.spawn(async (cx) => {
        try {
          const res = await exec("docker", ["network", "inspect", "--format", "{{json .}}", item.id || item.name], {
            on: ctx.on,
            timeout: 5000,
          });
          if ((res.code ?? res.exitCode) === 0) {
            const raw = JSON.parse(res.stdout.trim());
            this.inspectDataRaw = raw;
            this.inspectData = normalizeNetworkInspect(raw);
            if (item.id) this.networkInspectMap[item.id] = raw;
            if (item.name) this.networkInspectMap[item.name] = raw;
          } else {
            this.inspectDataRaw = null;
            this.inspectData = null;
          }
        } catch {
          this.inspectDataRaw = null;
          this.inspectData = null;
        } finally {
          this.inspectLoading = false;
          cx.notify();
        }
      });
      return;
    }

    const containerId =
      item.containerId ||
      item.id ||
      (item.containers && item.containers.length > 0 ? item.containers[0].id : null);

    if (!containerId) {
      // Not created service
      this.inspectData = null;
      this.inspectLoading = false;
      cx.notify();
      return;
    }

    this.inspectLoading = true;
    // Sequence guard: switching rows while an inspect is in flight must drop the older reply,
    // otherwise the drawer shows one container's data under another's name (DESIGN §5.2).
    const seq = (this.inspectSeq || 0) + 1;
    this.inspectSeq = seq;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["inspect", "--format", "{{json .}}", containerId], {
          on: ctx.on,
          timeout: 5000,
        });
        if (this.inspectSeq !== seq) return;
        if ((res.code ?? res.exitCode) === 0) {
          const raw = JSON.parse(res.stdout.trim());
          this.inspectDataRaw = raw;
          this.inspectData = normalizeContainerInspect(raw);
        } else {
          this.inspectDataRaw = null;
          this.inspectData = null;
        }
      } catch (err) {
        this.inspectDataRaw = null;
        this.inspectData = null;
      } finally {
        this.inspectLoading = false;
        cx.notify();
      }
    });
  }

  /** Background workspace scan for Compose files & Dockerfiles (DM-30..34) */
  async scanWorkspace(ctx) {
    if (!ctx.cwd || ctx.on !== null) return; // local spaces scan

    // Setup folder watch if cwd changed (DESIGN §4.2)
    if (this.watchedCwd !== ctx.cwd) {
      this.watchedCwd = ctx.cwd;
      this.workspaceDirty = true;
      const targetCwd = ctx.cwd;
      cx.spawn(async (cx) => {
        try {
          while (this.watchedCwd === targetCwd) {
            const started = Date.now();
            await watchFolder(targetCwd);
            // A watcher that resolves immediately must not spin this loop; a
            // minimum gap keeps a broken watch from becoming a refresh storm.
            const elapsed = Date.now() - started;
            if (elapsed < 500) await cx.sleep(500 - elapsed);
            this.workspaceDirty = true;
            this.composeConfigCache.clear();
            this.refresh(cx);
          }
        } catch {
          // Ignore watch failure
        }
      });
    }

    // The 3s status poll must not re-run `find`/`stat` over the workspace.
    // Only a cwd change, a folder-watch event, or a manual refresh sets this.
    if (!this.workspaceDirty && this.scannedCwd === ctx.cwd) return;
    this.workspaceDirty = false;
    this.scannedCwd = ctx.cwd;

    try {
      const findRes = await exec(
        "find",
        [
          ctx.cwd,
          "-maxdepth",
          "3",
          "(",
          "-name",
          ".git",
          "-o",
          "-name",
          "node_modules",
          "-o",
          "-name",
          "vendor",
          "-o",
          "-name",
          "dist",
          "-o",
          "-name",
          "build",
          "-o",
          "-name",
          ".venv",
          ")",
          "-prune",
          "-o",
          "-type",
          "f",
          "(",
          "-name",
          "*compose*.y*ml",
          "-o",
          "-name",
          "Dockerfile*",
          "-o",
          "-name",
          "*.Dockerfile",
          "-o",
          "-name",
          "Containerfile*",
          ")",
          "-print",
        ],
        { timeout: 5000 }
      );

      if ((findRes.code ?? findRes.exitCode) === 0) {
        const lines = findRes.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const composePaths = [];
        const dockerfiles = [];

        for (const filePath of lines) {
          const kind = classifyDockerFile(filePath);
          if (kind === "compose") {
            composePaths.push(filePath);
          } else if (kind === "dockerfile") {
            const folder = filePath.split("/").slice(0, -1).join("/") || "/";
            const fileBasename = filePath.split("/").pop() || "";
            const rel = filePath.startsWith(ctx.cwd)
              ? filePath.slice(ctx.cwd.length).replace(/^\//, "")
              : filePath;
            dockerfiles.push({
              filePath,
              fileBasename,
              relativePath: rel,
              folder,
            });
          }
        }

        // Group compose files with override pairing (DM-30..32, DESIGN §4.2)
        const groups = groupDiscoveredComposeFiles(composePaths);
        const resolvedCompose = [];

        for (const entry of groups) {
          // Stat files to get mtimes
          let mtimes = "";
          try {
            const statRes = await exec("stat", ["-f", "%m", ...entry.files], { timeout: 3000 });
            if ((statRes.code ?? statRes.exitCode) === 0) {
              mtimes = statRes.stdout.trim().replace(/\s+/g, ":");
            }
          } catch {}

          const cacheKey = `${entry.folder}:${entry.files.join(",")}:${mtimes}`;
          let parsedConfig = null;
          let configErr = null;

          if (this.composeConfigCache.has(cacheKey)) {
            const cached = this.composeConfigCache.get(cacheKey);
            parsedConfig = cached.config;
            configErr = cached.configError;
          } else {
            // Run docker compose config --format json with --profile "*"
            try {
              let cfgRes = await exec(
                "docker",
                ["compose", "--profile", "*", ...entry.files.flatMap((f) => ["-f", f]), "config", "--format", "json"],
                { cwd: entry.folder, on: ctx.on, timeout: 8000 }
              );
              if ((cfgRes.code ?? cfgRes.exitCode) !== 0) {
                cfgRes = await exec(
                  "docker",
                  ["compose", ...entry.files.flatMap((f) => ["-f", f]), "config", "--format", "json"],
                  { cwd: entry.folder, on: ctx.on, timeout: 8000 }
                );
              }

              if ((cfgRes.code ?? cfgRes.exitCode) === 0) {
                parsedConfig = parseComposeConfigJson(cfgRes.stdout);
                configErr = null;
              } else {
                parsedConfig = { projectName: composeProjectNameFromFolder(entry.folder), services: {} };
                configErr = (cfgRes.stderr || cfgRes.stdout).trim();
              }
            } catch (err) {
              parsedConfig = { projectName: composeProjectNameFromFolder(entry.folder), services: {} };
              configErr = err?.message || "Failed to parse compose config";
            }

            this.composeConfigCache.set(cacheKey, { config: parsedConfig, configError: configErr });
          }

          const projectName = parsedConfig?.projectName || composeProjectNameFromFolder(entry.folder);
          resolvedCompose.push({
            filePath: entry.primaryFile,
            files: entry.files,
            folder: entry.folder,
            project: projectName,
            displayName: entry.name,
            config: parsedConfig,
            configError: configErr,
            isOverride: entry.isOverride,
            isVariant: entry.isVariant,
          });
        }

        this.discoveredCompose = resolvedCompose;
        this.discoveredDockerfiles = dockerfiles;
      }
    } catch {
      // Ignore background workspace scan failure
    }
  }

  /** Fast status refresh (DM-15, DESIGN §4.1) */
  refresh(cx, options = {}) {
    const seq = ++this.refreshSeq;
    if (options.rescan) this.workspaceDirty = true;
    this.refreshing = true;
    cx.notify();
    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    cx.spawn(async (cx) => {
      // 1. Probe Engine
      try {
        const infoRes = await exec("docker", ["info", "--format", "{{json .}}"], {
          on: ctx.on,
          timeout: 4000,
        });
        if (seq !== this.refreshSeq) return;

        if ((infoRes.code ?? infoRes.exitCode) === 0) {
          this.engineStatus = "ready";
          try {
            const info = JSON.parse(infoRes.stdout.trim());
            this.engineVersion = info.ServerVersion ? `Docker ${info.ServerVersion}` : "Docker";
          } catch {
            this.engineVersion = "Docker";
          }
        } else {
          this.engineStatus = "unavailable";
          this.engineError =
            infoRes.stderr || infoRes.stdout || "Cannot connect to the Docker daemon. Is the daemon running?";
          this.refreshing = false;
          cx.notify();
          return;
        }
      } catch (err) {
        if (seq !== this.refreshSeq) return;
        this.engineStatus = "unavailable";
        this.engineError = err.message || "Failed to execute Docker CLI";
        this.refreshing = false;
        cx.notify();
        return;
      }

      // 2. Query Containers & Compose projects in parallel
      try {
        const [ctrRes, compRes] = await Promise.all([
          exec("docker", ["container", "ls", "-a", "--no-trunc", "--format", "{{json .}}"], {
            on: ctx.on,
            timeout: 5000,
          }),
          exec("docker", ["compose", "ls", "--all", "--format", "json"], {
            on: ctx.on,
            timeout: 5000,
          }),
        ]);

        if (seq !== this.refreshSeq) return;

        // Parse NDJSON containers
        if ((ctrRes.code ?? ctrRes.exitCode) === 0) {
          const lines = ctrRes.stdout.split("\n").filter((l) => l.trim().length > 0);
          this.containersRaw = lines
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        }

        // Parse JSON compose ls
        if ((compRes.code ?? compRes.exitCode) === 0) {
          try {
            this.composeLsRaw = JSON.parse(compRes.stdout.trim()) || [];
          } catch {
            this.composeLsRaw = [];
          }
        }

        // Trigger workspace scan
        await this.scanWorkspace(ctx);

        // Fetch section-specific resources (P4)
        if (this.activeSection === "images") {
          const imgRes = await exec("docker", ["image", "ls", "--no-trunc", "--format", "{{json .}}"], {
            on: ctx.on,
            timeout: 6000,
          });
          if ((imgRes.code ?? imgRes.exitCode) === 0) {
            const lines = imgRes.stdout.split("\n").filter((l) => l.trim().length > 0);
            this.imagesRaw = lines
              .map((l) => {
                try {
                  return JSON.parse(l);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);
          }
        } else if (this.activeSection === "volumes") {
          const volRes = await exec("docker", ["volume", "ls", "--format", "{{json .}}"], {
            on: ctx.on,
            timeout: 6000,
          });
          if ((volRes.code ?? volRes.exitCode) === 0) {
            const lines = volRes.stdout.split("\n").filter((l) => l.trim().length > 0);
            this.volumesRaw = lines
              .map((l) => {
                try {
                  return JSON.parse(l);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);
          }
        } else if (this.activeSection === "networks") {
          const netRes = await exec("docker", ["network", "ls", "--format", "{{json .}}"], {
            on: ctx.on,
            timeout: 6000,
          });
          if ((netRes.code ?? netRes.exitCode) === 0) {
            const lines = netRes.stdout.split("\n").filter((l) => l.trim().length > 0);
            this.networksRaw = lines
              .map((l) => {
                try {
                  return JSON.parse(l);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);

            // One bulk inspect: connected counts and container IPs live in the inspect payload,
            // and inspecting only the selected network made every other network look empty, so
            // Remove was offered on networks with live endpoints (DM-115/DM-116).
            const netIds = this.networksRaw.map((n) => n.ID).filter(Boolean);
            if (netIds.length > 0) {
              const inspAll = await exec("docker", ["network", "inspect", ...netIds], {
                on: ctx.on,
                timeout: 12000,
              });
              if ((inspAll.code ?? inspAll.exitCode) === 0) {
                try {
                  const list = JSON.parse(inspAll.stdout.trim());
                  const map = {};
                  for (const raw of Array.isArray(list) ? list : []) {
                    if (raw.Id) map[raw.Id] = raw;
                    if (raw.Name) map[raw.Name] = raw;
                  }
                  this.networkInspectMap = map;
                } catch {}
              }
            }
          }
        } else if (this.activeSection === "system") {
          const [dfRes, infoRes] = await Promise.all([
            exec("docker", ["system", "df", "--format", "{{json .}}"], { on: ctx.on, timeout: 8000 }),
            exec("docker", ["info", "--format", "{{json .}}"], { on: ctx.on, timeout: 6000 }),
          ]);
          if ((dfRes.code ?? dfRes.exitCode) === 0) {
            this.systemDfParsed = parseSystemDf(dfRes.stdout);
          }
          if ((infoRes.code ?? infoRes.exitCode) === 0) {
            try {
              this.engineInfoRaw = JSON.parse(infoRes.stdout.trim());
            } catch {}
          }
        }

        // Auto-expand projects in current space unless explicitly collapsed (DM-26)
        for (const c of this.containersRaw) {
          const labels = typeof c.Labels === "string" ? parseContainerLabels(c.Labels) : c.Labels || {};
          const pName = labels["com.docker.compose.project"];
          if (pName && !this.userCollapsedProjects.has(pName)) {
            const wDir = labels["com.docker.compose.project.working_dir"] || "";
            if (ctx.cwd && wDir && (wDir === ctx.cwd || wDir.startsWith(ctx.cwd + "/"))) {
              this.expandedProjects.add(pName);
            }
          }
        }

        this.refreshing = false;
        cx.notify();
      } catch (err) {
        if (seq !== this.refreshSeq) return;
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  getSpaceProjects(ctx) {
    const list = new Set();
    if (this.discoveredCompose) {
      for (const d of this.discoveredCompose) {
        if (d.project) list.add(d.project);
      }
    }
    if (ctx?.cwd && this.containersRaw) {
      for (const c of this.containersRaw) {
        const labels = typeof c.Labels === "string" ? parseContainerLabels(c.Labels) : c.Labels || {};
        const pName = labels["com.docker.compose.project"];
        const wDir = labels["com.docker.compose.project.working_dir"];
        if (pName && wDir && (wDir === ctx.cwd || wDir.startsWith(ctx.cwd + "/"))) {
          list.add(pName);
        }
      }
    }
    return Array.from(list);
  }

  // --- Row click & context-menu handling ---

  handleRowClick(key, cx) {
    const row = this.rowByKey.get(key);
    if (!row) return;

    // Check double-click to open full Inspector Tab (DM-14, DM-44)
    const now = Date.now();
    const isDoubleClick = this.lastClickedKey === key && now - this.lastClickTime < 350;
    this.lastClickedKey = key;
    this.lastClickTime = now;

    if (isDoubleClick) {
      if (row.type === "service") {
        const containerId = row.data.containers?.[0]?.id;
        run("tab.new", {
          name: `Inspect: ${row.project} / ${row.data.name}`,
          mod: "docker-manager",
          props: {
            inspect: {
              kind: "container",
              id: containerId,
              project: row.composeProject || row.project,
              service: row.data.name,
              configFiles: row.configFiles,
              workingDir: row.workingDirs?.[0] || null,
            },
          },
        });
        return;
      }
      if (row.type === "replica" || row.type === "df-container" || row.type === "standalone") {
        const cid = row.data.id;
        const cname = row.data.name || row.data.shortId;
        run("tab.new", {
          name: `Inspect: ${cname}`,
          mod: "docker-manager",
          props: { inspect: { kind: "container", id: cid } },
        });
        return;
      }
      if (row.type === "image") {
        const id = row.data.id;
        const name = row.data.name || row.data.shortId;
        run("tab.new", {
          name: `Inspect: ${name}`,
          mod: "docker-manager",
          props: { inspect: { kind: "image", id, name } },
        });
        return;
      }
      if (row.type === "volume") {
        const vname = row.data.name;
        run("tab.new", {
          name: `Inspect: ${vname}`,
          mod: "docker-manager",
          props: { inspect: { kind: "volume", name: vname } },
        });
        return;
      }
      if (row.type === "network") {
        const nid = row.data.id;
        const nname = row.data.name;
        run("tab.new", {
          name: `Inspect: ${nname}`,
          mod: "docker-manager",
          props: { inspect: { kind: "network", id: nid, name: nname } },
        });
        return;
      }
    }

    if (row.type === "group") {
      if (this.expandedGroups.has(row.id)) {
        this.expandedGroups.delete(row.id);
      } else {
        this.expandedGroups.add(row.id);
      }
      cx.notify();
      return;
    }

    if (row.type === "project") {
      const p = row.data;
      if (this.expandedProjects.has(p.name)) {
        this.expandedProjects.delete(p.name);
        this.userCollapsedProjects.add(p.name);
      } else {
        this.expandedProjects.add(p.name);
        this.userCollapsedProjects.delete(p.name);
      }
      cx.notify();
      return;
    }

    if (row.type === "service") {
      const s = row.data;
      if (row.hasReplicas) {
        const svcKey = `${row.project}:${s.name}`;
        if (this.expandedServices.has(svcKey)) {
          this.expandedServices.delete(svcKey);
        } else {
          this.expandedServices.add(svcKey);
        }
      }
      this.selectTarget(
        {
          ...s,
          project: row.project,
          composeProject: row.composeProject,
          configFiles: row.configFiles,
          workingDirs: row.workingDirs,
          key: row.key,
        },
        cx
      );
      return;
    }

    if (row.type === "replica") {
      this.selectTarget({ ...row.data, key: row.key }, cx);
      return;
    }

    if (row.type === "dockerfile") {
      const df = row.data;
      if (this.expandedProjects.has(df.filePath)) {
        this.expandedProjects.delete(df.filePath);
      } else {
        this.expandedProjects.add(df.filePath);
      }
      cx.notify();
      return;
    }

    if (row.type === "profiles-header") {
      const projName = row.project;
      if (this.expandedProfiles.has(projName)) {
        this.expandedProfiles.delete(projName);
      } else {
        this.expandedProfiles.add(projName);
      }
      cx.notify();
      return;
    }

    if (row.type === "inactive-profile-service") {
      this.selectTarget(
        {
          ...row.data,
          project: row.project,
          composeProject: row.composeProject,
          configFiles: row.configFiles,
          workingDirs: row.workingDirs,
          key: row.key,
          notCreated: true,
        },
        cx
      );
      return;
    }

    if (row.type === "df-container" || row.type === "standalone" || row.type === "image" || row.type === "volume" || row.type === "network") {
      this.selectTarget({ ...row.data, type: row.type, key: row.key }, cx);
      return;
    }
  }

  openRowContextMenu(event, cx) {
    const key = this.pendingContextTarget;
    this.pendingContextTarget = null;
    if (!key) return;
    const row = this.rowByKey.get(key);
    if (!row) return;

    let items = [];
    if (row.type === "project") {
      items = getProjectMenuItems(row.data);
    } else if (row.type === "service") {
      items = getServiceMenuItems(row.data, this.projectByDisplay?.get(row.project) || this.projectByName?.get(row.project));
    } else if (row.type === "replica" || row.type === "df-container" || row.type === "standalone") {
      items = getContainerMenuItems(row.data);
    } else if (row.type === "image") {
      items = getImageMenuItems(row.data);
    } else if (row.type === "volume") {
      items = getVolumeMenuItems(row.data);
    } else if (row.type === "network") {
      items = getNetworkMenuItems(row.data);
    } else if (row.type === "dockerfile") {
      items = getDockerfileMenuItems(row.data, this.dockerfileRuns[row.data.filePath]);
    } else if (row.type === "inactive-profile-service") {
      const prof = row.data.profiles?.[0] || "default";
      items = [
        {
          id: `start-profile:${prof}`,
          label: `Start with profile '${prof}'`,
          icon: "play.svg",
          enabled: true,
          destructive: false,
        },
      ];
    }

    if (items.length === 0) return;

    // Also select row
    if (row.type === "service") {
      this.selectTarget(
        {
          ...row.data,
          project: row.project,
          composeProject: row.composeProject,
          configFiles: row.configFiles,
          workingDirs: row.workingDirs,
          key: row.key,
        },
        cx
      );
    } else if (row.type === "replica" || row.type === "df-container" || row.type === "standalone" || row.type === "image" || row.type === "volume" || row.type === "network") {
      this.selectTarget({ ...row.data, type: row.type, key: row.key }, cx);
    }

    // The panel root's bubbled press reports `local_position` relative to the
    // panel, which is the coordinate space this overlay paints in. The helper
    // handles zoom, edge flipping and the window-coordinate fallback.
    const menuW = 220;
    const menuH = Math.min(360, items.length * 26 + 16);
    const pos = resolveDockerMenuPosition({
      event,
      localPosition: event?.local_position,
      bounds: event?.bounds,
      zoom: Number(settings()?.zoom) || 1,
      menuWidth: menuW,
      menuHeight: menuH,
    });

    this.contextMenu = {
      row,
      x: pos.x,
      y: pos.y,
      items,
    };
    cx.notify();
  }

  // --- Execution & Confirmation Handlers (DM-50..73, DM-85..86) ---

  executeAction(item, row, isAlt, cx) {
    if (!item || !item.enabled) return;

    if (item.destructive) {
      const spec = buildConfirmationSpec(item.id, row.data);
      this.confirmInputValue = "";
      this.confirmInput.set_value("");
      this.confirmDialog = {
        ...spec,
        // Keep the data, never the event context: the confirm click happens in another call and
        // a stashed cx is stale by then (gpui-kit: a cx is valid for the call that made it).
        // The confirm button passes its own cx into this closure.
        confirmAction: (confirmCx) => this.runAction(item.id, row, isAlt, confirmCx),
      };
      cx.notify();
      return;
    }

    this.runAction(item.id, row, isAlt, cx);
  }

  promptConfirm(spec, onConfirm, cx) {
    this.confirmInputValue = "";
    this.confirmInput.set_value("");
    this.confirmDialog = {
      ...spec,
      confirmAction: (cx) => onConfirm(cx),
    };
    cx.notify();
  }

  runAction(actionId, row, isAlt, cx) {
    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    const rowData = row.data;
    const project =
      row.type === "project"
        ? rowData
        : this.projectByDisplay?.get(row.project) || this.projectByName?.get(row.project);

    if (row.type === "project") {
      const projTarget = {
        project: rowData.project || rowData.name,
        workingDir: rowData.workingDirs?.[0] || null,
        configFiles: rowData.configFiles || [],
      };
      const key = `proj:${rowData.name}`;
      const projCtx = { ...ctx, cwd: projTarget.workingDir || ctx.cwd };

      if (actionId === "up") {
        this.runDockerCmd(key, `Starting project ${rowData.name}`, buildComposeUpArgs(projTarget), projCtx, cx);
      } else if (actionId === "up-build") {
        this.runDockerCmd(key, `Rebuilding project ${rowData.name}`, buildComposeUpArgs(projTarget, { build: true }), projCtx, cx);
      } else if (actionId === "start") {
        this.runDockerCmd(key, `Starting project ${rowData.name}`, buildComposeStartArgs(projTarget), projCtx, cx);
      } else if (actionId === "stop") {
        this.runDockerCmd(key, `Stopping project ${rowData.name}`, buildComposeStopArgs(projTarget), projCtx, cx);
      } else if (actionId === "restart") {
        this.runDockerCmd(key, `Restarting project ${rowData.name}`, buildComposeRestartArgs(projTarget), projCtx, cx);
      } else if (actionId === "pull") {
        this.runDockerCmd(key, `Pulling images for ${rowData.name}`, buildComposePullArgs(projTarget), projCtx, cx);
      } else if (actionId === "build") {
        this.runDockerCmd(key, `Building images for ${rowData.name}`, buildComposeBuildArgs(projTarget), projCtx, cx);
      } else if (actionId === "logs") {
        this.openLogs(rowData, isAlt);
      } else if (actionId === "open-compose") {
        if (rowData.configFiles?.[0]) {
          try {
            run("tab.new", { name: rowData.configFiles[0].split("/").pop(), mod: "file-editor", props: { file: rowData.configFiles[0] } });
          } catch {
            this.copyValue(rowData.configFiles[0], "Compose File Path", cx);
          }
        }
      } else if (actionId === "copy-name") {
        this.copyValue(rowData.name, "Project Name", cx);
      } else if (actionId === "reveal-folder") {
        if (rowData.workingDirs?.[0]) {
          try {
            run("layout.select", { stack: "panel-body", child: "files" });
          } catch {
            this.copyValue(rowData.workingDirs[0], "Folder Path", cx);
          }
        }
      } else if (actionId === "down") {
        this.runDockerCmd(key, `Stopping project ${rowData.name}`, buildComposeDownArgs(projTarget), projCtx, cx);
      } else if (actionId === "down-volumes") {
        this.runDockerCmd(key, `Removing project & volumes ${rowData.name}`, buildComposeDownArgs(projTarget, { volumes: true }), projCtx, cx);
      }
      return;
    }

    if (row.type === "service") {
      const projTarget = {
        project: row.composeProject || project?.project || row.project,
        workingDir: project?.workingDirs?.[0] || row.workingDirs?.[0] || null,
        configFiles: project?.configFiles || row.configFiles || [],
      };
      const key = `svc:${row.project}:${rowData.name}`;
      const containerId = rowData.containers?.[0]?.id;
      const svcCtx = { ...ctx, cwd: projTarget.workingDir || ctx.cwd };

      if (actionId === "start") {
        this.runDockerCmd(key, `Starting service ${rowData.name}`, buildComposeStartArgs(projTarget, rowData.name), svcCtx, cx);
      } else if (actionId === "stop") {
        this.runDockerCmd(key, `Stopping service ${rowData.name}`, buildComposeStopArgs(projTarget, rowData.name), svcCtx, cx);
      } else if (actionId === "restart") {
        this.runDockerCmd(key, `Restarting service ${rowData.name}`, buildComposeRestartArgs(projTarget, rowData.name), svcCtx, cx);
      } else if (actionId === "up") {
        this.runDockerCmd(key, `Starting service ${rowData.name}`, buildComposeUpArgs(projTarget, { service: rowData.name }), svcCtx, cx);
      } else if (actionId === "rebuild") {
        this.runDockerCmd(key, `Rebuilding service ${rowData.name}`, buildComposeRebuildArgs(projTarget, rowData.name), svcCtx, cx);
      } else if (actionId === "recreate") {
        this.runDockerCmd(key, `Recreating service ${rowData.name}`, buildComposeRecreateArgs(projTarget, rowData.name), svcCtx, cx);
      } else if (actionId === "logs") {
        this.openLogs(
          {
            ...rowData,
            configFiles: projTarget.configFiles,
            workingDirs: projTarget.workingDir ? [projTarget.workingDir] : [],
          },
          isAlt
        );
      } else if (actionId === "shell") {
        if (containerId) {
          this.openShell(containerId, rowData.name, isAlt, cx);
        }
      } else if (actionId === "inspect") {
        this.selectTarget(
          {
            ...rowData,
            project: row.project,
            composeProject: projTarget.project,
            configFiles: projTarget.configFiles,
            workingDirs: projTarget.workingDir ? [projTarget.workingDir] : [],
          },
          cx
        );
      } else if (actionId === "inspect-tab") {
        run("tab.new", {
          name: `Inspect: ${row.project} / ${rowData.name}`,
          mod: "docker-manager",
          props: {
            inspect: {
              kind: "container",
              id: containerId,
              project: projTarget.project,
              service: rowData.name,
              configFiles: projTarget.configFiles,
              workingDir: projTarget.workingDir,
            },
          },
        });
      } else if (actionId.startsWith("open-port:")) {
        const port = actionId.split(":")[1];
        if (cx?.open_url) cx.open_url(`http://localhost:${port}`);
        else exec("open", [`http://localhost:${port}`]);
      } else if (actionId === "copy-name") {
        this.copyValue(rowData.name, "Service Name", cx);
      } else if (actionId === "copy-id") {
        this.copyValue(containerId, "Container ID", cx);
      } else if (actionId === "remove") {
        this.runDockerCmd(key, `Removing service ${rowData.name}`, buildComposeRmArgs(projTarget, rowData.name), svcCtx, cx);
      }
      return;
    }

    if (row.type === "replica" || row.type === "df-container" || row.type === "standalone") {
      const cid = rowData.id;
      const cname = rowData.name || rowData.shortId;
      const key = `ctr:${cid}`;

      if (["start", "stop", "restart", "pause", "unpause", "kill"].includes(actionId)) {
        this.runDockerCmd(key, `${actionId} ${cname}`, buildContainerActionArgs(actionId, cid), ctx, cx);
      } else if (actionId === "logs") {
        this.openLogs(rowData, isAlt);
      } else if (actionId === "shell") {
        this.openShell(cid, cname, isAlt, cx);
      } else if (actionId === "inspect") {
        this.selectTarget({ ...rowData }, cx);
      } else if (actionId === "inspect-tab") {
        run("tab.new", {
          name: `Inspect: ${cname}`,
          mod: "docker-manager",
          props: { inspect: { kind: "container", id: cid } },
        });
      } else if (actionId.startsWith("open-port:")) {
        const port = actionId.split(":")[1];
        if (cx?.open_url) cx.open_url(`http://localhost:${port}`);
        else exec("open", [`http://localhost:${port}`]);
      } else if (actionId === "copy-name") {
        this.copyValue(cname, "Container Name", cx);
      } else if (actionId === "copy-id") {
        this.copyValue(cid, "Container ID", cx);
      } else if (actionId === "remove") {
        this.runDockerCmd(key, `Removing container ${cname}`, buildContainerRmArgs(cid, { force: rowData.running }), ctx, cx);
      }
      return;
    }

    if (row.type === "image") {
      const id = rowData.id;
      const name = rowData.name || rowData.shortId;
      const key = `img:${id}`;

      if (actionId === "run-image") {
        this.openImageModal(rowData, "run-image", cx);
      } else if (actionId === "inspect-image") {
        run("tab.new", {
          name: `Inspect: ${name}`,
          mod: "docker-manager",
          props: { inspect: { kind: "image", id, name } },
        });
      } else if (actionId === "pull-image") {
        run("terminal.open", {
          name: `pull: ${name}`,
          argv: ["docker", "pull", name],
        });
      } else if (actionId === "tag-image") {
        this.openImageModal(rowData, "tag-image", cx);
      } else if (actionId === "copy-id") {
        this.copyValue(id, "Image ID", cx);
      } else if (actionId === "copy-name") {
        this.copyValue(name, "Image Name", cx);
      } else if (actionId === "remove-image") {
        this.runDockerCmd(key, `Removing image ${name}`, buildImageRmArgs(id), ctx, cx);
      }
      return;
    }

    if (row.type === "volume") {
      const vname = rowData.name;
      const key = `vol:${vname}`;

      if (actionId === "inspect-volume") {
        run("tab.new", {
          name: `Inspect: ${vname}`,
          mod: "docker-manager",
          props: { inspect: { kind: "volume", name: vname } },
        });
      } else if (actionId === "browse-volume") {
        run("terminal.open", {
          name: `browse: ${vname}`,
          argv: buildVolumeBrowseArgs(vname),
        });
      } else if (actionId === "size-volume") {
        this.computeSingleVolumeSize(vname, cx);
      } else if (actionId === "backup-volume") {
        this.openVolumeModal(rowData, "backup", cx);
      } else if (actionId === "restore-volume") {
        this.openVolumeModal(rowData, "restore", cx);
      } else if (actionId === "clone-volume") {
        this.openVolumeModal(rowData, "clone", cx);
      } else if (actionId === "copy-name") {
        this.copyValue(vname, "Volume Name", cx);
      } else if (actionId === "remove-volume") {
        this.runDockerCmd(key, `Removing volume ${vname}`, ["volume", "rm", vname], ctx, cx);
      }
      return;
    }

    if (row.type === "network") {
      const nid = rowData.id;
      const nname = rowData.name;
      const key = `net:${nid}`;

      if (actionId === "inspect-network") {
        run("tab.new", {
          name: `Inspect: ${nname}`,
          mod: "docker-manager",
          props: { inspect: { kind: "network", id: nid, name: nname } },
        });
      } else if (actionId === "disconnect-network") {
        const first = rowData.connectedContainers?.[0];
        if (first) {
          this.runDockerCmd(key, `Disconnecting ${first.name} from ${nname}`, ["network", "disconnect", nid, first.id || first.name], ctx, cx);
        }
      } else if (actionId === "copy-name") {
        this.copyValue(nname, "Network Name", cx);
      } else if (actionId === "copy-id") {
        this.copyValue(nid, "Network ID", cx);
      } else if (actionId === "remove-network") {
        this.runDockerCmd(key, `Removing network ${nname}`, buildNetworkRmArgs(nid), ctx, cx);
      }
      return;
    }

    if (row.type === "dockerfile") {
      if (actionId === "build-image") {
        this.openDockerfileModal(rowData, "build-image", cx);
      } else if (actionId === "build-run") {
        this.openDockerfileModal(rowData, "build-run", cx);
      } else if (actionId === "rebuild-replace") {
        this.executeDockerfileRebuildReplace(rowData, cx);
      } else if (actionId === "open-dockerfile") {
        run("tab.new", {
          name: rowData.fileBasename || "Dockerfile",
          mod: "file-editor",
          props: { file: rowData.filePath },
        });
      } else if (actionId === "copy-path") {
        this.copyValue(rowData.filePath, "Dockerfile Path", cx);
      }
      return;
    }

    if (row.type === "inactive-profile-service" && actionId.startsWith("start-profile:")) {
      const profile = actionId.split(":")[1];
      const projTarget = {
        project: row.composeProject || row.project,
        workingDir: row.workingDirs?.[0] || project?.workingDirs?.[0] || null,
        configFiles: row.configFiles?.length ? row.configFiles : project?.configFiles || [],
      };
      const argv = ["compose", "-p", projTarget.project];
      if (projTarget.workingDir) argv.push("--project-directory", projTarget.workingDir);
      for (const f of projTarget.configFiles) argv.push("-f", f);
      argv.push("--profile", profile, "up", "-d", rowData.name);

      const key = `prof:${row.project}:${rowData.name}`;
      this.runDockerCmd(key, `Starting ${rowData.name} (${profile})`, argv, ctx, cx);
      return;
    }
  }

  openImageModal(img, action, cx) {
    const defaultTag = img.name || img.shortId;
    const defaultName = (img.repository && img.repository !== "<none>" ? img.repository.split("/").pop() : "app") + "-run";
    this.imgRunNameInput.set_value(defaultName);
    this.imgRunPortsInput.set_value("");
    this.imgRunEnvInput.set_value("");
    this.imgRunDetached = true;
    this.imgTagInput.set_value(defaultTag);

    this.imageDialog = {
      action,
      image: img,
      defaultTag,
      defaultName,
    };
    cx.notify();
  }

  submitImageModal(cx) {
    if (!this.imageDialog) return;
    const dialog = this.imageDialog;
    const img = dialog.image;
    const action = dialog.action;

    if (action === "run-image") {
      const name = this.imgRunNameInput.value().trim();
      const rawPorts = this.imgRunPortsInput.value().trim();
      const ports = rawPorts ? rawPorts.split(",").map((p) => p.trim()).filter(Boolean) : [];
      const rawEnv = this.imgRunEnvInput.value().trim();
      const env = rawEnv ? rawEnv.split(",").map((e) => e.trim()).filter(Boolean) : [];
      const detached = this.imgRunDetached;

      this.imageDialog = null;
      run("terminal.open", {
        name: `run: ${name || img.name}`,
        folder: focused()?.cwd || spaces().find((candidate) => candidate.active)?.folder,
        argv: [
          "docker",
          "run",
          ...(detached ? ["-d"] : []),
          ...(name ? ["--name", name] : []),
          ...ports.flatMap((p) => ["-p", p]),
          ...env.flatMap((e) => ["-e", e]),
          img.name || img.id,
        ],
      });
      cx.notify();
      return;
    }

    if (action === "tag-image") {
      const newTag = this.imgTagInput.value().trim();
      if (!newTag) return;
      this.imageDialog = null;
      const ctx = resolveDockerContext({
        props: props(),
        spaces: spaces(),
        panes: panes(),
        terminals: terminals(),
        focused: focused(),
        shared,
      });
      this.runDockerCmd(`img:${img.id}`, `Tagging ${img.name} as ${newTag}`, ["image", "tag", img.id, newTag], ctx, cx);
    }
  }

  openVolumeModal(vol, action, cx) {
    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const defaultArchive = `${vol.name}-${ts}.tar.gz`;

    this.volDestDirInput.set_value(ctx.cwd || "/tmp");
    this.volArchiveNameInput.set_value(defaultArchive);
    this.volSrcDirInput.set_value(ctx.cwd || "/tmp");
    this.volRestoreArchiveInput.set_value(defaultArchive);
    this.volCloneDestInput.set_value(`${vol.name}-clone`);
    this.volTypedConfirmInput.set_value("");

    this.volumeDialog = {
      action,
      volume: vol,
      defaultArchive,
    };
    cx.notify();
  }

  submitVolumeModal(cx) {
    if (!this.volumeDialog) return;
    const dialog = this.volumeDialog;
    const vol = dialog.volume;
    const action = dialog.action;

    if (action === "backup") {
      const destDir = this.volDestDirInput.value().trim() || "/tmp";
      const archiveName = this.volArchiveNameInput.value().trim() || dialog.defaultArchive;
      this.volumeDialog = null;
      const argv = ["docker", ...buildVolumeBackupArgs(vol.name, destDir, archiveName)];
      run("terminal.open", {
        name: `backup: ${vol.name}`,
        folder: focused()?.cwd || spaces().find((candidate) => candidate.active)?.folder,
        argv,
      });
      cx.notify();
      return;
    }

    if (action === "restore") {
      const srcDir = this.volSrcDirInput.value().trim() || "/tmp";
      const archiveName = this.volRestoreArchiveInput.value().trim();
      const typed = this.volTypedConfirmInput.value().trim();
      const runningUsers = (vol.usedByContainers || []).filter((c) => c.running);
      if (runningUsers.length > 0) {
        notify({
          title: "Restore refused",
          body: `${vol.name} is mounted by ${runningUsers.length} running container(s): ${runningUsers
            .map((c) => c.name)
            .slice(0, 3)
            .join(", ")}. Stop them first.`,
          level: "error",
          timeout: 6000,
        });
        return;
      }
      if (typed !== vol.name) {
        notify({ title: "Name Confirmation", body: `Please type "${vol.name}" exactly to confirm restore.`, level: "warning" });
        return;
      }
      this.volumeDialog = null;
      const argv = ["docker", ...buildVolumeRestoreArgs(vol.name, srcDir, archiveName)];
      run("terminal.open", {
        name: `restore: ${vol.name}`,
        folder: focused()?.cwd || spaces().find((candidate) => candidate.active)?.folder,
        argv,
      });
      cx.notify();
      return;
    }

    if (action === "clone") {
      const destVol = this.volCloneDestInput.value().trim();
      if (!destVol) return;
      this.volumeDialog = null;
      const cloneSpec = buildVolumeCloneArgs(vol.name, destVol);

      const ctx = resolveDockerContext({
        props: props(),
        spaces: spaces(),
        panes: panes(),
        terminals: terminals(),
        focused: focused(),
        shared,
      });

      const targetKey = `vol:${vol.name}`;
      const cloneLabel = `Cloning ${vol.name} → ${destVol}`;
      const seq = ++this.actionSeq;
      this.busyTargets.set(targetKey, `Cloning to ${destVol}`);
      this.openProgressToast(targetKey, cloneLabel, seq, null, 660000);
      cx.notify();

      const attachTerminal = (address) => {
        this.openProgressToast(targetKey, cloneLabel, seq, address, 660000);
      };

      cx.spawn(async (cx) => {
        try {
          const createRes = await this.executeDockerAction(cloneSpec.createArgs, ctx, 30000, attachTerminal);
          if (createRes.address) this.scheduleActionTerminalCleanup(createRes.address, cx);
          if (createRes.code !== 0) {
            const err = (createRes.output || "Volume creation failed").trim();
            this.lastErrorText = err;
            const lines = err.split("\n").filter((line) => line.trim().length > 0);
            notify({
              title: "Volume Clone Failed",
              body: (createRes.address ? lines.slice(-3) : lines.slice(0, 3)).join("\n"),
              level: "error",
              timeout: 4000,
            });
            this.busyTargets.delete(targetKey);
            cx.notify();
            return;
          }

          const copyRes = await this.executeDockerAction(cloneSpec.copyArgs, ctx, 600000, attachTerminal);
          if (copyRes.address) this.scheduleActionTerminalCleanup(copyRes.address, cx);
          if (copyRes.code === 0) {
            notify({
              title: "Volume Cloned",
              body: `Volume "${vol.name}" cloned to "${destVol}" successfully`,
              timeout: 3000,
            });
            this.refresh(cx);
          } else {
            const err = (copyRes.output || "Data copy failed").trim();
            this.lastErrorText = err;
            const lines = err.split("\n").filter((line) => line.trim().length > 0);
            notify({
              title: "Volume Copy Failed",
              body: (copyRes.address ? lines.slice(-3) : lines.slice(0, 3)).join("\n"),
              level: "error",
              timeout: 4000,
            });
          }
        } catch (err) {
          this.lastErrorText = err.message;
          notify({
            title: "Volume Clone Failed",
            body: err.message,
            level: "error",
            timeout: 4000,
          });
        } finally {
          this.busyTargets.delete(targetKey);
          this.closeProgressToast(targetKey, seq);
          this.refresh(cx);
          this.reloadInspectorIfNeeded(cx);
          cx.notify();
        }
      });
    }
  }

  computeSingleVolumeSize(volName, cx) {
    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });
    const key = `vol:${volName}`;
    const sizeLabel = `Computing size for ${volName}`;
    const seq = ++this.actionSeq;
    this.busyTargets.set(key, sizeLabel);
    this.openProgressToast(key, sizeLabel, seq, null, 60000);
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["system", "df", "-v", "--format", "json"], {
          on: ctx.on,
          timeout: 25000,
        });
        if ((res.code ?? res.exitCode) === 0) {
          const parsed = parseSystemDfVerbose(res.stdout);
          this.systemDfVerbose = parsed;
          Object.assign(this.volumeSizes, parsed.volumeSizes);
          const size = parsed.volumeSizes[volName];
          notify({
            title: "Volume size",
            body: size ? `${volName}: ${size}` : `${volName}: size not reported by Docker`,
            level: size ? "success" : "warning",
            timeout: 4000,
          });
        } else {
          const err = (res.stderr || res.stdout || "docker system df -v failed").trim();
          notify({ title: "Volume size failed", body: err.split("\n").slice(0, 3).join("\n"), level: "error", timeout: 4000 });
        }
      } catch (err) {
        notify({ title: "Volume size failed", body: err.message, level: "error", timeout: 4000 });
      } finally {
        this.busyTargets.delete(key);
        this.closeProgressToast(key, seq);
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  runVerboseSizeCheck(cx) {
    this.systemDfLoading = true;
    cx.notify();
    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });
    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["system", "df", "-v", "--format", "json"], {
          on: ctx.on,
          timeout: 25000,
        });
        if ((res.code ?? res.exitCode) === 0) {
          const parsed = parseSystemDfVerbose(res.stdout);
          this.systemDfVerbose = parsed;
          Object.assign(this.volumeSizes, parsed.volumeSizes);
        }
      } catch {
      } finally {
        this.systemDfLoading = false;
        cx.notify();
      }
    });
  }

  runGranularPrune(cx) {
    const plan = buildGranularPrunePlan(this.granularPruneSelections);
    if (plan.commands.length === 0) return;

    const pruneLabel = "Pruning selected resources…";
    const seq = ++this.actionSeq;
    this.busyTargets.set("system:prune", "Pruning resources…");
    this.openProgressToast("system:prune", pruneLabel, seq, null, 660000);
    cx.notify();

    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    cx.spawn(async (cx) => {
      let errors = 0;
      for (const cmd of plan.commands) {
        let result;
        try {
          result = await this.executeDockerAction(cmd.argv, ctx, 600000, (address) => {
            this.openProgressToast("system:prune", pruneLabel, seq, address, 660000);
          });
        } catch {
          errors++;
          continue;
        }
        if (result.address) this.scheduleActionTerminalCleanup(result.address, cx);
        if (result.code !== 0) errors++;
      }
      this.busyTargets.delete("system:prune");
      this.closeProgressToast("system:prune", seq);
      this.refresh(cx);
      notify({
        title: "Docker Prune Finished",
        body: errors > 0 ? `Pruned with ${errors} warning(s)` : "Selected resources pruned successfully",
        level: errors > 0 ? "warning" : "info",
      });
      cx.notify();
    });
  }

  /** Runs docker CLI argv in a hidden terminal, with notifications through the toast mod (DM-16). */
  runDockerCmd(targetKey, actionLabel, argv, ctx, cx) {
    const seq = ++this.actionSeq;
    this.busyTargets.set(targetKey, actionLabel);
    try {
      cx.notify();
    } catch (err) {
      // A stale context must not leave the progress notification running forever.
      this.busyTargets.delete(targetKey);
      this.closeProgressToast(targetKey, seq);
      notify({
        title: "Docker action failed",
        body: err?.message || "The UI context was no longer available.",
        level: "error",
        timeout: 4000,
      });
      return;
    }

    // Some builders return ["docker", ...] (they are shared with terminal.open, which needs the
    // full command) and some return arguments only. Normalise here: the hidden terminal runs
    // `docker`, so a builder that includes it would produce `docker docker start <id>`.
    const dockerArgv = Array.isArray(argv) && argv[0] === "docker" ? argv.slice(1) : argv;

    const isLongOp = Array.isArray(argv) && argv.some((a) =>
      a === "build" || a === "--build" || a === "pull" || a === "prune" || a === "df"
    );
    const timeout = isLongOp ? 600000 : 60000;
    const toastTimeout = timeout + 30000;

    this.openProgressToast(targetKey, actionLabel, seq, null, toastTimeout);

    cx.spawn(async (cx) => {
      let address = null;
      try {
        const result = await this.executeDockerAction(dockerArgv, ctx, timeout, (addr) => {
          address = addr;
          this.openProgressToast(targetKey, actionLabel, seq, addr, toastTimeout);
        });

        if (result.code !== 0) {
          const err = (result.output || "Command failed").trim();
          this.lastErrorText = err;
          const lines = err.split("\n").filter((line) => line.trim().length > 0);
          notify({
            title: "Docker Error",
            body: (result.address ? lines.slice(-3) : lines.slice(0, 3)).join("\n"),
            level: "error",
            timeout: 4000,
          });
        } else {
          const reclaimed = /Total reclaimed space:\s*([0-9.]+\s*[kMGT]?B)/i.exec(result.output || "");
          notify({
            title: "Docker",
            body: reclaimed ? `${actionLabel} finished — reclaimed ${reclaimed[1]}` : `${actionLabel} finished`,
            timeout: 2500,
          });
        }
      } catch (err) {
        this.lastErrorText = err.message;
        notify({
          title: "Docker Execution Failed",
          body: err.message,
          level: "error",
          timeout: 4000,
        });
      } finally {
        this.busyTargets.delete(targetKey);
        this.closeProgressToast(targetKey, seq);
        if (address) this.scheduleActionTerminalCleanup(address, cx);
        this.refresh(cx);
        this.reloadInspectorIfNeeded(cx);
      }
    });
  }

  /** Spinner icon for the toast mod, contrasting with the toast background. */
  progressToastIcon() {
    return isLightColor(theme()?.popover)
      ? "mods/docker-manager/icons/spinner-on-light.gif"
      : "mods/docker-manager/icons/spinner-on-dark.gif";
  }

  /**
   * Opens or replaces a progress notification through `notify()`, so the
   * installed toast mod (toast-edited) renders it. `action` is passed to the
   * toast modal: its "Run action" button peeks the hidden terminal.
   *
   * @param {string} targetKey
   * @param {string} label
   * @param {number} seq
   * @param {string | null} [address]
   * @param {number} [timeout]
   */
  openProgressToast(targetKey, label, seq, address = null, timeout = 90000) {
    const current = this.busyToasts.get(targetKey);
    if (current?.id) {
      try {
        closeOverlay(current.id);
      } catch {}
    }
    const id = notify({
      title: label,
      body: address ? "Running in the background · open, then Run action to peek" : "Working in the background…",
      level: "info",
      icon: this.progressToastIcon(),
      timeout,
      ...(address ? { action: { name: "terminal.peek", args: { terminal: address } } } : {}),
    });
    if (id) this.busyToasts.set(targetKey, { id, seq });
    return id;
  }

  /** Closes the progress notification for one action unless a newer one replaced it. */
  closeProgressToast(targetKey, seq) {
    const current = this.busyToasts.get(targetKey);
    if (!current) return;
    if (seq != null && current.seq !== seq) return;
    if (current.id) {
      try {
        closeOverlay(current.id);
      } catch {}
    }
    this.busyToasts.delete(targetKey);
  }

  /**
   * Runs one Docker command in a hidden `hc` terminal so the progress toast can
   * peek it. Falls back to `exec()` when the terminal cannot be created, which
   * keeps actions working if the `hc` API is unavailable.
   *
   * @param {string[]} dockerArgv - Arguments after `docker`.
   * @param {{ cwd?: string, on?: string | null }} ctx
   * @param {number} timeout
   * @param {(address: string) => void} [onStarted]
   * @returns {Promise<{ code: number, output: string, address: string | null }>}
   */
  async executeDockerAction(dockerArgv, ctx, timeout, onStarted) {
    let address = null;
    let started = false;
    try {
      const startRes = await hc(
        buildHiddenTerminalArgs(["docker", ...dockerArgv], {
          cwd: ctx?.cwd || null,
          machine: ctx?.on || null,
        })
      );
      if ((startRes.code ?? startRes.exitCode) !== 0) {
        throw new Error((startRes.stderr || startRes.stdout || "Could not start a terminal").trim());
      }
      started = true;
      address = parseHcTerminalAddress(startRes.stdout);
      if (!address) throw new Error("The action terminal did not report an address");

      onStarted?.(address);

      const deadline = Date.now() + timeout;
      let ended = null;
      while (!ended?.ended) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          try {
            await hc(["kill", address]);
          } catch {}
          throw new Error(`Timed out after ${Math.round(timeout / 1000)}s`);
        }
        const waitRes = await hc([
          "wait",
          address,
          "--json",
          "--timeout",
          String(Math.min(180, Math.max(1, Math.ceil(remaining / 1000)))),
        ]);
        if ((waitRes.code ?? waitRes.exitCode) !== 0) {
          throw new Error((waitRes.stderr || waitRes.stdout || "Could not read the command result").trim());
        }
        ended = parseHcWaitResult(waitRes.stdout);
        if (!ended) throw new Error("Could not parse the command result");
      }

      let output = "";
      try {
        const readRes = await hc(["read", address]);
        output = stripAnsiCodes(readRes.stdout || readRes.stderr || "").trim();
      } catch {}
      const code = ended.exitCode ?? (ended.reason === "exit" ? 0 : 1);
      return { code, output, address };
    } catch (err) {
      if (started) {
        if (address) {
          try {
            await hc(["kill", address]);
          } catch {}
        }
        return { code: 1, output: err?.message || String(err), address };
      }
      // No terminal was created: use the previous background-exec path.
      const res = await exec("docker", dockerArgv, { cwd: ctx?.cwd, on: ctx?.on, timeout });
      return {
        code: res.code ?? res.exitCode ?? 0,
        output: stripAnsiCodes(res.stderr || res.stdout || "").trim(),
        address: null,
      };
    }
  }

  /**
   * Removes a finished hidden action terminal after a grace period so an open
   * peek can still be read. Terminals the user kept as tabs are left alone.
   *
   * @param {string} address
   * @param {any} cx
   */
  scheduleActionTerminalCleanup(address, cx) {
    cx.spawn(async (cx) => {
      try {
        await cx.sleep(60000);
        const infoRes = await hc(["get", address, "--json"]);
        if ((infoRes.code ?? infoRes.exitCode) !== 0) {
          try {
            await hc(["rm", address]);
          } catch {}
          return;
        }
        const info = JSON.parse(infoRes.stdout);
        const labels = info?.labels || {};
        if (labels["herdr.space"] || labels["herdr.tab"]) return;
        await hc(["rm", address]);
      } catch {}
    });
  }

  /** Reloads the inspector tab's target after an action (Stop -> Start, Tag, ...). */
  reloadInspectorIfNeeded(cx) {
    const p = props();
    if (!p?.inspect) return;
    const kind = p.inspect.kind || "container";
    let id = p.inspect.id || p.inspect.name;
    if (kind === "container" && p.inspect.project && p.inspect.service) {
      id = resolveServiceContainerId(this.containersRaw, p.inspect.project, p.inspect.service, id);
    }
    if (!id) return;
    this.inspectLoadKey = null;
    this.loadInspectData(id, cx, kind);
  }

  /** Logs terminal opening with focus reuse and split-down support (DM-80, DM-82) */
  openLogs(target, isAlt = false) {
    const activeSpace = spaces().find((s) => s.active);
    const termName = `logs: ${target.name || target.id}`;
    const existing = findExistingActionTerminal(terminals(), activeSpace?.id, termName);
    if (existing) {
      run("pane.focus", { terminal: existing.address });
      return;
    }

    // Project rows carry `name`, not `project`; without this branch the menu
    // fell through to `buildContainerLogsArgs(undefined)` and opened nothing.
    const projTarget =
      target.kind === "project"
        ? { project: target.project || target.name, configFiles: target.configFiles || [], workingDir: target.workingDirs?.[0] }
        : target.composeProject || target.project
        ? {
            project: target.composeProject || target.project,
            configFiles: target.configFiles || [],
            workingDir: target.workingDirs?.[0] || null,
          }
        : null;

    let argv;
    if (projTarget && target.kind === "service") {
      argv = buildComposeLogsArgs(projTarget, target.name, 500);
    } else if (projTarget && target.kind === "project") {
      argv = buildComposeLogsArgs(projTarget, null, 500);
    } else {
      argv = buildContainerLogsArgs(target.id, 500);
    }

    const folder = projTarget?.workingDir || target.workingDirs?.[0] || activeSpace?.folder || "/";
    run("terminal.open", {
      name: termName,
      folder,
      place: isAlt ? "down" : "tab",
      argv,
    });
  }

  /** Shell terminal opening with shell check and focus reuse (DM-81..83) */
  openShell(containerId, containerName, isAlt = false, cx) {
    const activeSpace = spaces().find((s) => s.active);
    const termName = `sh: ${containerName}`;
    const existing = findExistingActionTerminal(terminals(), activeSpace?.id, termName);
    if (existing) {
      run("pane.focus", { terminal: existing.address });
      return;
    }

    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    cx.spawn(async (cx) => {
      // Test if container has a shell available before opening terminal
      const checkRes = await exec("docker", ["exec", containerId, "sh", "-c", "exit 0"], {
        on: ctx.on,
        timeout: 4000,
      });
      if ((checkRes.code ?? checkRes.exitCode) !== 0) {
        notify({
          title: "Shell Unavailable",
          body: `Container "${containerName}" has no shell available`,
          level: "warning",
        });
        return;
      }

      const argv = buildContainerShellArgs(containerId, "auto");
      const folder = ctx.cwd || activeSpace?.folder || "/";
      run("terminal.open", {
        name: termName,
        folder,
        place: isAlt ? "down" : "tab",
        argv,
      });
    });
  }

  // --- Rendering Helpers ---

  /** Copies text to clipboard and shows toast notification (Finding 3, DM-43) */
  copyValue(text, label = "Value", cx) {
    if (!text) return;
    const str = String(text);
    if (cx?.write_to_clipboard) {
      cx.write_to_clipboard(str);
    }
    notify({
      title: "Copied to clipboard",
      body: `${label}: ${str.length > 40 ? str.slice(0, 37) + "…" : str}`,
      icon: "mods/docker-manager/icons/copy.svg",
      timeout: 2000,
    });
    if (cx) cx.notify();
  }

  /** Renders top toolbar (DM-10, Finding 4) */
  renderToolbar(t, cx) {
    const isReady = this.engineStatus === "ready";
    const statusColor = isReady ? t.done : this.engineStatus === "unavailable" ? t.blocked : t.muted;

    return h_flex()
      .flex_shrink_0()
      .h(38)
      .w_full()
      .px(10)
      .items_center()
      .justify_between()
      .bg(toColor(t.chrome))
      .border_b(1)
      .border_color(toColor(t.border))
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(div().size(8).rounded(4).bg(toColor(statusColor)))
          .child(
            div()
              .text_size(12)
              .font_semibold()
              .text_color(toColor(t.foreground))
              .child(this.engineVersion || "Docker")
          )
      )
      .child(
        h_flex()
          .items_center()
          .gap(6)
          // Scope toggle: This space / All (DM-10, DM-35..36)
          .child(
            h_flex()
              .h(22)
              .rounded(4)
              .bg(toColor(t.surface))
              .border_1()
              .border_color(toColor(t.border))
              .p(1)
              .child(
                h_flex()
                  .px(6)
                  .h(20)
                  .rounded(3)
                  .items_center()
                  .text_size(10)
                  .font_semibold()
                  .when(this.scope === "space", (el) =>
                    el.bg(toColor(t.raised)).text_color(toColor(t.foreground))
                  )
                  .when(this.scope !== "space", (el) =>
                    el.text_color(toColor(t.muted)).hover((s) => s.text_color(toColor(t.foreground)))
                  )
                  .on_click((_e, cx) => {
                    this.scope = "space";
                    cx.notify();
                  })
                  .child("This space")
              )
              .child(
                h_flex()
                  .px(6)
                  .h(20)
                  .rounded(3)
                  .items_center()
                  .text_size(10)
                  .font_semibold()
                  .when(this.scope === "all", (el) =>
                    el.bg(toColor(t.raised)).text_color(toColor(t.foreground))
                  )
                  .when(this.scope !== "all", (el) =>
                    el.text_color(toColor(t.muted)).hover((s) => s.text_color(toColor(t.foreground)))
                  )
                  .on_click((_e, cx) => {
                    this.scope = "all";
                    cx.notify();
                  })
                  .child("All")
              )
          )
          // Refresh button
          .child(
            h_flex()
              .size(24)
              .rounded(4)
              .items_center()
              .justify_center()
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => this.refresh(cx, { rescan: true }))
              .child(
                svg("mods/docker-manager/icons/refresh.svg")
                  .size(14)
                  .text_color(toColor(this.refreshing ? t.accent : t.muted))
                  .when(this.refreshing, (el) => el.spin(900))
              )
          )
          // Toolbar ⋯ menu button (DM-10)
          .child(
            h_flex()
              .size(24)
              .rounded(4)
              .items_center()
              .justify_center()
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => {
                this.toolbarMenuOpen = !this.toolbarMenuOpen;
                cx.notify();
              })
              .child(svg("mods/docker-manager/icons/more.svg").size(14).text_color(toColor(t.muted)))
          )
      );
  }

  /** Renders section switcher buttons (DM-11, Finding 4) */
  renderSectionSwitcher(t, cx) {
    const items = [
      { id: "containers", label: "Containers", icon: "container.svg" },
      { id: "images", label: "Images", icon: "layers.svg" },
      { id: "volumes", label: "Volumes", icon: "volume.svg" },
      { id: "networks", label: "Networks", icon: "network.svg" },
      { id: "system", label: "System", icon: "gauge.svg" },
    ];

    return h_flex()
      .flex_shrink_0()
      .h(32)
      .w_full()
      .px(8)
      .items_center()
      .gap(4)
      .bg(toColor(t.surface))
      .border_b(1)
      .border_color(toColor(t.border))
      .children(
        items.map((it) => {
          const isActive = this.activeSection === it.id;
          return h_flex()
            .h(24)
            .px(6)
            .rounded(4)
            .items_center()
            .gap(4)
            .text_size(11)
            .when(isActive, (el) =>
              el.bg(toColor(t.raised)).text_color(toColor(t.accent)).font_semibold()
            )
            .when(!isActive, (el) =>
              el.text_color(toColor(t.muted)).hover((s) => s.bg(toColor(t.hover)).text_color(toColor(t.foreground)))
            )
            .on_click((_e, cx) => {
              this.activeSection = it.id;
              this.selectedTarget = null;
              this.drawerOpen = false;
              this.refresh(cx);
              cx.notify();
            })
            .child(
              svg(`mods/docker-manager/icons/${it.icon}`)
                .size(13)
                .text_color(toColor(isActive ? t.accent : t.muted))
            )
            .child(it.label);
        })
      );
  }

  /** Renders filter input row (DM-12, Finding 4) */
  renderFilterBox(t, cx) {
    if (this.activeSection === "system") {
      return div();
    }
    return h_flex()
      .flex_shrink_0()
      .h(30)
      .w_full()
      .px(8)
      .items_center()
      .gap(6)
      .bg(toColor(t.background))
      .border_b(1)
      .border_color(toColor(t.border))
      .child(svg("mods/docker-manager/icons/search.svg").size(13).text_color(toColor(t.dim)))
      .child(
        Input.new(this.filterInput)
          .flex_1()
          .h_full()
          .text_size(11)
          .text_color(toColor(t.foreground))
      )
      .when(Boolean(this.filterQuery), (el) =>
        el.child(
          h_flex()
            .size(16)
            .rounded(2)
            .items_center()
            .justify_center()
            .hover((s) => s.bg(toColor(t.hover)))
            .on_click((_e, cx) => {
              this.filterInput.set_value("");
              this.filterQuery = "";
              cx.notify();
            })
            .child(svg("mods/docker-manager/icons/close.svg").size(11).text_color(toColor(t.muted)))
        )
      );
  }

  /** Flattens the container tree into the visible row list (DM-13). */
  flattenTree(tree) {
    const rows = [];

    for (const group of tree) {
      const isGroupExpanded = this.expandedGroups.has(group.id);
      rows.push({
        type: "group",
        key: `grp:${group.id}`,
        id: group.id,
        title: group.title,
        expanded: isGroupExpanded,
      });

      if (!isGroupExpanded) continue;

      if (group.id === "projects") {
        for (const proj of group.items) {
          const isProjExpanded = this.expandedProjects.has(proj.name);
          rows.push({
            type: "project",
            key: `proj:${proj.name}`,
            data: proj,
            expanded: isProjExpanded,
          });

          if (!isProjExpanded) continue;

          for (const svc of proj.services) {
            const hasReplicas = svc.containers.length > 1;
            const isSvcExpanded = this.expandedServices.has(`${proj.name}:${svc.name}`);
            rows.push({
              type: "service",
              key: `svc:${proj.name}:${svc.name}`,
              project: proj.name,
              composeProject: proj.project || proj.name,
              configFiles: proj.configFiles,
              workingDirs: proj.workingDirs,
              data: svc,
              hasReplicas,
              expanded: isSvcExpanded,
            });

            if (hasReplicas && isSvcExpanded) {
              for (const ctr of svc.containers) {
                rows.push({
                  type: "replica",
                  key: `rep:${ctr.id}`,
                  project: proj.name,
                  composeProject: proj.project || proj.name,
                  service: svc.name,
                  data: ctr,
                });
              }
            }
          }

          // Inactive profiles sub-row (DM-33)
          if (proj.inactiveProfiles && proj.inactiveProfiles.length > 0) {
            const isProfilesExpanded = this.expandedProfiles.has(proj.name);
            rows.push({
              type: "profiles-header",
              key: `prof-hdr:${proj.name}`,
              project: proj.name,
              composeProject: proj.project || proj.name,
              configFiles: proj.configFiles,
              workingDirs: proj.workingDirs,
              count: proj.inactiveProfiles.length,
              expanded: isProfilesExpanded,
            });

            if (isProfilesExpanded) {
              for (const profSvc of proj.inactiveProfiles) {
                rows.push({
                  type: "inactive-profile-service",
                  key: `prof-svc:${proj.name}:${profSvc.name}`,
                  project: proj.name,
                  composeProject: proj.project || proj.name,
                  configFiles: proj.configFiles,
                  workingDirs: proj.workingDirs,
                  data: profSvc,
                });
              }
            }
          }
        }
      } else if (group.id === "dockerfiles") {
        for (const df of group.items) {
          const isDfExpanded = this.expandedProjects.has(df.filePath);
          rows.push({
            type: "dockerfile",
            key: `df:${df.filePath}`,
            data: df,
            expanded: isDfExpanded,
          });

          if (isDfExpanded) {
            for (const ctr of df.containers) {
              rows.push({
                type: "df-container",
                key: `dfc:${ctr.id}`,
                data: ctr,
              });
            }
          }
        }
      } else if (group.id === "standalone") {
        for (const sa of group.items) {
          rows.push({
            type: "standalone",
            key: `sa:${sa.id}`,
            data: sa,
          });
        }
      }
    }

    return rows;
  }

  flattenImageTree(tree) {
    const rows = [];
    for (const img of tree.images) {
      rows.push({
        type: "image",
        key: `img:${img.id}`,
        data: img,
        isDangling: false,
      });
    }

    if (tree.dangling && tree.dangling.length > 0) {
      const isExpanded = this.expandedGroups.has("dangling-images");
      rows.push({
        type: "group",
        key: "grp:dangling-images",
        id: "dangling-images",
        title: `Dangling (${tree.dangling.length})`,
        expanded: isExpanded,
      });

      if (isExpanded) {
        for (const img of tree.dangling) {
          rows.push({
            type: "image",
            key: `img:${img.id}`,
            data: img,
            isDangling: true,
          });
        }
      }
    }
    return rows;
  }

  flattenVolumeTree(tree) {
    const rows = [];
    for (const vol of tree.volumes) {
      rows.push({
        type: "volume",
        key: `vol:${vol.name}`,
        data: vol,
        isAnon: false,
      });
    }

    if (tree.anonymous && tree.anonymous.length > 0) {
      const isExpanded = this.expandedGroups.has("anonymous-volumes");
      rows.push({
        type: "group",
        key: "grp:anonymous-volumes",
        id: "anonymous-volumes",
        title: `Anonymous (${tree.anonymous.length})`,
        expanded: isExpanded,
      });

      if (isExpanded) {
        for (const vol of tree.anonymous) {
          rows.push({
            type: "volume",
            key: `vol:${vol.name}`,
            data: vol,
            isAnon: true,
          });
        }
      }
    }
    return rows;
  }

  flattenNetworkTree(tree) {
    const rows = [];
    for (const net of tree.networks) {
      rows.push({
        type: "network",
        key: `net:${net.id}`,
        data: net,
      });
    }

    if (tree.builtIn && tree.builtIn.length > 0) {
      const isExpanded = this.expandedGroups.has("builtin-networks");
      rows.push({
        type: "group",
        key: "grp:builtin-networks",
        id: "builtin-networks",
        title: `Built-In (${tree.builtIn.length})`,
        expanded: isExpanded,
      });

      if (isExpanded) {
        for (const net of tree.builtIn) {
          rows.push({
            type: "network",
            key: `net:${net.id}`,
            data: net,
          });
        }
      }
    }
    return rows;
  }

  /** Renders a single row in the virtual list (DM-13, DM-14, DM-16, DM-20..27) */
  /**
   * One tree row with the shared click and right-click wiring. The row owns
   * the context-menu event, like the file tree does.
   */
  renderTreeRow(row, t, cx) {
    return this.renderTreeRowContent(row, t, cx)
      .id(row.key)
      .cursor_pointer()
      .cursor_context_menu()
      .on_mouse_down("right", () => {
        this.pendingContextTarget = row.key;
      })
      .on_click((_event, cx2) => this.handleRowClick(row.key, cx2));
  }

  renderTreeRowContent(row, t, _cx) {
    const isSelected =
      this.selectedTarget &&
      (this.selectedTarget.key === row.key ||
        this.selectedTarget.id === row.data?.id ||
        (row.type === "service" &&
          this.selectedTarget.project === row.project &&
          this.selectedTarget.name === row.data?.name));

    const isBusy =
      this.busyTargets.has(row.key) ||
      (row.data && (this.busyTargets.has(row.data.name) || this.busyTargets.has(row.data.id)));
    const busyLabel =
      this.busyTargets.get(row.key) ||
      (row.data && (this.busyTargets.get(row.data.name) || this.busyTargets.get(row.data.id)));

    if (row.type === "group") {
      return h_flex()
        .h(26)
        .w_full()
        .px(8)
        .items_center()
        .gap(6)
        .bg(toColor(t.surface))
        .hover((s) => s.bg(toColor(t.hover)))
        .child(
          svg(
            row.expanded
              ? "mods/docker-manager/icons/chevron-down.svg"
              : "mods/docker-manager/icons/chevron-right.svg"
          )
            .size(12)
            .text_color(toColor(t.muted))
        )
        .child(
          div()
            .text_size(10)
            .font_semibold()
            .text_color(toColor(t.muted))
            .child(row.title.toUpperCase())
        );
    }

    if (row.type === "project") {
      const p = row.data;
      const dotColor =
        p.status === "running"
          ? t.done
          : p.status === "partial"
          ? t.working
          : p.status === "error"
          ? t.blocked
          : t.muted;

      return h_flex()
        .h(28)
        .w_full()
        .pl(14)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(
              svg(
                row.expanded
                  ? "mods/docker-manager/icons/chevron-down.svg"
                  : "mods/docker-manager/icons/chevron-right.svg"
              )
                .size(12)
                .text_color(toColor(t.muted))
            )
            .child(svg("mods/docker-manager/icons/compose.svg").size(14).text_color(toColor(t.accent)))
            .child(
              div()
                .text_size(12)
                .font_semibold()
                .text_color(toColor(p.notCreated ? t.dim : t.foreground))
                .child(p.name)
            )
            .when(p.notCreated, (el) =>
              el.child(div().text_size(11).text_color(toColor(t.dim)).child("(not created)"))
            )
            .when(p.inSpace, (el) =>
              el.child(
                div()
                  .px(4)
                  .py(1)
                  .rounded(3)
                  .bg(toColor(t.raised))
                  .text_size(9)
                  .text_color(toColor(t.accent))
                  .child("this space")
              )
            )
            .when(p.mixedSources, (el) =>
              el.child(
                svg("mods/docker-manager/icons/warning.svg")
                  .size(13)
                  .text_color(toColor(t.working))
              )
            )
            .when(Boolean(p.configError), (el) =>
              el.child(
                h_flex()
                  .items_center()
                  .tooltip(p.configError)
                  .child(
                    svg("mods/docker-manager/icons/warning.svg")
                      .size(13)
                      .text_color(toColor(t.blocked))
                  )
              )
            )
            .when(Boolean(p.external), (el) =>
              el.child(
                h_flex()
                  .items_center()
                  .px(4)
                  .py(1)
                  .rounded(3)
                  .bg(toColor(t.raised))
                  .tooltip("Containers exist but are hidden from docker ps (Docker Desktop extension or filtered daemon).")
                  .child(
                    div()
                      .text_size(9)
                      .text_color(toColor(t.working))
                      .child("external")
                  )
              )
            )
            .when(isBusy, (el) =>
              el
                .child(
                  svg("mods/docker-manager/icons/spinner.svg")
                    .size(12)
                    .text_color(toColor(t.accent))
                    .spin(900)
                )
                .child(
                  div()
                    .text_size(10)
                    .text_color(toColor(t.dim))
                    .child(busyLabel || "working…")
                )
            )
        )
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .when(!p.notCreated && !isBusy, (el) =>
              el
                .child(div().size(6).rounded(3).bg(toColor(dotColor)))
                .child(
                  div()
                    .text_size(11)
                    .text_color(toColor(t.muted))
                    .child(`${p.runningCount}/${p.totalCount}`)
                )
            )
            .when(Boolean(p.composeBasenames), (el) =>
              el.child(
                div()
                  .text_size(10)
                  .text_color(toColor(t.dim))
                  .child(p.composeBasenames)
              )
            )
        );
    }

    if (row.type === "service") {
      const s = row.data;
      const dotColor =
        s.statusColor === "done"
          ? t.done
          : s.statusColor === "working"
          ? t.working
          : s.statusColor === "error"
          ? t.blocked
          : t.muted;

      return h_flex()
        .h(26)
        .w_full()
        .pl(28)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .when(row.hasReplicas, (el) =>
              el.child(
                svg(
                  row.expanded
                    ? "mods/docker-manager/icons/chevron-down.svg"
                    : "mods/docker-manager/icons/chevron-right.svg"
                )
                  .size(11)
                  .text_color(toColor(t.muted))
              )
            )
            .when(!row.hasReplicas, (el) => el.child(div().w(11)))
            .child(
              div()
                .size(6)
                .rounded(3)
                .when(s.notCreated, (el) =>
                  el.border_1().border_color(toColor(t.dim)).bg(toColor(t.background))
                )
                .when(!s.notCreated, (el) => el.bg(toColor(dotColor)))
            )
            .child(
              div()
                .text_size(11)
                .text_color(toColor(s.notCreated ? t.dim : t.foreground))
                .child(s.name)
            )
            .when(isBusy, (el) =>
              el
                .child(
                  svg("mods/docker-manager/icons/spinner.svg")
                    .size(11)
                    .text_color(toColor(t.accent))
                    .spin(900)
                )
                .child(div().text_size(10).text_color(toColor(t.dim)).child(busyLabel || ""))
            )
        )
        // Uptime/state stays visible, but the full status, health and ports
        // detail remains in the drawer.
        .child(
          div()
            .max_w(180)
            .truncate()
            .text_size(10)
            .text_color(toColor(s.notCreated ? t.dim : t.muted))
            .child(s.statusText || "")
        );
    }

    if (row.type === "replica") {
      const ctr = row.data;
      return h_flex()
        .h(24)
        .w_full()
        .pl(46)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(svg("mods/docker-manager/icons/container.svg").size(12).text_color(toColor(t.muted)))
            .child(
              div()
                .text_size(11)
                .text_color(toColor(t.foreground))
                .child(ctr.name || ctr.shortId)
            )
            .when(isBusy, (el) =>
              el.child(
                svg("mods/docker-manager/icons/spinner.svg")
                  .size(11)
                  .text_color(toColor(t.accent))
                  .spin(900)
              )
            )
        )
        .child(
          div()
            .text_size(10)
            .text_color(toColor(t.dim))
            .child(ctr.status || (ctr.running ? "running" : "exited"))
        );
    }

    if (row.type === "profiles-header") {
      return h_flex()
        .h(26)
        .w_full()
        .pl(32)
        .pr(8)
        .items_center()
        .gap(6)
        .hover((s) => s.bg(toColor(t.hover)))
        .child(
          svg(
            row.expanded
              ? "mods/docker-manager/icons/chevron-down.svg"
              : "mods/docker-manager/icons/chevron-right.svg"
          )
            .size(11)
            .text_color(toColor(t.muted))
        )
        .child(
          div()
            .text_size(11)
            .text_color(toColor(t.dim))
            .child(`Profiles (${row.count} inactive)`)
        );
    }

    if (row.type === "inactive-profile-service") {
      const profSvc = row.data;
      const profilesStr = profSvc.profiles ? profSvc.profiles.map((pr) => `[${pr}]`).join(" ") : "";
      return h_flex()
        .h(26)
        .w_full()
        .pl(46)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(div().size(6).rounded(3).border_1().border_color(toColor(t.dim)).bg(toColor(t.background)))
            .child(
              div()
                .text_size(11)
                .text_color(toColor(t.dim))
                .child(profSvc.name)
            )
            .child(
              div()
                .text_size(9)
                .px(4)
                .py(1)
                .rounded(2)
                .bg(toColor(t.raised))
                .text_color(toColor(t.muted))
                .child(profilesStr)
            )
            .when(isBusy, (el) =>
              el
                .child(
                  svg("mods/docker-manager/icons/spinner.svg")
                    .size(11)
                    .text_color(toColor(t.accent))
                    .spin(900)
                )
                .child(div().text_size(10).text_color(toColor(t.dim)).child(busyLabel || ""))
            )
        )
        .child(
          div()
            .text_size(10)
            .text_color(toColor(t.dim))
            .child("inactive")
        );
    }

    if (row.type === "dockerfile") {
      const df = row.data;
      return h_flex()
        .h(28)
        .w_full()
        .pl(14)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(
              svg(
                row.expanded
                  ? "mods/docker-manager/icons/chevron-down.svg"
                  : "mods/docker-manager/icons/chevron-right.svg"
              )
                .size(12)
                .text_color(toColor(t.muted))
            )
            .child(svg("mods/docker-manager/icons/docker.svg").size(14).text_color(toColor(t.accent)))
            .child(
              div()
                .text_size(12)
                .font_semibold()
                .text_color(toColor(t.foreground))
                .child(df.relativePath)
            )
        )
        .child(
          div()
            .text_size(10)
            .text_color(toColor(t.muted))
            .child(`${df.runningCount} running`)
        );
    }

    if (row.type === "df-container" || row.type === "standalone") {
      const ctr = row.data;
      const dotColor = ctr.running ? t.done : t.muted;

      return h_flex()
        .h(26)
        .w_full()
        .pl(row.type === "df-container" ? 28 : 14)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(div().size(6).rounded(3).bg(toColor(dotColor)))
            .child(
              div()
                .text_size(11)
                .text_color(toColor(t.foreground))
                .child(ctr.name || ctr.shortId)
            )
            .when(Boolean(ctr.image), (el) =>
              el.child(
                div()
                  .text_size(10)
                  .text_color(toColor(t.dim))
                  .child(ctr.image)
              )
            )
            .when(isBusy, (el) =>
              el.child(
                svg("mods/docker-manager/icons/spinner.svg")
                  .size(11)
                  .text_color(toColor(t.accent))
                  .spin(900)
              )
            )
        )
        .child(
          div()
            .text_size(10)
            .text_color(toColor(t.dim))
            .child(ctr.status || (ctr.running ? "running" : "exited"))
        );
    }

    if (row.type === "image") {
      const img = row.data;
      const isBusy = this.busyTargets.has(row.key) || this.busyTargets.has(img.id);
      const isSelected = this.selectedTarget && (this.selectedTarget.key === row.key || this.selectedTarget.id === img.id);

      return h_flex()
        .h(28)
        .w_full()
        .pl(row.isDangling ? 26 : 10)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(svg("mods/docker-manager/icons/layers.svg").size(13).text_color(toColor(t.accent)))
            .child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(toColor(t.foreground))
                .child(img.name)
            )
            .when(Boolean(img.shortId && !row.isDangling), (el) =>
              el.child(
                div()
                  .text_size(10)
                  .text_color(toColor(t.dim))
                  .child(img.shortId)
              )
            )
            .when(Boolean(img.inUse), (el) =>
              el.child(
                div()
                  .px(4)
                  .py(1)
                  .rounded(2)
                  .bg(toColor(t.raised))
                  .text_size(9)
                  .font_semibold()
                  .text_color(toColor(t.accent))
                  .child("in use")
              )
            )
            .when(isBusy, (el) =>
              el.child(
                svg("mods/docker-manager/icons/spinner.svg")
                  .size(11)
                  .text_color(toColor(t.accent))
                  .spin(900)
              )
            )
        )
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(
              div()
                .text_size(10)
                .text_color(toColor(t.muted))
                .child(img.size || "")
            )
        );
    }

    if (row.type === "volume") {
      const vol = row.data;
      const isBusy = this.busyTargets.has(row.key) || this.busyTargets.has(vol.name);
      const isSelected = this.selectedTarget && (this.selectedTarget.key === row.key || this.selectedTarget.name === vol.name);

      return h_flex()
        .h(28)
        .w_full()
        .pl(row.isAnon ? 26 : 10)
        .pr(8)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(svg("mods/docker-manager/icons/volume.svg").size(13).text_color(toColor(t.accent)))
            .child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(toColor(t.foreground))
                .child(row.isAnon ? vol.name.slice(0, 12) : vol.name)
            )
            .when(Boolean(vol.project), (el) =>
              el.child(
                div()
                  .px(4)
                  .py(1)
                  .rounded(2)
                  .bg(toColor(t.raised))
                  .text_size(9)
                  .text_color(toColor(t.muted))
                  .child(vol.project)
              )
            )
            .child(
              div()
                .px(4)
                .py(1)
                .rounded(2)
                .bg(toColor(vol.inUse ? t.raised : t.surface))
                .text_size(9)
                .text_color(toColor(vol.inUse ? t.accent : t.dim))
                .child(vol.inUse ? "in use" : "unused")
            )
            .when(isBusy, (el) =>
              el.child(
                svg("mods/docker-manager/icons/spinner.svg")
                  .size(11)
                  .text_color(toColor(t.accent))
                  .spin(900)
              )
            )
        )
        .child(
          div()
            .text_size(10)
            .text_color(toColor(t.muted))
            .child(vol.size || "")
        );
    }

    if (row.type === "network") {
      const net = row.data;
      const isBusy = this.busyTargets.has(row.key) || this.busyTargets.has(net.id);
      const isSelected = this.selectedTarget && (this.selectedTarget.key === row.key || this.selectedTarget.id === net.id);

      return h_flex()
        .h(28)
        .w_full()
        .px(10)
        .items_center()
        .justify_between()
        .when(isSelected, (el) => el.bg(toColor(t.selected)))
        .when(!isSelected, (el) => el.hover((s) => s.bg(toColor(t.hover))))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(svg("mods/docker-manager/icons/network.svg").size(13).text_color(toColor(t.accent)))
            .child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(toColor(t.foreground))
                .child(net.name)
            )
            .when(Boolean(net.project), (el) =>
              el.child(
                div()
                  .px(4)
                  .py(1)
                  .rounded(2)
                  .bg(toColor(t.raised))
                  .text_size(9)
                  .text_color(toColor(t.muted))
                  .child(net.project)
              )
            )
            .when(Boolean(net.builtIn), (el) =>
              el.child(
                div()
                  .px(4)
                  .py(1)
                  .rounded(2)
                  .bg(toColor(t.raised))
                  .text_size(9)
                  .text_color(toColor(t.dim))
                  .child("built-in")
              )
            )
            .when(isBusy, (el) =>
              el.child(
                svg("mods/docker-manager/icons/spinner.svg")
                  .size(11)
                  .text_color(toColor(t.accent))
                  .spin(900)
              )
            )
        )
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .when((net.connectedCount || 0) > 0, (el) =>
              el.child(
                div()
                  .px(4)
                  .py(1)
                  .rounded(2)
                  .bg(toColor(t.raised))
                  .text_size(9)
                  .text_color(toColor(t.accent))
                  .child(`${net.connectedCount} connected`)
              )
            )
            .child(
              div()
                .text_size(10)
                .text_color(toColor(t.dim))
                .child(net.driver || "")
            )
        );
    }

    return div();
  }

  /** Renders inspector drawer showing normalized container inspect data (DM-40..43) */
  renderInspectorDrawer(t, cx) {
    const sel = this.selectedTarget;
    if (!sel) return div();

    const title = sel.name || sel.data?.name || "Target";
    const projName = sel.project || sel.data?.project;

    return v_flex()
      .size_full()
      .bg(toColor(t.surface))
      .border_t(1)
      .border_color(toColor(t.border))
      // Header
      .child(
        h_flex()
          .h(30)
          .w_full()
          .px(8)
          .items_center()
          .justify_between()
          .bg(toColor(t.chrome))
          .border_b(1)
          .border_color(toColor(t.border))
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div()
                  .text_size(11)
                  .font_semibold()
                  .text_color(toColor(t.foreground))
                  .child(`Details: ${title}`)
              )
              .when(Boolean(projName), (el) =>
                el.child(
                  div()
                    .text_size(10)
                    .text_color(toColor(t.dim))
                    .child(`(${projName})`)
                )
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(4)
              // Expand to Inspector Tab (DM-44)
              .child(
                h_flex()
                  .size(20)
                  .rounded(2)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    const kind = sel.type || "container";
                    const id = this.inspectData?.id || sel.containerId || sel.id;
                    const name = sel.name || title;
                    run("tab.new", {
                      name: `Inspect: ${title}`,
                      mod: "docker-manager",
                      props: {
                        inspect: {
                          kind,
                          id,
                          name,
                          project: sel.composeProject || sel.project || projName,
                          service: sel.service || sel.name,
                          configFiles: sel.configFiles,
                          workingDir: sel.workingDirs?.[0] || null,
                        },
                      },
                    });
                  })
                  .child(svg("mods/docker-manager/icons/expand.svg").size(12).text_color(toColor(t.muted)))
              )
              // Close drawer (✕)
              .child(
                h_flex()
                  .size(20)
                  .rounded(2)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.drawerOpen = false;
                    cx.notify();
                  })
                  .child(svg("mods/docker-manager/icons/close.svg").size(12).text_color(toColor(t.muted)))
              )
          )
      )
      // Content body
      .child(
        v_flex()
          .flex_1()
          .p(8)
          .gap(6)
          .overflow_y_scrollbar()
          .when(this.inspectLoading, (el) =>
            el
              .items_center()
              .justify_center()
              .child(
                svg("mods/docker-manager/icons/spinner.svg")
                  .size(18)
                  .text_color(toColor(t.accent))
                  .spin(900)
              )
          )
          .when(!this.inspectLoading && Boolean(this.inspectData), (el) => {
            const data = this.inspectData;

            if (sel.type === "image") {
              return el
                .child(this.renderDrawerRow("Image ID", data.id || data.shortId, t, cx, true))
                .child(this.renderDrawerRow("Tags", (data.repoTags || []).join(", ") || "<none>", t, cx, true))
                .child(this.renderDrawerRow("Size", data.size || "0B", t, cx))
                .child(this.renderDrawerRow("Created", data.created || "", t, cx))
                .child(this.renderDrawerRow("OS / Arch", `${data.os || ""} / ${data.architecture || ""}`, t, cx))
                .when(Boolean(data.config?.exposedPorts?.length), (pEl) =>
                  pEl.child(this.renderDrawerRow("Exposed Ports", data.config.exposedPorts.join(", "), t, cx))
                )
                .when(Boolean(data.config?.cmd?.length), (cEl) =>
                  cEl.child(this.renderDrawerRow("CMD", data.config.cmd.join(" "), t, cx, true))
                )
                .when(Boolean(data.config?.entrypoint?.length), (eEl) =>
                  eEl.child(this.renderDrawerRow("Entrypoint", data.config.entrypoint.join(" "), t, cx, true))
                );
            }

            if (sel.type === "volume") {
              const usingCtrs = data.usingContainers || sel.usedByContainers || [];
              return el
                .child(this.renderDrawerRow("Volume Name", data.name, t, cx, true))
                .child(this.renderDrawerRow("Driver", data.driver || "local", t, cx))
                .child(this.renderDrawerRow("Mountpoint", data.mountpoint || "", t, cx, true))
                .child(this.renderDrawerRow("Size", data.size || sel.size || "Not computed", t, cx))
                .child(this.renderDrawerRow("Created", data.createdAt || "", t, cx))
                .when(Boolean(usingCtrs.length), (cEl) =>
                  cEl.child(
                    h_flex()
                      .gap(8)
                      .text_size(11)
                      .child(div().w(80).text_color(toColor(t.muted)).child("Containers"))
                      .child(
                        h_flex()
                          .flex_1()
                          .gap(6)
                          .flex_wrap()
                          .children(
                            usingCtrs.map((c) =>
                              div()
                                .px(6)
                                .py(2)
                                .rounded(3)
                                .bg(toColor(t.raised))
                                .text_color(toColor(t.accent))
                                .hover((s) => s.underline())
                                .on_click((_e, cx) => {
                                  this.activeSection = "containers";
                                  this.drawerOpen = true;
                                  this.selectTarget({ id: c.id, name: c.name, type: "container", key: `ctr:${c.id}` }, cx);
                                })
                                .child(c.name || c.id)
                            )
                          )
                      )
                  )
                );
            }

            if (sel.type === "network") {
              const connected = data.containers || [];
              return el
                .child(this.renderDrawerRow("Network Name", data.name, t, cx, true))
                .child(this.renderDrawerRow("Network ID", data.shortId || data.id, t, cx, true))
                .child(this.renderDrawerRow("Driver", data.driver || "bridge", t, cx))
                .child(this.renderDrawerRow("Scope", data.scope || "local", t, cx))
                .child(this.renderDrawerRow("Internal", data.internal ? "Yes" : "No", t, cx))
                .child(this.renderDrawerRow("Subnet", data.ipam?.subnet || "N/A", t, cx))
                .child(this.renderDrawerRow("Gateway", data.ipam?.gateway || "N/A", t, cx))
                .when(Boolean(connected.length), (cEl) =>
                  cEl.child(
                    h_flex()
                      .gap(8)
                      .text_size(11)
                      .child(div().w(80).text_color(toColor(t.muted)).child("Connected"))
                      .child(
                        h_flex()
                          .flex_1()
                          .gap(6)
                          .flex_wrap()
                          .children(
                            connected.map((c) =>
                              h_flex()
                                .gap(4)
                                .px(6)
                                .py(2)
                                .rounded(3)
                                .bg(toColor(t.raised))
                                .hover((s) => s.bg(toColor(t.hover)))
                                .on_click((_e, cx) => {
                                  this.activeSection = "containers";
                                  this.drawerOpen = true;
                                  this.selectTarget({ id: c.id, name: c.name, type: "container", key: `ctr:${c.id}` }, cx);
                                })
                                .child(div().text_color(toColor(t.accent)).child(c.name || c.shortId))
                                .when(Boolean(c.ipv4), (ipEl) =>
                                  ipEl.child(div().text_color(toColor(t.dim)).child(`(${c.ipv4})`))
                                )
                            )
                          )
                      )
                  )
                );
            }

            const restartPolicyStr = data.restartPolicy?.name
              ? (data.restartPolicy.maximumRetryCount > 0
                  ? `${data.restartPolicy.name}:${data.restartPolicy.maximumRetryCount}`
                  : data.restartPolicy.name)
              : "no";
            const startedAtIsUnset = !data.startedAt || String(data.startedAt).startsWith("0001-01-01");
            const createdStartedStr = data.created && !startedAtIsUnset
              ? `${data.created} / ${data.startedAt}`
              : (data.created || (startedAtIsUnset ? "" : data.startedAt));
            const composeFilesStr = Array.isArray(data.composeFiles)
              ? data.composeFiles.join(", ")
              : (data.composeFiles || "");
            const dependsOnStr = Array.isArray(data.dependsOn)
              ? data.dependsOn.join(", ")
              : (data.dependsOn || "");
            const isUnhealthy = Boolean(
              data.health?.status &&
              data.health.status !== "healthy" &&
              data.health?.lastLog
            );

            return el
              .child(this.renderDrawerRow("Name", data.name, t, cx, true))
              .child(this.renderDrawerRow("Container ID", data.shortId, t, cx, true, data.id || data.shortId))
              .child(this.renderDrawerRow("Image", data.image, t, cx, true))
              .child(
                this.renderDrawerRow(
                  "Status",
                  `${data.state.status}${data.health.status ? ` (${data.health.status})` : ""}`,
                  t,
                  cx,
                  true
                )
              )
              .when(isUnhealthy, (hEl) =>
                hEl.child(
                  this.renderDrawerRow(
                    "Health Check",
                    data.health.lastLog.trim().replace(/\s+/g, " "),
                    t,
                    cx,
                    true,
                    data.health.lastLog
                  )
                )
              )
              .child(this.renderDrawerRow("Restart Policy", restartPolicyStr, t, cx, true))
              .child(
                this.renderDrawerRow(
                  "Created / Started",
                  createdStartedStr,
                  t,
                  cx,
                  true,
                  data.created && data.startedAt
                    ? `Created: ${data.created}, Started: ${data.startedAt}`
                    : createdStartedStr
                )
              )
              .when(Boolean(data.ports && data.ports.length > 0), (pEl) =>
                pEl.child(
                  h_flex()
                    .gap(8)
                    .text_size(11)
                    .child(
                      div()
                        .w(80)
                        .text_color(toColor(t.muted))
                        .child("Ports")
                    )
                    .child(
                      h_flex()
                        .flex_1()
                        .gap(6)
                        .children(
                          data.ports.map((pt) =>
                            h_flex()
                              .gap(4)
                              .items_center()
                              .when(Boolean(pt.hostPort), (linkEl) =>
                                linkEl
                                  .child(
                                    div()
                                      .text_color(toColor(t.accent))
                                      .hover((s) => s.underline())
                                      .on_click((_e, cx) => {
                                        const url = `http://localhost:${pt.hostPort}`;
                                        if (cx?.open_url) {
                                          cx.open_url(url);
                                        } else {
                                          exec("open", [url]);
                                        }
                                      })
                                      .child(`:${pt.hostPort}`)
                                  )
                                  .child(div().text_color(toColor(t.dim)).child("→"))
                              )
                              .child(
                                div()
                                  .text_color(toColor(t.foreground))
                                  .cursor_pointer()
                                  .hover((s) => s.text_color(toColor(t.accent)))
                                  .on_click((_e, cx) => {
                                    const portLabel = pt.hostPort
                                      ? `${pt.hostPort}:${pt.containerPort}/${pt.proto}`
                                      : `${pt.containerPort}/${pt.proto}`;
                                    this.copyValue(portLabel, "Port", cx);
                                  })
                                  .child(`${pt.containerPort}/${pt.proto}`)
                              )
                          )
                        )
                    )
                )
              )
              .when(Boolean(data.mounts && data.mounts.length > 0), (mEl) =>
                mEl.child(
                  this.renderDrawerRow(
                    "Mounts",
                    data.mounts.map((m) => `${m.destination} (${m.type})`).join(", "),
                    t,
                    cx,
                    true
                  )
                )
              )
              .when(Boolean(data.networks && data.networks.length > 0), (nEl) =>
                nEl.child(
                  this.renderDrawerRow(
                    "Networks",
                    data.networks.map((n) => `${n.name} (${n.ipAddress || "no IP"})`).join(", "),
                    t,
                    cx,
                    true
                  )
                )
              )
              .child(this.renderDrawerRow("Command", data.cmd || data.entrypoint, t, cx, true))
              .when(Boolean(data.workingDir), (wEl) =>
                wEl.child(this.renderDrawerRow("Working Dir", data.workingDir, t, cx, true))
              )
              .when(Boolean(composeFilesStr), (cEl) =>
                cEl.child(this.renderDrawerRow("Compose Files", composeFilesStr, t, cx, true))
              )
              .when(Boolean(dependsOnStr), (dEl) =>
                dEl.child(this.renderDrawerRow("Depends On", dependsOnStr, t, cx, true))
              );
          })
          .when(!this.inspectLoading && !this.inspectData && Boolean(sel.notCreated), (el) => {
            const selFiles = Array.isArray(sel.configFiles) ? sel.configFiles : [];
            const disc = this.discoveredCompose.find((d) => {
              const files = Array.isArray(d.files) && d.files.length > 0 ? d.files : [d.filePath];
              if (selFiles.length > 0) return files.some((file) => selFiles.includes(file));
              return d.project === (sel.composeProject || sel.project);
            });
            const sCfg = disc?.config?.services?.[sel.name] || {};
            const image = sCfg.image || (sCfg.build ? (typeof sCfg.build === "string" ? sCfg.build : sCfg.build.context || "build from source") : "None");
            const ports = Array.isArray(sCfg.ports)
              ? sCfg.ports.map((p) => (typeof p === "string" ? p : `${p.published || p.target}→${p.target}`)).join(", ")
              : "";
            const volumes = Array.isArray(sCfg.volumes)
              ? sCfg.volumes.map((v) => (typeof v === "string" ? v : `${v.source}→${v.target}`)).join(", ")
              : "";
            const networks = sCfg.networks ? Object.keys(sCfg.networks).join(", ") : "";
            const envKeys = sCfg.environment ? Object.keys(sCfg.environment).join(", ") : "";
            const profiles = Array.isArray(sCfg.profiles) ? sCfg.profiles.join(", ") : "";
            const dependsOn = Array.isArray(sCfg.dependsOn) ? sCfg.dependsOn.join(", ") : "";

            return el
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .pb(6)
                  .border_b(1)
                  .border_color(toColor(t.border))
                  .child(
                    div()
                      .text_size(11)
                      .text_color(toColor(t.dim))
                      .child("Declared in Compose, but not yet created.")
                  )
                  .child(
                    h_flex()
                      .px(10)
                      .h(24)
                      .rounded(4)
                      .bg(toColor(t.accent))
                      .items_center()
                      .text_size(11)
                      .font_semibold()
                      .text_color(toColor(t.solid_foreground))
                      .hover((s) => s.opacity(0.85))
                      .on_click((_e, cx) => {
                        const ctx = resolveDockerContext({
                          props: props(),
                          spaces: spaces(),
                          panes: panes(),
                          terminals: terminals(),
                          focused: focused(),
                          shared,
                        });
                        const upArgs = buildComposeUpArgs(
                          {
                            project: sel.composeProject || sel.project,
                            configFiles: sel.configFiles || [],
                            workingDir: sel.workingDirs?.[0] || null,
                          },
                          { service: sel.name }
                        );
                        this.runDockerCmd(`svc:${sel.project}:${sel.name}`, `Up service ${sel.name}`, upArgs, ctx, cx);
                      })
                      .child(`Up service "${sel.name}"`)
                  )
              )
              .child(this.renderDrawerRow("Image", image, t, cx, true))
              .when(Boolean(ports), (dEl) => dEl.child(this.renderDrawerRow("Ports", ports, t, cx)))
              .when(Boolean(volumes), (dEl) => dEl.child(this.renderDrawerRow("Volumes", volumes, t, cx)))
              .when(Boolean(networks), (dEl) => dEl.child(this.renderDrawerRow("Networks", networks, t, cx)))
              .when(Boolean(envKeys), (dEl) => dEl.child(this.renderDrawerRow("Environment", envKeys, t, cx)))
              .when(Boolean(profiles), (dEl) => dEl.child(this.renderDrawerRow("Profiles", profiles, t, cx)))
              .when(Boolean(dependsOn), (dEl) => dEl.child(this.renderDrawerRow("Depends on", dependsOn, t, cx)));
          })
      );
  }

  /** Key-value row in Inspector Drawer with copy-on-click (DM-43) */
  renderDrawerRow(label, value, t, cx, copyable = true, copyVal = null) {
    if (!value) return div();
    const str = String(value);
    const toCopy = copyVal !== null && copyVal !== undefined ? String(copyVal) : str;
    return h_flex()
      .items_start()
      .gap(8)
      .text_size(11)
      .child(
        div()
          .w(80)
          .flex_none()
          .text_color(toColor(t.muted))
          .child(label)
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .whitespace_normal()
          .text_color(toColor(t.foreground))
          .when(copyable, (el) =>
            el
              .cursor_pointer()
              .hover((s) => s.text_color(toColor(t.accent)))
              .on_click(() => this.copyValue(toCopy, label, cx))
          )
          .child(str)
      );
  }

  /** In-panel context menu overlay (DM-14, DM-50..73, DESIGN §5.4) */
  renderContextMenu(t, cx) {
    const menu = this.contextMenu;
    if (!menu) return div();

    return h_flex()
      .id("docker-context-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        this.contextMenu = null;
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        this.contextMenu = null;
        cx.notify();
      })
      .child(
        v_flex()
          .id("docker-context-menu")
          .absolute()
          .left(menu.x)
          .top(menu.y)
          .w(220)
          .max_w(280)
          .bg(toColor(t.popover))
          .border_1()
          .border_color(toColor(t.border))
          .rounded(6)
          .shadow_md()
          .p(4)
          .gap(1)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .children(
            menu.items.map((item, idx) => {
              const isDestructive = Boolean(item.destructive);
              const isDisabled = !item.enabled;
              const prevItem = idx > 0 ? menu.items[idx - 1] : null;
              const needsDivider = isDestructive && prevItem && !prevItem.destructive;

              return v_flex()
                .w_full()
                .when(needsDivider, (el) =>
                  el.child(div().my(2).h(1).bg(toColor(t.border)))
                )
                .child(
                  h_flex()
                    .h(24)
                    .w_full()
                    .px(6)
                    .rounded(4)
                    .items_center()
                    .justify_between()
                    .when(isDisabled, (el) => el.opacity(0.45))
                    .when(!isDisabled, (el) =>
                      el
                        .hover((s) => s.bg(toColor(t.hover)))
                        .on_click((e, cx) => {
                          this.contextMenu = null;
                          this.executeAction(item, menu.row, Boolean(e?.modifiers?.alt), cx);
                        })
                    )
                    .child(
                      h_flex()
                        .items_center()
                        .gap(6)
                        .child(
                          svg(`mods/docker-manager/icons/${item.icon || "play.svg"}`)
                            .size(12)
                            .text_color(toColor(isDisabled ? t.dim : isDestructive ? t.blocked : t.muted))
                        )
                        .child(
                          div()
                            .text_size(11)
                            .text_color(toColor(isDisabled ? t.dim : isDestructive ? t.blocked : t.foreground))
                            .child(item.label)
                        )
                    )
                    .when(Boolean(item.disabledReason), (el) =>
                      el.child(
                        div()
                          .text_size(9)
                          .text_color(toColor(t.dim))
                          .child(item.disabledReason)
                      )
                    )
                );
            })
          )
      );
  }

  /** In-panel confirmation dialog overlay (DM-85..86) */
  renderConfirmDialog(t, cx) {
    const dialog = this.confirmDialog;
    if (!dialog) return div();

    const isTypedValid = !dialog.typedTarget || this.confirmInputValue.trim() === dialog.typedTarget;

    return h_flex()
      .id("docker-confirm-backdrop")
      .absolute()
      .inset_0()
      .bg(toColor(t.background + "aa"))
      .items_center()
      .justify_center()
      .p(16)
      .on_mouse_down("left", (_e, cx) => {
        this.confirmDialog = null;
        cx.notify();
      })
      .child(
        v_flex()
          .id("docker-confirm-dialog")
          .w(320)
          .max_w_full()
          .bg(toColor(t.surface))
          .border_1()
          .border_color(toColor(dialog.destructive ? t.blocked : t.border))
          .rounded(6)
          .shadow_md()
          .p(14)
          .gap(10)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                svg("mods/docker-manager/icons/warning.svg")
                  .size(16)
                  .text_color(toColor(dialog.destructive ? t.blocked : t.working))
              )
              .child(
                div()
                  .text_size(13)
                  .font_semibold()
                  .text_color(toColor(t.foreground))
                  .child(dialog.title)
              )
          )
          .child(
            div()
              .text_size(11)
              .text_color(toColor(t.muted))
              .child(dialog.message)
          )
          .when(Boolean(dialog.typedTarget), (el) =>
            el
              .child(
                div()
                  .text_size(11)
                  .text_color(toColor(t.foreground))
                  .child(`Type "${dialog.typedTarget}" to confirm:`)
              )
              .child(
                h_flex()
                  .h(28)
                  .w_full()
                  .px(6)
                  .rounded(4)
                  .border_1()
                  .border_color(toColor(t.border))
                  .bg(toColor(t.background))
                  .child(
                    Input.new(this.confirmInput)
                      .flex_1()
                      .h_full()
                      .text_size(11)
                      .text_color(toColor(t.foreground))
                  )
              )
          )
          .child(
            h_flex()
              .justify_end()
              .gap(8)
              .mt(4)
              .child(
                h_flex()
                  .px(10)
                  .h(26)
                  .rounded(4)
                  .bg(toColor(t.raised))
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .text_size(11)
                  .text_color(toColor(t.foreground))
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.confirmDialog = null;
                    cx.notify();
                  })
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .px(10)
                  .h(26)
                  .rounded(4)
                  .when(isTypedValid, (el) =>
                    el
                      .bg(toColor(dialog.destructive ? t.blocked : t.solid))
                      .text_color(toColor(dialog.destructive ? t.accent_foreground : t.solid_foreground))
                      .hover((s) => s.opacity(0.9))
                      .on_click((_e, cx) => {
                        const runConfirm = dialog.confirmAction;
                        this.confirmDialog = null;
                        if (runConfirm) runConfirm(cx);
                        cx.notify();
                      })
                  )
                  .when(!isTypedValid, (el) =>
                    el
                      .bg(toColor(t.raised))
                      .text_color(toColor(t.dim))
                      .opacity(0.5)
                  )
                  .items_center()
                  .text_size(11)
                  .font_semibold()
                  .child(dialog.confirmLabel || "Confirm")
              )
          )
      );
  }

  /** Toolbar ⋯ popup menu (DM-10) */
  renderToolbarMenu(t, cx) {
    if (!this.toolbarMenuOpen) return div();

    return h_flex()
      .id("docker-toolbar-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        this.toolbarMenuOpen = false;
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        this.toolbarMenuOpen = false;
        cx.notify();
      })
      .child(
        v_flex()
          .id("docker-toolbar-menu")
          .absolute()
          .right(8)
          .top(36)
          .w(180)
          .bg(toColor(t.popover))
          .border_1()
          .border_color(toColor(t.border))
          .rounded(6)
          .shadow_md()
          .p(4)
          .gap(2)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            h_flex()
              .h(24)
              .px(6)
              .rounded(4)
              .items_center()
              .gap(6)
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => {
                this.activeSection = "system";
                this.toolbarMenuOpen = false;
                cx.notify();
              })
              .child(svg("mods/docker-manager/icons/gauge.svg").size(12).text_color(toColor(t.muted)))
              .child(div().text_size(11).text_color(toColor(t.foreground)).child("System & Hygiene"))
          )
          .child(
            h_flex()
              .h(24)
              .px(6)
              .rounded(4)
              .items_center()
              .gap(6)
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => {
                exec("open", ["-a", "Docker"]);
                notify({ title: "Docker", body: "Opening Docker Desktop…" });
                this.toolbarMenuOpen = false;
                cx.notify();
              })
              .child(svg("mods/docker-manager/icons/docker.svg").size(12).text_color(toColor(t.muted)))
              .child(div().text_size(11).text_color(toColor(t.foreground)).child("Start Docker Desktop"))
          )
          .child(
            h_flex()
              .h(24)
              .px(6)
              .rounded(4)
              .items_center()
              .gap(6)
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => {
                const diag = `Engine: ${this.engineVersion}\nStatus: ${this.engineStatus}\nContainers: ${this.containersRaw.length}\nScope: ${this.scope}`;
                this.copyValue(diag, "Diagnostics", cx);
                this.toolbarMenuOpen = false;
                cx.notify();
              })
              .child(svg("mods/docker-manager/icons/copy.svg").size(12).text_color(toColor(t.muted)))
              .child(div().text_size(11).text_color(toColor(t.foreground)).child("Copy Diagnostics"))
          )
          .when(Boolean(this.lastErrorText), (el) =>
            el.child(
              h_flex()
                .h(24)
                .px(6)
                .rounded(4)
                .items_center()
                .gap(6)
                .hover((s) => s.bg(toColor(t.hover)))
                .on_click((_e, cx) => {
                  this.copyValue(this.lastErrorText, "Last Error", cx);
                  this.toolbarMenuOpen = false;
                  cx.notify();
                })
                .child(svg("mods/docker-manager/icons/warning.svg").size(12).text_color(toColor(t.blocked)))
                .child(div().text_size(11).text_color(toColor(t.blocked)).child("Copy Full Error"))
            )
          )
      );
  }

  /** Friendly empty state when Docker engine is unreachable (DM-15, Finding 4) */
  renderEngineUnavailable(t, cx) {
    const errMsg = (this.engineError || "Could not reach the Docker daemon.").trim();
    const clampedErr = errMsg.length > 240 ? errMsg.slice(0, 237) + "…" : errMsg;

    return v_flex()
      .flex_1()
      .min_h(0)
      .w_full()
      .overflow_hidden()
      .items_center()
      .justify_center()
      .p(24)
      .gap(12)
      .bg(toColor(t.surface))
      .child(
        svg("mods/docker-manager/icons/docker.svg")
          .size(48)
          .text_color(toColor(t.dim))
      )
      .child(
        div()
          .text_size(15)
          .font_semibold()
          .text_color(toColor(t.foreground))
          .child("Docker is unavailable")
      )
      .child(
        div()
          .text_size(12)
          .text_color(toColor(t.muted))
          .child(clampedErr)
      )
      .child(
        h_flex()
          .gap(8)
          .mt(8)
          // Retry button
          .child(
            h_flex()
              .px(12)
              .h(28)
              .rounded(4)
              .bg(toColor(t.solid))
              .items_center()
              .text_size(11)
              .font_semibold()
              .text_color(toColor(t.solid_foreground))
              .hover((s) => s.opacity(0.9))
              .on_click((_e, cx) => this.refresh(cx, { rescan: true }))
              .child("Retry")
          )
          // Start Docker Desktop (macOS)
          .child(
            h_flex()
              .px(12)
              .h(28)
              .rounded(4)
              .bg(toColor(t.raised))
              .border_1()
              .border_color(toColor(t.border))
              .items_center()
              .text_size(11)
              .text_color(toColor(t.foreground))
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => {
                exec("open", ["-a", "Docker"]);
                notify({ title: "Starting Docker Desktop", body: "Launching Docker.app…" });
                cx.timer.after(4000, (cx) => this.refresh(cx, { rescan: true }));
              })
              .child("Start Docker Desktop")
          )
      );
  }

  /** Loads structured inspect data for container, image, volume, or network */
  loadInspectData(id, cx, kind = "container") {
    if (!id) return;
    this.inspectLoading = true;
    this.inspectLoadKey = `${kind}:${id}`;
    this.inspectError = null;
    cx.notify();

    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    cx.spawn(async (cx) => {
      try {
        if (kind === "image") {
          const [inspRes, histRes] = await Promise.all([
            exec("docker", ["image", "inspect", "--format", "{{json .}}", id], { on: ctx.on, timeout: 5000 }),
            exec("docker", buildImageHistoryArgs(id), { on: ctx.on, timeout: 5000 }),
          ]);
          if ((inspRes.code ?? inspRes.exitCode) === 0) {
            const raw = JSON.parse(inspRes.stdout.trim());
            let historyRows = [];
            if ((histRes.code ?? histRes.exitCode) === 0) {
              historyRows = histRes.stdout
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .map((l) => {
                  try {
                    return JSON.parse(l);
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean);
            }
            this.inspectDataRaw = raw;
            this.inspectData = normalizeImageInspect(raw, historyRows);
            if (this.inspectData) {
              this.inspectData.id = id;
              this.inspectData.kind = "image";
            }
          } else {
            this.inspectDataRaw = null;
            this.inspectData = null;
          }
        } else if (kind === "volume") {
          const res = await exec("docker", ["volume", "inspect", "--format", "{{json .}}", id], {
            on: ctx.on,
            timeout: 5000,
          });
          if ((res.code ?? res.exitCode) === 0) {
            const raw = JSON.parse(res.stdout.trim());
            this.inspectDataRaw = raw;
            this.inspectData = normalizeVolumeInspect(raw);
            if (this.inspectData) {
              this.inspectData.id = id;
              this.inspectData.kind = "volume";
            }
          } else {
            this.inspectDataRaw = null;
            this.inspectData = null;
          }
        } else if (kind === "network") {
          const res = await exec("docker", ["network", "inspect", "--format", "{{json .}}", id], {
            on: ctx.on,
            timeout: 5000,
          });
          if ((res.code ?? res.exitCode) === 0) {
            const raw = JSON.parse(res.stdout.trim());
            this.inspectDataRaw = raw;
            this.inspectData = normalizeNetworkInspect(raw);
            if (this.inspectData) {
              this.inspectData.id = id;
              this.inspectData.kind = "network";
            }
          } else {
            this.inspectDataRaw = null;
            this.inspectData = null;
          }
        } else {
          // container
          const res = await exec("docker", ["inspect", "--format", "{{json .}}", id], {
            on: ctx.on,
            timeout: 5000,
          });
          if ((res.code ?? res.exitCode) === 0) {
            const raw = JSON.parse(res.stdout.trim());
            this.inspectDataRaw = raw;
            this.inspectData = normalizeContainerInspect(raw);
            if (this.inspectData) {
              this.inspectData.id = id;
              this.inspectData.kind = "container";
            }
          } else {
            this.inspectDataRaw = null;
            this.inspectData = null;
            this.inspectError = `docker inspect failed (exit ${res.code}): ${String(res.stderr || "").trim().slice(0, 300)}`;
          }
        }
      } catch (err) {
        this.inspectDataRaw = null;
        this.inspectData = null;
        this.inspectError = String(err && err.message ? err.message : err);
      } finally {
        this.inspectLoading = false;
        // A load that produced nothing must stay retryable: the init-time load can run before
        // the app can exec, and the tab timer then retries it a bounded number of times.
        if (!this.inspectData) {
          this.inspectLoadKey = null;
          this.inspectRetries = (this.inspectRetries || 0) + 1;
        } else {
          this.inspectRetries = 0;
        }
        cx.notify();
      }
    });
  }

  /** Re-resolves the inspector target off the render path (tab timer): follows a Compose
   *  service across recreation and loads a target that was not ready at init. */
  ensureInspectorTarget(cx) {
    // No hard stop: a Docker Desktop cold start takes 20-40 s, which used to exhaust the budget
    // and blank the tab permanently. Back off instead (1 s, 2 s, 4 s, then every 8 s).
    const attempts = this.inspectRetries || 0;
    const now = Date.now();
    if (attempts > 0 && now < (this.inspectNextAttempt || 0)) return;
    const p = props();
    const kind = p?.inspect?.kind || "container";
    let targetId = p?.inspect?.id || p?.inspect?.name;
    if (kind === "container" && p?.inspect?.project && p?.inspect?.service) {
      targetId = resolveServiceContainerId(
        this.containersRaw,
        p.inspect.project,
        p.inspect.service,
        targetId
      );
    }
    if (!targetId) return;
    const loadKey = `${kind}:${targetId}`;
    // A different target starts a fresh attempt budget.
    if (this.inspectTargetKey !== loadKey) {
      this.inspectTargetKey = loadKey;
      this.inspectRetries = 0;
      this.inspectNextAttempt = 0;
    }
    if (this.inspectLoadKey === loadKey || this.inspectLoading) return;
    this.inspectNextAttempt = now + Math.min(8000, 1000 * Math.pow(2, Math.max(0, attempts - 1)));
    this.loadInspectData(targetId, cx, kind);
  }

  /** Inspector Tab Mode (full-page inspection tab, DM-44..46) */
  renderInspectorTab(t, cx) {
    const p = props();
    const kind = p?.inspect?.kind || "container";
    let targetId = p?.inspect?.id || p?.inspect?.name;

    if (kind === "container" && p?.inspect?.project && p?.inspect?.service) {
      targetId = resolveServiceContainerId(
        this.containersRaw,
        p.inspect.project,
        p.inspect.service,
        targetId
      );
    }

    const targetTitle = p?.inspect?.service
      ? `${p.inspect.project} / ${p.inspect.service}`
      : (p?.inspect?.name || targetId?.slice(0, 12) || "Target");

    const ctx = resolveDockerContext({
      props: props(),
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    const isRunning = Boolean(this.inspectData?.state?.running);
    const isService = Boolean(p?.inspect?.project && p?.inspect?.service);
    // Use Herdr's standard split target: the New pane chooser (terminal or
    // any installed agent), not a second inspector. Without new-pane, the
    // split opens a terminal as usual.
    const splitInspector = (direction) => {
      const props = {
        direction,
        ...(focused()?.space ? { space: focused().space } : {}),
        ...(ctx.cwd ? { folder: ctx.cwd } : {}),
      };
      run("pane.split", {
        direction,
        ...(paneId ? { pane: paneId } : {}),
        ...(this.newPaneInstalled ? { mod: "new-pane", props } : {}),
      });
    };
    const focusedPaneInfo = panes().find((candidate) => candidate.pane === focused()?.pane);
    const paneId = p?.pane || (focusedPaneInfo?.mod === "docker-manager" ? focusedPaneInfo.pane : null);
    const paneInfo = panes().find((candidate) => candidate.pane === paneId);
    let subViews;
    if (kind === "image") {
      subViews = [
        { id: "overview", label: "Overview" },
        { id: "history", label: "History & Layers" },
        { id: "labels", label: "Labels" },
        { id: "raw", label: "Raw JSON" },
      ];
    } else if (kind === "volume") {
      subViews = [
        { id: "overview", label: "Overview" },
        { id: "labels", label: "Labels" },
        { id: "raw", label: "Raw JSON" },
      ];
    } else if (kind === "network") {
      subViews = [
        { id: "overview", label: "Overview" },
        { id: "connected", label: "Connected Containers" },
        { id: "labels", label: "Labels" },
        { id: "raw", label: "Raw JSON" },
      ];
    } else {
      subViews = [
        { id: "overview", label: "Overview" },
        { id: "env", label: "Environment" },
        { id: "mounts", label: "Mounts" },
        { id: "network", label: "Network" },
        { id: "labels", label: "Labels" },
        { id: "stats", label: "Stats" },
        { id: "raw", label: "Raw JSON" },
      ];
    }

    if (!subViews.some((sv) => sv.id === this.inspectTabSubView)) {
      this.inspectTabSubView = "overview";
    }

    const iconPath =
      kind === "image"
        ? "mods/docker-manager/icons/layers.svg"
        : kind === "volume"
        ? "mods/docker-manager/icons/volume.svg"
        : kind === "network"
        ? "mods/docker-manager/icons/network.svg"
        : "mods/docker-manager/icons/container.svg";

    return v_flex()
      .size_full()
      .relative()
      .bg(toColor(t.background))
      // Full tab header bar with lifecycle actions (DM-46)
      .child(
        h_flex()
          .min_h(40)
          .w_full()
          .px(12)
          .py(4)
          .items_center()
          .justify_between()
          .flex_wrap()
          .bg(toColor(t.chrome))
          .border_b(1)
          .border_color(toColor(t.border))
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .child(svg(iconPath).size(16).text_color(toColor(t.accent)))
              .child(
                div()
                  .text_size(13)
                  .font_semibold()
                  .text_color(toColor(t.foreground))
                  .child(`Inspect ${kind.charAt(0).toUpperCase() + kind.slice(1)}: ${targetTitle}`)
              )
              .when(Boolean(targetId), (el) =>
                el.child(
                  div()
                    .text_size(10)
                    .px(6)
                    .py(1)
                    .rounded(2)
                    .bg(toColor(t.raised))
                    .text_color(toColor(t.muted))
                    .child(targetId.slice(0, 12))
                )
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .flex_wrap()
              // --- CONTAINER ACTIONS ---
              .when(kind === "container" && !isRunning && Boolean(targetId), (btn) =>
                btn.child(
                  h_flex()
                    .px(8)
                    .h(24)
                    .rounded(3)
                    .bg(toColor(t.raised))
                    .border_1()
                    .border_color(toColor(t.border))
                    .items_center()
                    .gap(4)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => {
                      this.runDockerCmd(`ctr:${targetId}`, "Start container", ["start", targetId], ctx, cx);
                    })
                    .child(svg("mods/docker-manager/icons/play.svg").size(11).text_color(toColor(t.done)))
                    .child(div().text_size(11).text_color(toColor(t.foreground)).child("Start"))
                )
              )
              .when(kind === "container" && isRunning && Boolean(targetId), (btn) =>
                btn.child(
                  h_flex()
                    .px(8)
                    .h(24)
                    .rounded(3)
                    .bg(toColor(t.raised))
                    .border_1()
                    .border_color(toColor(t.border))
                    .items_center()
                    .gap(4)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => {
                      this.runDockerCmd(`ctr:${targetId}`, "Stop container", ["stop", targetId], ctx, cx);
                    })
                    .child(svg("mods/docker-manager/icons/stop.svg").size(11).text_color(toColor(t.working)))
                    .child(div().text_size(11).text_color(toColor(t.foreground)).child("Stop"))
                )
              )
              .when(kind === "container" && Boolean(targetId), (btn) =>
                btn.child(
                  h_flex()
                    .px(8)
                    .h(24)
                    .rounded(3)
                    .bg(toColor(t.raised))
                    .border_1()
                    .border_color(toColor(t.border))
                    .items_center()
                    .gap(4)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => {
                      this.runDockerCmd(`ctr:${targetId}`, "Restart container", ["restart", targetId], ctx, cx);
                    })
                    .child(svg("mods/docker-manager/icons/restart.svg").size(11).text_color(toColor(t.muted)))
                    .child(div().text_size(11).text_color(toColor(t.foreground)).child("Restart"))
                )
              )
              .when(kind === "container" && isService, (btn) =>
                btn.child(
                  h_flex()
                    .px(8)
                    .h(24)
                    .rounded(3)
                    .bg(toColor(t.raised))
                    .border_1()
                    .border_color(toColor(t.border))
                    .items_center()
                    .gap(4)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => {
                      const proj = this.projectByName?.get(p.inspect.project);
                      const argv = buildComposeRebuildArgs(
                        {
                          project: p.inspect.project,
                          configFiles: p.inspect.configFiles || proj?.configFiles || [],
                          workingDir: p.inspect.workingDir || proj?.workingDirs?.[0] || null,
                        },
                        p.inspect.service
                      );
                      this.runDockerCmd(`svc:${p.inspect.project}:${p.inspect.service}`, `Rebuilding ${p.inspect.service}`, argv, ctx, cx);
                    })
                    .child(svg("mods/docker-manager/icons/rebuild.svg").size(11).text_color(toColor(t.accent)))
                    .child(div().text_size(11).text_color(toColor(t.foreground)).child("Rebuild"))
                )
              )
              .when(kind === "container" && Boolean(targetId), (btn) =>
                btn.child(
                  h_flex()
                    .px(8)
                    .h(24)
                    .rounded(3)
                    .bg(toColor(t.raised))
                    .border_1()
                    .border_color(toColor(t.border))
                    .items_center()
                    .gap(4)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, _cx) => {
                      this.openLogs({ id: targetId, name: p?.inspect?.service || targetTitle });
                    })
                    .child(svg("mods/docker-manager/icons/logs.svg").size(11).text_color(toColor(t.muted)))
                    .child(div().text_size(11).text_color(toColor(t.foreground)).child("Logs"))
                )
              )
              .when(kind === "container" && isRunning && Boolean(targetId), (btn) =>
                btn.child(
                  h_flex()
                    .px(8)
                    .h(24)
                    .rounded(3)
                    .bg(toColor(t.raised))
                    .border_1()
                    .border_color(toColor(t.border))
                    .items_center()
                    .gap(4)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => {
                      this.openShell(targetId, p?.inspect?.service || targetTitle, false, cx);
                    })
                    .child(svg("mods/docker-manager/icons/terminal.svg").size(11).text_color(toColor(t.muted)))
                    .child(div().text_size(11).text_color(toColor(t.foreground)).child("Shell"))
                )
              )
              // --- IMAGE ACTIONS ---
              .when(kind === "image", (btn) =>
                btn
                  .child(
                    h_flex()
                      .px(8)
                      .h(24)
                      .rounded(3)
                      .bg(toColor(t.raised))
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .gap(4)
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, cx) => {
                        this.openImageModal(this.inspectData || { id: targetId, name: p?.inspect?.name || targetId }, "run-image", cx);
                      })
                      .child(svg("mods/docker-manager/icons/play.svg").size(11).text_color(toColor(t.done)))
                      .child(div().text_size(11).text_color(toColor(t.foreground)).child("Run…"))
                  )
                  .child(
                    h_flex()
                      .px(8)
                      .h(24)
                      .rounded(3)
                      .bg(toColor(t.raised))
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .gap(4)
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, cx) => {
                        this.openImageModal(this.inspectData || { id: targetId, name: p?.inspect?.name || targetId }, "tag-image", cx);
                      })
                      .child(div().text_size(11).text_color(toColor(t.foreground)).child("Tag…"))
                  )
                  .child(
                    h_flex()
                      .px(8)
                      .h(24)
                      .rounded(3)
                      .bg(toColor(t.raised))
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .gap(4)
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, _cx) => {
                        const name = p?.inspect?.name || targetId;
                        run("terminal.open", { name: `pull: ${name}`, argv: ["docker", "pull", name] });
                      })
                      .child(div().text_size(11).text_color(toColor(t.foreground)).child("Pull again"))
                  )
              )
              // --- VOLUME ACTIONS ---
              .when(kind === "volume", (btn) =>
                btn
                  .child(
                    h_flex()
                      .px(8)
                      .h(24)
                      .rounded(3)
                      .bg(toColor(t.raised))
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .gap(4)
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, _cx) => {
                        run("terminal.open", {
                          name: `browse: ${targetId}`,
                          argv: buildVolumeBrowseArgs(targetId),
                        });
                      })
                      .child(svg("mods/docker-manager/icons/terminal.svg").size(11).text_color(toColor(t.muted)))
                      .child(div().text_size(11).text_color(toColor(t.foreground)).child("Browse"))
                  )
                  .child(
                    h_flex()
                      .px(8)
                      .h(24)
                      .rounded(3)
                      .bg(toColor(t.raised))
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .gap(4)
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, cx) => {
                        this.openVolumeModal(this.inspectData || { name: targetId }, "backup", cx);
                      })
                      .child(div().text_size(11).text_color(toColor(t.foreground)).child("Backup…"))
                  )
                  .child(
                    h_flex()
                      .px(8)
                      .h(24)
                      .rounded(3)
                      .bg(toColor(t.raised))
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .gap(4)
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, cx) => {
                        this.openVolumeModal(this.inspectData || { name: targetId }, "restore", cx);
                      })
                      .child(div().text_size(11).text_color(toColor(t.foreground)).child("Restore…"))
                  )
                  .child(
                    h_flex()
                      .px(8)
                      .h(24)
                      .rounded(3)
                      .bg(toColor(t.raised))
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .gap(4)
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, cx) => {
                        this.openVolumeModal(this.inspectData || { name: targetId }, "clone", cx);
                      })
                      .child(div().text_size(11).text_color(toColor(t.foreground)).child("Clone…"))
                  )
              )
              // --- GENERAL COPY & REFRESH ---
              .when(Boolean(targetId), (btn) =>
                btn.child(
                  h_flex()
                    .px(8)
                    .h(24)
                    .rounded(3)
                    .bg(toColor(t.raised))
                    .border_1()
                    .border_color(toColor(t.border))
                    .items_center()
                    .gap(4)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => {
                      this.copyValue(targetId, `${kind.toUpperCase()} ID/Name`, cx);
                    })
                    .child(svg("mods/docker-manager/icons/copy.svg").size(11).text_color(toColor(t.muted)))
                    .child(div().text_size(11).text_color(toColor(t.foreground)).child("Copy ID"))
                )
              )
              .child(
                h_flex()
                  .size(24)
                  .rounded(4)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    if (targetId) this.loadInspectData(targetId, cx, kind);
                    this.refresh(cx);
                  })
                  .child(
                    svg("mods/docker-manager/icons/refresh.svg")
                      .size(13)
                      .text_color(toColor(this.refreshing ? t.accent : t.muted))
                      .when(this.refreshing, (el) => el.spin(900))
                  )
              )
              // Pane controls; split duplicates the inspector pane (same tab).
              .child(
                h_flex()
                  .size(24)
                  .rounded(4)
                  .items_center()
                  .justify_center()
                  .tooltip("Split right")
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e) => splitInspector("right"))
                  .child(svg("mods/docker-manager/icons/split-right.svg").size(13).text_color(toColor(t.muted)))
              )
              .child(
                h_flex()
                  .size(24)
                  .rounded(4)
                  .items_center()
                  .justify_center()
                  .tooltip("Split down")
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e) => splitInspector("down"))
                  .child(svg("mods/docker-manager/icons/split-down.svg").size(13).text_color(toColor(t.muted)))
              )
              .when(Boolean(paneId), (btn) => {
                const paneButton = (icon, tip, action) =>
                  h_flex()
                    .size(24)
                    .rounded(4)
                    .items_center()
                    .justify_center()
                    .tooltip(tip)
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e) => action())
                    .child(svg(`mods/docker-manager/icons/${icon}`).size(13).text_color(toColor(t.muted)));
                return btn
                  .child(div().w(1).h(16).mx(2).bg(toColor(t.border)))
                  .child(
                    paneButton(paneInfo?.zoomed ? "unzoom.svg" : "zoom.svg", paneInfo?.zoomed ? "Unzoom" : "Zoom", () =>
                      run("pane.zoom", { pane: paneId })
                    )
                  )
                  .child(paneButton("close.svg", "Close pane", () => run("pane.close", { pane: paneId })));
              })
          )
      )
      // Sub-view switcher bar
      .child(
        h_flex()
          .h(32)
          .w_full()
          .px(10)
          .items_center()
          .gap(4)
          .bg(toColor(t.surface))
          .border_b(1)
          .border_color(toColor(t.border))
          .children(
            subViews.map((sv) => {
              const active = this.inspectTabSubView === sv.id;
              return div()
                .h(24)
                .px(8)
                .rounded(4)
                .items_center()
                .text_size(11)
                .when(active, (el) =>
                  el.bg(toColor(t.raised)).text_color(toColor(t.accent)).font_semibold()
                )
                .when(!active, (el) =>
                  el.text_color(toColor(t.muted)).hover((s) => s.bg(toColor(t.hover)).text_color(toColor(t.foreground)))
                )
                .on_click((_e, cx) => {
                  this.inspectTabSubView = sv.id;
                  const cid = targetId || this.inspectData?.id || p?.inspect?.id;
                  if (sv.id === "stats" && kind === "container" && cid) this.pollStats(cid, cx);
                  cx.notify();
                })
                .child(sv.label);
            })
          )
      )
      // Sub-view body
      .child(
        v_flex()
          .flex_1()
          .p(16)
          .overflow_y_scrollbar()
          .when(this.inspectLoading, (el) =>
            el
              .items_center()
              .justify_center()
              .child(
                svg("mods/docker-manager/icons/spinner.svg")
                  .size(24)
                  .text_color(toColor(t.accent))
                  .spin(900)
              )
          )
          .when(!this.inspectLoading, (el) => this.renderInspectSubView(kind, targetId, t, cx, el))
      )
      // The inspector tab has its own root, so the panel-mode dialog overlays
      // must be mounted here too; otherwise Run/Tag/Backup/Restore/Clone set
      // state but no modal is ever drawn.
      .when(Boolean(this.imageDialog), (el) => el.child(this.renderImageDialog(t, cx)))
      .when(Boolean(this.volumeDialog), (el) => el.child(this.renderVolumeDialog(t, cx)));
  }

  renderInspectSubView(kind, targetId, t, cx, el) {
    const data = this.inspectData;
    if (!data) {
      const errText = this.inspectError ? String(this.inspectError) : "";
      return el
        .items_center()
        .justify_center()
        .child(div().text_size(12).text_color(toColor(t.dim)).child("No inspect data available."))
        .when(Boolean(errText), (e) =>
          e.child(div().mt(6).px(16).text_size(11).text_color(toColor(t.blocked)).child(errText))
        );
    }

    // 1. Raw JSON sub-view (common to all kinds)
    if (this.inspectTabSubView === "raw") {
      const rawJson = JSON.stringify(this.inspectDataRaw || data || {}, null, 2);
      return el
        .gap(8)
        .child(
          h_flex()
            .justify_end()
            .child(
              h_flex()
                .px(8)
                .h(22)
                .rounded(3)
                .bg(toColor(t.raised))
                .items_center()
                .gap(4)
                .text_size(10)
                .text_color(toColor(t.foreground))
                .hover((s) => s.bg(toColor(t.hover)))
                .on_click((_e, cx) => {
                  this.copyValue(rawJson, "Inspect JSON", cx);
                })
                .child(svg("mods/docker-manager/icons/copy.svg").size(10).text_color(toColor(t.muted)))
                .child("Copy JSON")
            )
        )
        .child(
          div()
            .p(10)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .text_size(11)
            .text_color(toColor(t.foreground))
            .child(rawJson)
        );
    }

    // 2. Labels sub-view (common to all kinds)
    if (this.inspectTabSubView === "labels") {
      const labelsObj = data.labels || data.config?.labels || {};
      const labelEntries = Object.entries(labelsObj).sort(([a], [b]) => a.localeCompare(b));
      if (labelEntries.length === 0) {
        return el.child(div().text_size(12).text_color(toColor(t.dim)).child("No labels attached."));
      }
      return el.gap(4).children(
        labelEntries.map(([k, v]) =>
          h_flex()
            .h(28)
            .w_full()
            .px(8)
            .items_center()
            .justify_between()
            .border_b(1)
            .border_color(toColor(t.border))
            .hover((s) => s.bg(toColor(t.hover)))
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().font_semibold().text_size(11).text_color(toColor(t.foreground)).child(k))
                .child(
                  h_flex()
                    .size(16)
                    .rounded(2)
                    .items_center()
                    .justify_center()
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => this.copyValue(k, "Label Key", cx))
                    .child(svg("mods/docker-manager/icons/copy.svg").size(10).text_color(toColor(t.muted)))
                )
            )
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(11).text_color(toColor(t.dim)).child(v))
                .child(
                  h_flex()
                    .size(16)
                    .rounded(2)
                    .items_center()
                    .justify_center()
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_e, cx) => this.copyValue(v, "Label Value", cx))
                    .child(svg("mods/docker-manager/icons/copy.svg").size(10).text_color(toColor(t.muted)))
                )
            )
        )
      );
    }

    // 3. Kind-specific sub-views
    if (kind === "image") {
      if (this.inspectTabSubView === "history") {
        const historyRows = data.history || [];
        if (historyRows.length === 0) {
          return el.child(div().text_size(12).text_color(toColor(t.dim)).child("No history layers available."));
        }
        return el.gap(6).children(
          historyRows.map((h, idx) =>
            v_flex()
              .p(8)
              .rounded(6)
              .bg(toColor(t.surface))
              .border_1()
              .border_color(toColor(t.border))
              .gap(4)
              .child(
                h_flex()
                  .justify_between()
                  .items_center()
                  .child(div().text_size(11).font_semibold().text_color(toColor(t.accent)).child(`Layer ${idx + 1}`))
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.foreground)).child(h.Size || h.size || "0B"))
              )
              .child(div().text_size(11).text_color(toColor(t.foreground)).child(h.CreatedBy || h.createdBy || "N/A"))
              .when(Boolean(h.CreatedSince || h.created), (r) =>
                r.child(div().text_size(10).text_color(toColor(t.dim)).child(h.CreatedSince || h.created))
              )
          )
        );
      }

      // Image Overview
      return el
        .gap(12)
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Image Details"))
            .child(this.renderDrawerRow("Image ID", data.id || data.shortId, t, cx, true))
            .child(this.renderDrawerRow("Repo Tags", (data.repoTags || []).join(", ") || "<none>", t, cx, true))
            .child(this.renderDrawerRow("Size", data.size || "0B", t, cx))
            .child(this.renderDrawerRow("Created", data.created || "", t, cx))
            .child(this.renderDrawerRow("OS / Arch", `${data.os || ""} / ${data.architecture || ""}`, t, cx))
            .child(this.renderDrawerRow("Docker Version", data.dockerVersion || "N/A", t, cx))
            .child(this.renderDrawerRow("Author", data.author || "N/A", t, cx))
        )
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Execution Config"))
            .child(this.renderDrawerRow("Exposed Ports", (data.config?.exposedPorts || []).join(", ") || "None", t, cx))
            .child(this.renderDrawerRow("CMD", (data.config?.cmd || []).join(" ") || "None", t, cx, true))
            .child(this.renderDrawerRow("Entrypoint", (data.config?.entrypoint || []).join(" ") || "None", t, cx, true))
            .child(this.renderDrawerRow("Working Dir", data.config?.workingDir || "/", t, cx, true))
        );
    }

    if (kind === "volume") {
      const usingCtrs = data.usingContainers || [];
      return el
        .gap(12)
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Volume Details"))
            .child(this.renderDrawerRow("Volume Name", data.name, t, cx, true))
            .child(this.renderDrawerRow("Driver", data.driver || "local", t, cx))
            .child(this.renderDrawerRow("Mountpoint", data.mountpoint || "", t, cx, true))
            .child(this.renderDrawerRow("Size", data.size || "Not computed", t, cx))
            .child(this.renderDrawerRow("Created", data.createdAt || "", t, cx))
            .child(this.renderDrawerRow("Scope", data.scope || "local", t, cx))
        )
        .when(usingCtrs.length > 0, (cCard) =>
          cCard.child(
            v_flex()
              .p(12)
              .rounded(6)
              .bg(toColor(t.surface))
              .border_1()
              .border_color(toColor(t.border))
              .gap(8)
              .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Attached Containers"))
              .child(
                h_flex()
                  .gap(6)
                  .flex_wrap()
                  .children(
                    usingCtrs.map((c) =>
                      div()
                        .px(8)
                        .py(3)
                        .rounded(4)
                        .bg(toColor(t.raised))
                        .text_size(11)
                        .text_color(toColor(t.accent))
                        .hover((s) => s.underline())
                        .on_click((_e, cx) => {
                          run("tab.new", {
                            name: `Inspect: ${c.name || c.id}`,
                            mod: "docker-manager",
                            props: { inspect: { kind: "container", id: c.id } },
                          });
                        })
                        .child(c.name || c.id)
                    )
                  )
              )
          )
        );
    }

    if (kind === "network") {
      if (this.inspectTabSubView === "connected") {
        const containers = data.containers || [];
        if (containers.length === 0) {
          return el.child(div().text_size(12).text_color(toColor(t.dim)).child("No containers connected to this network."));
        }
        return el.gap(6).children(
          containers.map((c) =>
            h_flex()
              .h(30)
              .w_full()
              .px(8)
              .items_center()
              .justify_between()
              .border_b(1)
              .border_color(toColor(t.border))
              .hover((s) => s.bg(toColor(t.hover)))
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(
                    div()
                      .font_semibold()
                      .text_size(11)
                      .text_color(toColor(t.accent))
                      .hover((s) => s.underline())
                      .on_click((_e, _cx) => {
                        run("tab.new", {
                          name: `Inspect: ${c.name || c.id}`,
                          mod: "docker-manager",
                          props: { inspect: { kind: "container", id: c.id } },
                        });
                      })
                      .child(c.name || c.shortId)
                  )
                  .child(div().text_size(10).text_color(toColor(t.dim)).child(c.shortId))
              )
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(div().text_size(11).text_color(toColor(t.foreground)).child(c.ipv4 || "No IPv4"))
                  .child(div().text_size(10).text_color(toColor(t.dim)).child(c.mac || ""))
              )
          )
        );
      }

      // Network Overview
      return el
        .gap(12)
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Network Details"))
            .child(this.renderDrawerRow("Network Name", data.name, t, cx, true))
            .child(this.renderDrawerRow("Network ID", data.id || data.shortId, t, cx, true))
            .child(this.renderDrawerRow("Driver", data.driver || "bridge", t, cx))
            .child(this.renderDrawerRow("Scope", data.scope || "local", t, cx))
            .child(this.renderDrawerRow("Internal", data.internal ? "Yes" : "No", t, cx))
            .child(this.renderDrawerRow("Connected Containers", String(data.containers?.length || 0), t, cx))
        )
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("IPAM Configuration"))
            .child(this.renderDrawerRow("IPAM Driver", data.ipam?.driver || "default", t, cx))
            .child(this.renderDrawerRow("Subnet", data.ipam?.subnet || "N/A", t, cx))
            .child(this.renderDrawerRow("Gateway", data.ipam?.gateway || "N/A", t, cx))
        );
    }

    // Default container sub-views
    if (this.inspectTabSubView === "overview") {
      return el
        .gap(12)
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("State"))
            .child(this.renderDrawerRow("Status", `${data.state.status}${data.health?.status ? ` (${data.health.status})` : ""}`, t, cx))
            .child(this.renderDrawerRow("Exit Code", String(data.state.exitCode ?? 0), t, cx))
            .when(Boolean(data.state.error), (r) => r.child(this.renderDrawerRow("Error", data.state.error, t, cx)))
            .child(this.renderDrawerRow("Started", data.startedAt || "N/A", t, cx))
            .child(this.renderDrawerRow("Finished", data.finishedAt || "N/A", t, cx))
        )
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Image"))
            .child(this.renderDrawerRow("Image Tag", data.image, t, cx, true))
            .child(this.renderDrawerRow("Image ID", data.imageId, t, cx, true))
        )
        .when(Boolean(data.ports && data.ports.length > 0), (pEl) =>
          pEl.child(
            v_flex()
              .p(12)
              .rounded(6)
              .bg(toColor(t.surface))
              .border_1()
              .border_color(toColor(t.border))
              .gap(8)
              .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Published Ports"))
              .children(
                data.ports.map((pt) =>
                  h_flex()
                    .gap(8)
                    .items_center()
                    .text_size(11)
                    .when(Boolean(pt.hostPort), (l) =>
                      l
                        .child(
                          div()
                            .text_color(toColor(t.accent))
                            .hover((s) => s.underline())
                            .on_click((_e, cx) => {
                              const url = `http://localhost:${pt.hostPort}`;
                              if (cx?.open_url) cx.open_url(url);
                              else exec("open", [url]);
                            })
                            .child(`http://localhost:${pt.hostPort}`)
                        )
                        .child(div().text_color(toColor(t.dim)).child("→"))
                    )
                    .child(div().text_color(toColor(t.foreground)).child(`${pt.containerPort}/${pt.proto}`))
                )
              )
          )
        )
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(8)
            .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child("Command & Execution"))
            .child(this.renderDrawerRow("Command", data.cmd || "None", t, cx, true))
            .child(this.renderDrawerRow("Entrypoint", data.entrypoint || "None", t, cx, true))
            .child(this.renderDrawerRow("Working Dir", data.workingDir || "/", t, cx, true))
            .child(this.renderDrawerRow("Restart Policy", data.restartPolicy?.name || "no", t, cx))
        );
    }

    if (this.inspectTabSubView === "env") {
      const envList = [...(data.env || [])].sort((a, b) => a.key.localeCompare(b.key));
      if (envList.length === 0) {
        return el.child(div().text_size(12).text_color(toColor(t.dim)).child("No environment variables defined."));
      }
      return el.gap(4).children(
        envList.map((e) => {
          const isRevealed = this.revealedSecrets.has(e.key);
          const displayVal = e.secret && !isRevealed ? "••••••••••••" : e.value;
          return h_flex()
            .h(28)
            .w_full()
            .px(8)
            .items_center()
            .justify_between()
            .border_b(1)
            .border_color(toColor(t.border))
            .hover((s) => s.bg(toColor(t.hover)))
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().font_semibold().text_size(11).text_color(toColor(t.foreground)).child(e.key))
                .child(
                  h_flex()
                    .size(16)
                    .rounded(2)
                    .items_center()
                    .justify_center()
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_evt, cx) => {
                      this.copyValue(e.key, "Key", cx);
                    })
                    .child(svg("mods/docker-manager/icons/copy.svg").size(10).text_color(toColor(t.muted)))
                )
            )
            .child(
              h_flex()
                .items_center()
                .gap(6)
                .child(
                  div()
                    .text_size(11)
                    .text_color(toColor(e.secret ? t.working : t.foreground))
                    .child(displayVal)
                )
                .when(e.secret, (btn) =>
                  btn.child(
                    h_flex()
                      .size(18)
                      .items_center()
                      .justify_center()
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_evt, cx) => {
                        if (this.revealedSecrets.has(e.key)) {
                          this.revealedSecrets.delete(e.key);
                        } else {
                          this.revealedSecrets.add(e.key);
                        }
                        cx.notify();
                      })
                      .child(
                        svg(
                          isRevealed
                            ? "mods/docker-manager/icons/eye-off.svg"
                            : "mods/docker-manager/icons/eye.svg"
                        )
                          .size(12)
                          .text_color(toColor(t.muted))
                      )
                  )
                )
                .child(
                  h_flex()
                    .size(16)
                    .rounded(2)
                    .items_center()
                    .justify_center()
                    .hover((s) => s.bg(toColor(t.hover)))
                    .on_click((_evt, cx) => {
                      this.copyValue(e.value, "Value", cx);
                    })
                    .child(svg("mods/docker-manager/icons/copy.svg").size(10).text_color(toColor(t.muted)))
                )
            );
        })
      );
    }

    if (this.inspectTabSubView === "mounts") {
      const mounts = data.mounts || [];
      if (mounts.length === 0) {
        return el.child(div().text_size(12).text_color(toColor(t.dim)).child("No mounts attached."));
      }
      return el.gap(8).children(
        mounts.map((m) =>
          v_flex()
            .p(10)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(4)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(
                  div()
                    .text_size(11)
                    .font_semibold()
                    .text_color(toColor(t.accent))
                    .child(m.destination)
                )
                .child(
                  div()
                    .text_size(9)
                    .px(4)
                    .py(1)
                    .rounded(2)
                    .bg(toColor(t.raised))
                    .text_color(toColor(t.muted))
                    .child(`${m.type.toUpperCase()} • ${m.rw ? "RW" : "RO"}`)
                )
            )
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(10).text_color(toColor(t.muted)).child("Host Source:"))
                .child(div().text_size(11).text_color(toColor(t.foreground)).child(m.source || "(anonymous)"))
                .when(Boolean(m.source), (cBtn) =>
                  cBtn.child(
                    h_flex()
                      .size(16)
                      .rounded(2)
                      .items_center()
                      .justify_center()
                      .hover((s) => s.bg(toColor(t.hover)))
                      .on_click((_e, cx) => this.copyValue(m.source, "Mount Source", cx))
                      .child(svg("mods/docker-manager/icons/copy.svg").size(10).text_color(toColor(t.muted)))
                  )
                )
            )
        )
      );
    }

    if (this.inspectTabSubView === "network") {
      const networks = data.networks || [];
      if (networks.length === 0) {
        return el.child(div().text_size(12).text_color(toColor(t.dim)).child("No networks attached."));
      }
      return el.gap(8).children(
        networks.map((net) =>
          v_flex()
            .p(10)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(6)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(12).font_semibold().text_color(toColor(t.foreground)).child(net.name))
                .child(div().text_size(10).text_color(toColor(t.dim)).child(net.networkId || ""))
            )
            .child(this.renderDrawerRow("IP Address", net.ipAddress || "None", t, cx, true))
            .child(this.renderDrawerRow("Gateway", net.gateway || "None", t, cx, true))
            .child(this.renderDrawerRow("MAC", net.macAddress || "None", t, cx))
            .child(this.renderDrawerRow("Aliases", (net.aliases || []).join(", ") || "None", t, cx))
        )
      );
    }

    if (this.inspectTabSubView === "stats") {
      const stats = this.liveStats;
      return el
        .gap(10)
        .child(
          h_flex()
            .justify_between()
            .items_center()
            .child(div().text_size(11).text_color(toColor(t.dim)).child("Live container performance (via docker stats)"))
            .child(
              h_flex()
                .px(8)
                .h(22)
                .rounded(3)
                .bg(toColor(t.raised))
                .items_center()
                .text_size(10)
                .text_color(toColor(t.foreground))
                .hover((s) => s.bg(toColor(t.hover)))
                .on_click((_e, cx) => {
                  const cid = targetId || this.inspectData?.id || p?.inspect?.id;
                  if (cid) this.pollStats(cid, cx);
                })
                .child("Refresh Stats")
            )
        )
        .child(
          h_flex()
            .gap(8)
            .child(
              v_flex()
                .flex_1()
                .p(12)
                .rounded(6)
                .bg(toColor(t.surface))
                .border_1()
                .border_color(toColor(t.border))
                .child(div().text_size(10).text_color(toColor(t.muted)).child("CPU Usage"))
                .child(div().text_size(18).font_bold().text_color(toColor(t.foreground)).child(stats?.CPUPerc || "0.00%"))
            )
            .child(
              v_flex()
                .flex_1()
                .p(12)
                .rounded(6)
                .bg(toColor(t.surface))
                .border_1()
                .border_color(toColor(t.border))
                .child(div().text_size(10).text_color(toColor(t.muted)).child("Memory %"))
                .child(div().text_size(18).font_bold().text_color(toColor(t.foreground)).child(stats?.MemPerc || "0.00%"))
            )
        )
        .child(
          v_flex()
            .p(12)
            .rounded(6)
            .bg(toColor(t.surface))
            .border_1()
            .border_color(toColor(t.border))
            .gap(6)
            .child(this.renderDrawerRow("Memory Usage / Limit", stats?.MemUsage || "N/A", t, cx))
            .child(this.renderDrawerRow("Net I/O", stats?.NetIO || "N/A", t, cx))
            .child(this.renderDrawerRow("Block I/O", stats?.BlockIO || "N/A", t, cx))
            .child(this.renderDrawerRow("Processes (PIDs)", String(stats?.PIDs || 0), t, cx))
        );
    }

    return el;
  }

  renderDockerfileDialog(t, cx) {
    const dialog = this.dockerfileDialog;
    if (!dialog) return div();

    const isBuildRun = dialog.action === "build-run";
    const title = isBuildRun ? "Build & Run Container" : "Build Image";

    return h_flex()
      .id("docker-dockerfile-backdrop")
      .absolute()
      .inset_0()
      .bg(toColor(t.background + "aa"))
      .items_center()
      .justify_center()
      .p(16)
      .on_mouse_down("left", (_e, cx) => {
        this.dockerfileDialog = null;
        cx.notify();
      })
      .child(
        v_flex()
          .id("docker-dockerfile-dialog")
          .w(320)
          .max_w_full()
          .p(14)
          .bg(toColor(t.popover))
          .border_1()
          .border_color(toColor(t.border))
          .rounded(6)
          .shadow_md()
          .gap(10)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          // Header
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                div()
                  .text_size(13)
                  .font_semibold()
                  .text_color(toColor(t.foreground))
                  .child(title)
              )
              .child(
                h_flex()
                  .size(18)
                  .rounded(2)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.dockerfileDialog = null;
                    cx.notify();
                  })
                  .child(svg("mods/docker-manager/icons/close.svg").size(12).text_color(toColor(t.muted)))
              )
          )
          .child(
            div()
              .text_size(10)
              .text_color(toColor(t.dim))
              .child(dialog.relativePath || dialog.filePath)
          )
          // Tag input
          .child(
            v_flex()
              .gap(4)
              .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Image Tag"))
              .child(
                h_flex()
                  .h(26)
                  .px(6)
                  .rounded(4)
                  .bg(toColor(t.input))
                  .border_1()
                  .border_color(toColor(t.border))
                  .child(Input.new(this.dfTagInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
              )
          )
          // Extra inputs for Build & run
          .when(isBuildRun, (el) =>
            el
              .child(
                v_flex()
                  .gap(4)
                  .child(
                    div()
                      .text_size(10)
                      .font_semibold()
                      .text_color(toColor(t.muted))
                      .child("Container Name")
                  )
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.dfContainerNameInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                v_flex()
                  .gap(4)
                  .child(
                    div()
                      .text_size(10)
                      .font_semibold()
                      .text_color(toColor(t.muted))
                      .child("Published Ports (e.g. 4321:4321)")
                  )
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.dfPortsInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .hover((s) => s.opacity(0.9))
                  .on_click((_e, cx) => {
                    this.dfDetached = !this.dfDetached;
                    cx.notify();
                  })
                  .child(
                    div()
                      .size(14)
                      .rounded(2)
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .justify_center()
                      .when(this.dfDetached, (b) =>
                        b
                          .bg(toColor(t.accent))
                          .child(svg("mods/docker-manager/icons/check.svg").size(10).text_color(toColor(t.solid_foreground)))
                      )
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(toColor(t.foreground))
                      .child("Run in background (detached -d)")
                  )
              )
          )
          // Actions
          .child(
            h_flex()
              .justify_end()
              .gap(6)
              .mt(6)
              .child(
                h_flex()
                  .px(10)
                  .h(24)
                  .rounded(4)
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .text_size(11)
                  .text_color(toColor(t.foreground))
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.dockerfileDialog = null;
                    cx.notify();
                  })
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .px(12)
                  .h(24)
                  .rounded(4)
                  .bg(toColor(t.accent))
                  .items_center()
                  .text_size(11)
                  .font_semibold()
                  .text_color(toColor(t.solid_foreground))
                  .hover((s) => s.opacity(0.9))
                  .on_click((_e, cx) => this.submitDockerfileModal(cx))
                  .child(isBuildRun ? "Build & Run" : "Build")
              )
          )
      );
  }

  renderCheckbox(label, checked, onToggle, t, cx, subtitle = null) {
    return h_flex()
      .items_center()
      .justify_between()
      .py(4)
      .px(6)
      .rounded(4)
      .hover((s) => s.bg(toColor(t.hover)))
      .on_click((_e, cx) => onToggle(cx))
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(
            h_flex()
              .size(15)
              .rounded(3)
              .border_1()
              .border_color(toColor(checked ? t.accent : t.border))
              .items_center()
              .justify_center()
              .when(checked, (b) =>
                b
                  .bg(toColor(t.accent))
                  .child(svg("mods/docker-manager/icons/check.svg").size(10).text_color(toColor(t.solid_foreground)))
              )
              .when(!checked, (b) => b.bg(toColor(t.surface)))
          )
          .child(
            v_flex()
              .child(
                div()
                  .text_size(11)
                  .text_color(toColor(t.foreground))
                  .child(label)
              )
              .when(Boolean(subtitle), (sub) =>
                sub.child(
                  div()
                    .text_size(10)
                    .text_color(toColor(t.dim))
                    .child(subtitle)
                )
              )
          )
      );
  }

  renderDiskUsageCard(title, data, t, _cx) {
    const size = data?.size || "0B";
    const active = data?.activeCount ?? 0;
    const total = data?.totalCount ?? 0;
    const reclaimable = data?.reclaimable || "0B";

    return v_flex()
      .flex_1()
      .p(8)
      .rounded(6)
      .bg(toColor(t.surface))
      .border_1()
      .border_color(toColor(t.border))
      .gap(4)
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child(title))
          .when(total > 0, (el) =>
            el.child(div().text_size(9).text_color(toColor(t.dim)).child(`${active}/${total} active`))
          )
      )
      .child(div().text_size(14).font_bold().text_color(toColor(t.foreground)).child(size))
      .child(
        div()
          .text_size(9)
          .text_color(toColor(t.dim))
          .child(`Reclaimable: ${reclaimable}`)
      );
  }

  /** Single sort icon used by Images and Volumes. */
  renderSortButton(section, t, cx) {
    const open = this.sortMenuOpen === section;
    return h_flex()
      .h(22)
      .px(6)
      .rounded(3)
      .items_center()
      .tooltip(section === "images" ? "Sort images" : "Sort volumes")
      .when(open, (el) => el.bg(toColor(t.raised)).text_color(toColor(t.accent)))
      .when(!open, (el) =>
        el.text_color(toColor(t.muted)).hover((s) => s.bg(toColor(t.hover)).text_color(toColor(t.foreground)))
      )
      .on_click((_e, cx2) => {
        this.sortMenuOpen = open ? null : section;
        cx2.notify();
      })
      .child(svg("mods/docker-manager/icons/sort.svg").size(12));
  }

  /** Sort options for Images/Volumes, including the in-use-first toggle. */
  renderSortMenu(t, cx) {
    const section = this.sortMenuOpen;
    if (!section) return div();
    const isImages = section === "images";
    const sortBy = isImages ? this.imageSortBy : this.volumeSortBy;
    const inUseFirst = isImages ? this.imageInUseFirst : this.volumeInUseFirst;

    const pickSort = (by) => {
      if (isImages) this.imageSortBy = by;
      else this.volumeSortBy = by;
      this.sortMenuOpen = null;
    };
    const toggleInUse = () => {
      if (isImages) this.imageInUseFirst = !this.imageInUseFirst;
      else this.volumeInUseFirst = !this.volumeInUseFirst;
      this.sortMenuOpen = null;
    };
    const item = (label, active, onPick) =>
      h_flex()
        .h(24)
        .w_full()
        .px(8)
        .rounded(3)
        .items_center()
        .justify_between()
        .hover((s) => s.bg(toColor(t.hover)))
        .on_click((_e, cx2) => {
          onPick();
          cx2.notify();
        })
        .child(div().text_size(11).text_color(toColor(t.foreground)).child(label))
        .when(active, (el) => el.child(svg("mods/docker-manager/icons/check.svg").size(11).text_color(toColor(t.accent))));

    return h_flex()
      .id("docker-sort-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx2) => {
        this.sortMenuOpen = null;
        cx2.notify();
      })
      .on_mouse_down("right", (_e, cx2) => {
        this.sortMenuOpen = null;
        cx2.notify();
      })
      .child(
        v_flex()
          .id("docker-sort-menu")
          .absolute()
          .top(130)
          .right(8)
          .w(190)
          .p(4)
          .gap(1)
          .rounded(6)
          .bg(toColor(t.popover))
          .border_1()
          .border_color(toColor(t.border))
          .shadow_md()
          .on_mouse_down("left", (_e, cx2) => cx2.stop_propagation())
          .on_mouse_down("right", (_e, cx2) => cx2.stop_propagation())
          .child(div().px(8).py(4).text_size(10).text_color(toColor(t.dim)).child(isImages ? "Sort images" : "Sort volumes"))
          .child(item("Name", sortBy === "name", () => pickSort("name")))
          .child(item("Size", sortBy === "size", () => pickSort("size")))
          .child(item("Created", sortBy === "created", () => pickSort("created")))
          .child(div().my(2).h(1).bg(toColor(t.border)))
          .child(item("In use first", inUseFirst, toggleInUse))
      );
  }

  renderContainersSection(t, ctx, cx) {
    const tree = buildContainerTree({
      containers: this.containersRaw,
      composeLs: this.composeLsRaw,
      discoveredCompose: this.discoveredCompose,
      discoveredDockerfiles: this.discoveredDockerfiles,
      spaceRoot: ctx.cwd,
      scope: this.scope,
      filter: this.filterQuery,
    });

    const rows = this.flattenTree(tree);
    this.rowByKey = new Map(rows.map((r) => [r.key, r]));

    const projectsGroup = tree.find((g) => g.id === "projects");
    const projects = projectsGroup?.items || [];
    this.projectByDisplay = new Map(projects.map((proj) => [proj.name, proj]));
    this.projectByName = new Map();
    for (const proj of projects) {
      const existing = this.projectByName.get(proj.project);
      if (!existing || (proj.runtime && !existing.runtime)) {
        this.projectByName.set(proj.project, proj);
      }
    }

    return v_flex()
      .size_full()
      .relative()
      .overflow_y_scrollbar()
      .when(rows.length === 0, (el) =>
        el
          .items_center()
          .justify_center()
          .p(20)
          .child(
            div()
              .text_size(12)
              .text_color(toColor(t.dim))
              .child(this.filterQuery ? "No matching containers or services" : "No containers found")
          )
      )
      .when(rows.length > 0, (el) =>
        el.children(rows.map((row) => this.renderTreeRow(row, t, cx)))
      );
  }

  renderImagesSection(t, ctx, cx) {
    const tree = buildImageTree(this.imagesRaw, this.containersRaw, {
      filter: this.filterQuery,
      sortBy: this.imageSortBy || "name",
      inUseFirst: this.imageInUseFirst,
    });
    const rows = this.flattenImageTree(tree);
    for (const r of rows) this.rowByKey.set(r.key, r);

    return v_flex()
      .size_full()
      .relative()
      // Subheader toolbar (DM-100, DM-102)
      .child(
        h_flex()
          .h(30)
          .w_full()
          .px(8)
          .items_center()
          .justify_between()
          .bg(toColor(t.surface))
          .border_b(1)
          .border_color(toColor(t.border))
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div()
                  .text_size(11)
                  .font_semibold()
                  .text_color(toColor(t.muted))
                  .child(`Images (${tree.totalCount})`)
              )
              .child(
                div()
                  .text_size(10)
                  .text_color(toColor(t.dim))
                  .child(`• ${tree.inUseCount} in use`)
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(4)
              // One sort icon; options live in a small menu.
              .child(this.renderSortButton("images", t, cx))
              // Prune Dangling
              .child(
                h_flex()
                  .h(22)
                  .px(6)
                  .rounded(3)
                  .bg(toColor(t.raised))
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .gap(4)
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    const spec = buildConfirmationSpec("prune-dangling-images", {
                      reclaimable: this.systemDfParsed?.images?.reclaimable,
                    });
                    this.promptConfirm(
                      spec,
                      (confirmCx) => this.runDockerCmd("images:prune-dangling", "Pruning dangling images", ["image", "prune", "-f"], ctx, confirmCx),
                      cx
                    );
                  })
                  .child(svg("mods/docker-manager/icons/broom.svg").size(10).text_color(toColor(t.muted)))
                  .child(div().text_size(10).text_color(toColor(t.foreground)).child("Dangling"))
              )
              // Prune Unused
              .child(
                h_flex()
                  .h(22)
                  .px(6)
                  .rounded(3)
                  .bg(toColor(t.raised))
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .gap(4)
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    const spec = buildConfirmationSpec("prune-unused-images", {
                      reclaimable: this.systemDfParsed?.images?.reclaimable,
                    });
                    this.promptConfirm(
                      spec,
                      (confirmCx) => this.runDockerCmd("images:prune-unused", "Pruning unused images", ["image", "prune", "-a", "-f"], ctx, confirmCx),
                      cx
                    );
                  })
                  .child(svg("mods/docker-manager/icons/trash.svg").size(10).text_color(toColor(t.blocked)))
                  .child(div().text_size(10).text_color(toColor(t.foreground)).child("Prune Unused…"))
              )
          )
      )
      // List
      .child(
        v_flex()
          .absolute()
          .left(0)
          .right(0)
          .top(30)
          .bottom(0)
          .overflow_y_scrollbar()
          .when(rows.length === 0, (el) =>
            el
              .items_center()
              .justify_center()
              .p(20)
              .child(
                div()
                  .text_size(12)
                  .text_color(toColor(t.dim))
                  .child(this.filterQuery ? "No matching images" : "No images found")
              )
          )
          .when(rows.length > 0, (el) =>
            el.children(rows.map((row) => this.renderTreeRow(row, t, cx)))
          )
      );
  }

  renderVolumesSection(t, ctx, cx) {
    const spaceProjects = this.getSpaceProjects(ctx);
    const tree = buildVolumeTree(this.volumesRaw, this.containersRaw, this.volumeSizes, {
      scope: this.scope,
      spaceProjects,
      filter: this.filterQuery,
      sortBy: this.volumeSortBy || "name",
      inUseFirst: this.volumeInUseFirst,
    });
    const rows = this.flattenVolumeTree(tree);
    for (const r of rows) this.rowByKey.set(r.key, r);

    return v_flex()
      .size_full()
      .relative()
      // Subheader toolbar (DM-105, DM-110)
      .child(
        h_flex()
          .h(30)
          .w_full()
          .px(8)
          .items_center()
          .justify_between()
          .bg(toColor(t.surface))
          .border_b(1)
          .border_color(toColor(t.border))
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div()
                  .text_size(11)
                  .font_semibold()
                  .text_color(toColor(t.muted))
                  .child(`Volumes (${tree.totalCount})`)
              )
              .child(
                div()
                  .text_size(10)
                  .text_color(toColor(t.dim))
                  .child(`• ${tree.inUseCount} in use`)
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(4)
              .child(this.renderSortButton("volumes", t, cx))
              // Compute sizes
              .child(
                h_flex()
                  .h(22)
                  .px(6)
                  .rounded(3)
                  .bg(toColor(t.raised))
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .gap(4)
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => this.runVerboseSizeCheck(cx))
                  .child(
                    svg(this.systemDfLoading ? "mods/docker-manager/icons/spinner.svg" : "mods/docker-manager/icons/gauge.svg")
                      .size(10)
                      .text_color(toColor(t.muted))
                      .when(this.systemDfLoading, (s) => s.spin(900))
                  )
                  .child(div().text_size(10).text_color(toColor(t.foreground)).child("Compute Sizes"))
              )
              // Prune Unused Volumes
              .child(
                h_flex()
                  .h(22)
                  .px(6)
                  .rounded(3)
                  .bg(toColor(t.raised))
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .gap(4)
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    const spec = buildConfirmationSpec("prune-volumes", {
                      reclaimable: this.systemDfParsed?.volumes?.reclaimable,
                    });
                    this.promptConfirm(
                      spec,
                      (confirmCx) => this.runDockerCmd("volumes:prune", "Pruning unused volumes", ["volume", "prune", "-f"], ctx, confirmCx),
                      cx
                    );
                  })
                  .child(svg("mods/docker-manager/icons/trash.svg").size(10).text_color(toColor(t.blocked)))
                  .child(div().text_size(10).text_color(toColor(t.foreground)).child("Prune Unused…"))
              )
          )
      )
      // List
      .child(
        v_flex()
          .absolute()
          .left(0)
          .right(0)
          .top(30)
          .bottom(0)
          .overflow_y_scrollbar()
          .when(rows.length === 0, (el) =>
            el
              .items_center()
              .justify_center()
              .p(20)
              .child(
                div()
                  .text_size(12)
                  .text_color(toColor(t.dim))
                  .child(this.filterQuery ? "No matching volumes" : "No volumes found")
              )
          )
          .when(rows.length > 0, (el) =>
            el.children(rows.map((row) => this.renderTreeRow(row, t, cx)))
          )
      );
  }

  renderNetworksSection(t, ctx, cx) {
    const tree = buildNetworkTree(this.networksRaw, this.networkInspectMap, {
      filter: this.filterQuery,
    });
    const rows = this.flattenNetworkTree(tree);
    for (const r of rows) this.rowByKey.set(r.key, r);

    return v_flex()
      .size_full()
      .relative()
      // Subheader toolbar (DM-115, DM-117)
      .child(
        h_flex()
          .h(30)
          .w_full()
          .px(8)
          .items_center()
          .justify_between()
          .bg(toColor(t.surface))
          .border_b(1)
          .border_color(toColor(t.border))
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div()
                  .text_size(11)
                  .font_semibold()
                  .text_color(toColor(t.muted))
                  .child(`Networks (${tree.totalCount})`)
              )
          )
          .child(
            // Prune Unused Networks
            h_flex()
              .h(22)
              .px(6)
              .rounded(3)
              .bg(toColor(t.raised))
              .border_1()
              .border_color(toColor(t.border))
              .items_center()
              .gap(4)
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => {
                const spec = buildConfirmationSpec("prune-networks");
                this.promptConfirm(
                  spec,
                  (confirmCx) => this.runDockerCmd("networks:prune", "Pruning unused networks", ["network", "prune", "-f"], ctx, confirmCx),
                  cx
                );
              })
              .child(svg("mods/docker-manager/icons/trash.svg").size(10).text_color(toColor(t.blocked)))
              .child(div().text_size(10).text_color(toColor(t.foreground)).child("Prune Unused"))
          )
      )
      // List
      .child(
        v_flex()
          .absolute()
          .left(0)
          .right(0)
          .top(30)
          .bottom(0)
          .overflow_y_scrollbar()
          .when(rows.length === 0, (el) =>
            el
              .items_center()
              .justify_center()
              .p(20)
              .child(
                div()
                  .text_size(12)
                  .text_color(toColor(t.dim))
                  .child(this.filterQuery ? "No matching networks" : "No networks found")
              )
          )
          .when(rows.length > 0, (el) =>
            el.children(rows.map((row) => this.renderTreeRow(row, t, cx)))
          )
      );
  }

  renderSystemSection(t, _ctx, cx) {
    const parsed = this.systemDfParsed;
    const engine = this.engineInfoRaw;

    return v_flex()
      .size_full()
      // Subheader toolbar
      .child(
        h_flex()
          .h(30)
          .w_full()
          .px(8)
          .items_center()
          .justify_between()
          .bg(toColor(t.surface))
          .border_b(1)
          .border_color(toColor(t.border))
          .child(
            div()
              .text_size(11)
              .font_semibold()
              .text_color(toColor(t.muted))
              .child("System & Hygiene")
          )
          .child(
            // Run deep size check button
            h_flex()
              .h(22)
              .px(6)
              .rounded(3)
              .bg(toColor(t.raised))
              .border_1()
              .border_color(toColor(t.border))
              .items_center()
              .gap(4)
              .hover((s) => s.bg(toColor(t.hover)))
              .on_click((_e, cx) => this.runVerboseSizeCheck(cx))
              .child(
                svg(this.systemDfLoading ? "mods/docker-manager/icons/spinner.svg" : "mods/docker-manager/icons/gauge.svg")
                  .size(10)
                  .text_color(toColor(t.muted))
                  .when(this.systemDfLoading, (s) => s.spin(900))
              )
              .child(div().text_size(10).text_color(toColor(t.foreground)).child("Deep Size Check"))
          )
      )
      // Scrollable content
      .child(
        v_flex()
          .flex_1()
          .p(10)
          .gap(12)
          .overflow_y_scrollbar()
          // 1. Disk usage cards (DM-120)
          .child(
            v_flex()
              .gap(6)
              .child(div().text_size(11).font_semibold().text_color(toColor(t.foreground)).child("Disk Usage"))
              .child(
                h_flex()
                  .gap(8)
                  .child(this.renderDiskUsageCard("Images", parsed?.images, t, cx))
                  .child(this.renderDiskUsageCard("Containers", parsed?.containers, t, cx))
              )
              .child(
                h_flex()
                  .gap(8)
                  .child(this.renderDiskUsageCard("Local Volumes", parsed?.volumes, t, cx))
                  .child(this.renderDiskUsageCard("Build Cache", parsed?.buildCache, t, cx))
              )
          )
          // 2. Verbose size check results (DM-121)
          .when(Boolean(this.systemDfVerbose), (el) => {
            const v = this.systemDfVerbose;
            return el
              .child(
                v_flex()
                  .gap(6)
                  .child(
                    h_flex()
                      .justify_between()
                      .items_center()
                      .child(div().text_size(11).font_semibold().text_color(toColor(t.foreground)).child("Top 10 Largest Images"))
                  )
                  .child(
                    v_flex()
                      .p(8)
                      .rounded(6)
                      .bg(toColor(t.surface))
                      .border_1()
                      .border_color(toColor(t.border))
                      .gap(2)
                      .children(
                        (v.topImages || []).map((img) =>
                          h_flex()
                            .h(24)
                            .px(6)
                            .rounded(3)
                            .items_center()
                            .justify_between()
                            .hover((s) => s.bg(toColor(t.hover)))
                            .on_click((_e, cx) => {
                              this.activeSection = "images";
                              this.selectTarget({ id: img.id, name: `${img.repository}:${img.tag}`, type: "image", key: `img:${img.id}` }, cx);
                            })
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .child(svg("mods/docker-manager/icons/layers.svg").size(11).text_color(toColor(t.accent)))
                                .child(div().text_size(11).text_color(toColor(t.foreground)).child(`${img.repository}:${img.tag}`))
                            )
                            .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child(img.size))
                        )
                      )
                  )
              )
              .child(
                v_flex()
                  .gap(6)
                  .child(div().text_size(11).font_semibold().text_color(toColor(t.foreground)).child("Top 10 Largest Volumes"))
                  .child(
                    v_flex()
                      .p(8)
                      .rounded(6)
                      .bg(toColor(t.surface))
                      .border_1()
                      .border_color(toColor(t.border))
                      .gap(2)
                      .children(
                        (v.topVolumes || []).map((vol) =>
                          h_flex()
                            .h(24)
                            .px(6)
                            .rounded(3)
                            .items_center()
                            .justify_between()
                            .hover((s) => s.bg(toColor(t.hover)))
                            .on_click((_e, cx) => {
                              this.activeSection = "volumes";
                              this.selectTarget({ name: vol.name, type: "volume", key: `vol:${vol.name}` }, cx);
                            })
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .child(svg("mods/docker-manager/icons/volume.svg").size(11).text_color(toColor(t.accent)))
                                .child(div().text_size(11).text_color(toColor(t.foreground)).child(vol.name))
                            )
                            .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child(vol.size))
                        )
                      )
                  )
              )
              .child(
                v_flex()
                  .gap(6)
                  .child(div().text_size(11).font_semibold().text_color(toColor(t.foreground)).child("Top 10 Largest Containers"))
                  .child(
                    v_flex()
                      .p(8)
                      .rounded(6)
                      .bg(toColor(t.surface))
                      .border_1()
                      .border_color(toColor(t.border))
                      .gap(2)
                      .children(
                        (v.topContainers || []).map((ctr) =>
                          h_flex()
                            .h(24)
                            .px(6)
                            .rounded(3)
                            .items_center()
                            .justify_between()
                            .hover((s) => s.bg(toColor(t.hover)))
                            .on_click((_e, cx) => {
                              this.activeSection = "containers";
                              this.selectTarget({ id: ctr.id, name: ctr.names, type: "container", key: `ctr:${ctr.id}` }, cx);
                            })
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .child(svg("mods/docker-manager/icons/container.svg").size(11).text_color(toColor(t.accent)))
                                .child(div().text_size(11).text_color(toColor(t.foreground)).child(ctr.names || ctr.id.slice(0, 12)))
                            )
                            .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child(ctr.size))
                        )
                      )
                  )
              );
          })
          // 3. Granular Prune Checklist (DM-122)
          .child(
            v_flex()
              .gap(6)
              .child(div().text_size(11).font_semibold().text_color(toColor(t.foreground)).child("Prune Resources"))
              .child(
                v_flex()
                  .p(8)
                  .rounded(6)
                  .bg(toColor(t.surface))
                  .border_1()
                  .border_color(toColor(t.border))
                  .gap(4)
                  .child(
                    this.renderCheckbox(
                      "Stopped containers",
                      this.granularPruneSelections.containers,
                      (cx) => {
                        this.granularPruneSelections.containers = !this.granularPruneSelections.containers;
                        cx.notify();
                      },
                      t,
                      cx,
                      parsed?.containers?.reclaimable ? `Reclaimable: ${parsed.containers.reclaimable}` : null
                    )
                  )
                  .child(
                    this.renderCheckbox(
                      "Dangling images",
                      this.granularPruneSelections.danglingImages,
                      (cx) => {
                        this.granularPruneSelections.danglingImages = !this.granularPruneSelections.danglingImages;
                        cx.notify();
                      },
                      t,
                      cx,
                      parsed?.images?.reclaimable ? `Reclaimable: ${parsed.images.reclaimable}` : null
                    )
                  )
                  .child(
                    this.renderCheckbox(
                      "Unused images (all unreferenced)",
                      this.granularPruneSelections.unusedImages,
                      (cx) => {
                        this.granularPruneSelections.unusedImages = !this.granularPruneSelections.unusedImages;
                        cx.notify();
                      },
                      t,
                      cx,
                      "Requires typed confirm"
                    )
                  )
                  .child(
                    this.renderCheckbox(
                      "Unused local volumes",
                      this.granularPruneSelections.volumes,
                      (cx) => {
                        this.granularPruneSelections.volumes = !this.granularPruneSelections.volumes;
                        cx.notify();
                      },
                      t,
                      cx,
                      "Requires typed confirm"
                    )
                  )
                  .child(
                    this.renderCheckbox(
                      "Unused networks",
                      this.granularPruneSelections.networks,
                      (cx) => {
                        this.granularPruneSelections.networks = !this.granularPruneSelections.networks;
                        cx.notify();
                      },
                      t,
                      cx
                    )
                  )
                  .child(
                    this.renderCheckbox(
                      "Build cache",
                      this.granularPruneSelections.buildCache,
                      (cx) => {
                        this.granularPruneSelections.buildCache = !this.granularPruneSelections.buildCache;
                        cx.notify();
                      },
                      t,
                      cx,
                      parsed?.buildCache?.reclaimable ? `Reclaimable: ${parsed.buildCache.reclaimable}` : null
                    )
                  )
                  .when(this.granularPruneSelections.buildCache, (el) =>
                    el.child(
                      this.renderCheckbox(
                        "Only build cache older than 7 days",
                        this.granularPruneSelections.buildCacheOlderThan7d,
                        (cx) => {
                          this.granularPruneSelections.buildCacheOlderThan7d = !this.granularPruneSelections.buildCacheOlderThan7d;
                          cx.notify();
                        },
                        t,
                        cx
                      )
                    )
                  )
                  // Prune Selected Button
                  .child(
                    h_flex()
                      .justify_end()
                      .mt(4)
                      .child(
                        h_flex()
                          .px(10)
                          .h(26)
                          .rounded(4)
                          .bg(toColor(t.blocked))
                          .items_center()
                          .gap(4)
                          .hover((s) => s.opacity(0.9))
                          .on_click((_e, cx) => {
                            const plan = buildGranularPrunePlan(this.granularPruneSelections);
                            if (plan.commands.length === 0) return;
                            const spec = buildConfirmationSpec("prune-granular", {
                              plan,
                              requiresTypedConfirm: plan.requiresTypedConfirm,
                            });
                            this.promptConfirm(spec, (confirmCx) => this.runGranularPrune(confirmCx), cx);
                          })
                          .child(svg("mods/docker-manager/icons/trash.svg").size(11).text_color(toColor(t.solid_foreground)))
                          .child(
                            div()
                              .text_size(11)
                              .font_semibold()
                              .text_color(toColor(t.solid_foreground))
                              .child("Prune Selected Resources…")
                          )
                      )
                  )
              )
          )
          // 4. Engine Info (DM-123)
          .child(
            v_flex()
              .gap(6)
              .child(div().text_size(11).font_semibold().text_color(toColor(t.foreground)).child("Engine Information"))
              .child(
                v_flex()
                  .p(8)
                  .rounded(6)
                  .bg(toColor(t.surface))
                  .border_1()
                  .border_color(toColor(t.border))
                  .gap(4)
                  .child(this.renderDrawerRow("Docker Version", engine?.ServerVersion || this.engineVersion || "Docker", t, cx, true))
                  .child(this.renderDrawerRow("API Version", engine?.ApiVersion || "N/A", t, cx))
                  .child(this.renderDrawerRow("OS / Arch", `${engine?.OperatingSystem || ""} (${engine?.Architecture || ""})`, t, cx))
                  .child(this.renderDrawerRow("CPUs", String(engine?.NCPU || "N/A"), t, cx))
                  .child(
                    this.renderDrawerRow(
                      "Memory",
                      engine?.MemTotal ? `${(engine.MemTotal / (1024 * 1024 * 1024)).toFixed(2)} GB` : "N/A",
                      t,
                      cx
                    )
                  )
                  .child(this.renderDrawerRow("Storage Driver", engine?.Driver || "N/A", t, cx))
                  .child(this.renderDrawerRow("Root Directory", engine?.DockerRootDir || "N/A", t, cx, true))
              )
          )
      );
  }

  renderImageDialog(t, cx) {
    const dialog = this.imageDialog;
    if (!dialog) return div();

    const isRun = dialog.action === "run-image";
    const title = isRun ? `Run Image: ${dialog.image.name}` : `Tag Image: ${dialog.image.name}`;

    return h_flex()
      .id("docker-image-backdrop")
      .absolute()
      .inset_0()
      .bg(toColor(t.background + "aa"))
      .items_center()
      .justify_center()
      .p(16)
      .on_mouse_down("left", (_e, cx) => {
        this.imageDialog = null;
        cx.notify();
      })
      .child(
        v_flex()
          .id("docker-image-dialog")
          .w(320)
          .max_w_full()
          .p(14)
          .bg(toColor(t.popover))
          .border_1()
          .border_color(toColor(t.border))
          .rounded(6)
          .shadow_md()
          .gap(10)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          // Header
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                div()
                  .text_size(13)
                  .font_semibold()
                  .text_color(toColor(t.foreground))
                  .child(title)
              )
              .child(
                h_flex()
                  .size(18)
                  .rounded(2)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.imageDialog = null;
                    cx.notify();
                  })
                  .child(svg("mods/docker-manager/icons/close.svg").size(12).text_color(toColor(t.muted)))
              )
          )
          // Run Dialog Inputs
          .when(isRun, (el) =>
            el
              .child(
                v_flex()
                  .gap(4)
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Container Name"))
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.imgRunNameInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                v_flex()
                  .gap(4)
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Published Ports (e.g. 8080:80)"))
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.imgRunPortsInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                v_flex()
                  .gap(4)
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Environment (e.g. KEY=VAL, FOO=BAR)"))
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.imgRunEnvInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .hover((s) => s.opacity(0.9))
                  .on_click((_e, cx) => {
                    this.imgRunDetached = !this.imgRunDetached;
                    cx.notify();
                  })
                  .child(
                    div()
                      .size(14)
                      .rounded(2)
                      .border_1()
                      .border_color(toColor(t.border))
                      .items_center()
                      .justify_center()
                      .when(this.imgRunDetached, (b) =>
                        b
                          .bg(toColor(t.accent))
                          .child(svg("mods/docker-manager/icons/check.svg").size(10).text_color(toColor(t.solid_foreground)))
                      )
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(toColor(t.foreground))
                      .child("Run in background (detached -d)")
                  )
              )
          )
          // Tag Dialog Inputs
          .when(!isRun, (el) =>
            el.child(
              v_flex()
                .gap(4)
                .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Target Tag (repo:tag)"))
                .child(
                  h_flex()
                    .h(26)
                    .px(6)
                    .rounded(4)
                    .bg(toColor(t.input))
                    .border_1()
                    .border_color(toColor(t.border))
                    .child(Input.new(this.imgTagInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                )
            )
          )
          // Buttons
          .child(
            h_flex()
              .justify_end()
              .gap(6)
              .mt(6)
              .child(
                h_flex()
                  .px(10)
                  .h(24)
                  .rounded(4)
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .text_size(11)
                  .text_color(toColor(t.foreground))
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.imageDialog = null;
                    cx.notify();
                  })
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .px(12)
                  .h(24)
                  .rounded(4)
                  .bg(toColor(t.accent))
                  .items_center()
                  .text_size(11)
                  .font_semibold()
                  .text_color(toColor(t.solid_foreground))
                  .hover((s) => s.opacity(0.9))
                  .on_click((_e, cx) => this.submitImageModal(cx))
                  .child(isRun ? "Run" : "Tag")
              )
          )
      );
  }

  renderVolumeDialog(t, cx) {
    const dialog = this.volumeDialog;
    if (!dialog) return div();

    const action = dialog.action;
    const vol = dialog.volume;
    const title =
      action === "backup"
        ? `Backup Volume: ${vol.name}`
        : action === "restore"
        ? `Restore Volume: ${vol.name}`
        : `Clone Volume: ${vol.name}`;

    return h_flex()
      .id("docker-volume-backdrop")
      .absolute()
      .inset_0()
      .bg(toColor(t.background + "aa"))
      .items_center()
      .justify_center()
      .p(16)
      .on_mouse_down("left", (_e, cx) => {
        this.volumeDialog = null;
        cx.notify();
      })
      .child(
        v_flex()
          .id("docker-volume-dialog")
          .w(340)
          .max_w_full()
          .p(14)
          .bg(toColor(t.popover))
          .border_1()
          .border_color(toColor(action === "restore" ? t.blocked : t.border))
          .rounded(6)
          .shadow_md()
          .gap(10)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          // Header
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                div()
                  .text_size(13)
                  .font_semibold()
                  .text_color(toColor(t.foreground))
                  .child(title)
              )
              .child(
                h_flex()
                  .size(18)
                  .rounded(2)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.volumeDialog = null;
                    cx.notify();
                  })
                  .child(svg("mods/docker-manager/icons/close.svg").size(12).text_color(toColor(t.muted)))
              )
          )
          // Backup inputs
          .when(action === "backup", (el) =>
            el
              .child(
                v_flex()
                  .gap(4)
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Destination Directory"))
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.volDestDirInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                v_flex()
                  .gap(4)
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Archive Filename"))
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.volArchiveNameInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
          )
          // Restore inputs
          .when(action === "restore", (el) =>
            el
              .child(
                div()
                  .text_size(11)
                  .text_color(toColor(t.blocked))
                  .child("Warning: Restoring will overwrite all existing contents of this volume!")
              )
              .child(
                v_flex()
                  .gap(4)
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Backup Directory"))
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.volSrcDirInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                v_flex()
                  .gap(4)
                  .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("Archive Filename (*.tar.gz)"))
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.volRestoreArchiveInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
              .child(
                v_flex()
                  .gap(4)
                  .child(
                    div()
                      .text_size(10)
                      .font_semibold()
                      .text_color(toColor(t.foreground))
                      .child(`Type "${vol.name}" to confirm:`)
                  )
                  .child(
                    h_flex()
                      .h(26)
                      .px(6)
                      .rounded(4)
                      .bg(toColor(t.input))
                      .border_1()
                      .border_color(toColor(t.border))
                      .child(Input.new(this.volTypedConfirmInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                  )
              )
          )
          // Clone inputs
          .when(action === "clone", (el) =>
            el.child(
              v_flex()
                .gap(4)
                .child(div().text_size(10).font_semibold().text_color(toColor(t.muted)).child("New Volume Name"))
                .child(
                  h_flex()
                    .h(26)
                    .px(6)
                    .rounded(4)
                    .bg(toColor(t.input))
                    .border_1()
                    .border_color(toColor(t.border))
                    .child(Input.new(this.volCloneDestInput).flex_1().h_full().text_size(11).text_color(toColor(t.foreground)))
                )
            )
          )
          // Buttons
          .child(
            h_flex()
              .justify_end()
              .gap(6)
              .mt(6)
              .child(
                h_flex()
                  .px(10)
                  .h(24)
                  .rounded(4)
                  .border_1()
                  .border_color(toColor(t.border))
                  .items_center()
                  .text_size(11)
                  .text_color(toColor(t.foreground))
                  .hover((s) => s.bg(toColor(t.hover)))
                  .on_click((_e, cx) => {
                    this.volumeDialog = null;
                    cx.notify();
                  })
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .px(12)
                  .h(24)
                  .rounded(4)
                  .bg(toColor(action === "restore" ? t.blocked : t.accent))
                  .items_center()
                  .text_size(11)
                  .font_semibold()
                  .text_color(toColor(t.solid_foreground))
                  .hover((s) => s.opacity(0.9))
                  .on_click((_e, cx) => this.submitVolumeModal(cx))
                  .child(action === "backup" ? "Backup" : action === "restore" ? "Restore" : "Clone")
              )
          )
      );
  }

  /** Main GPUI render description */
  render(cx) {
    // checkCrossModRequest() is intentionally NOT called here: it mutates state and notifies, and
    // notifying during render throws. poll() consumes requests off the render path.
    this.checkCrossModRequest(cx);
    const t = theme();
    const p = props();

    // Mode 2: Inspector Tab Mode (DM-44..46)
    if (p?.inspect) {
      return this.renderInspectorTab(t, cx);
    }

    // Mode 1: Panel Mode
    if (this.engineStatus === "unavailable") {
      return v_flex()
        .size_full()
        .bg(toColor(t.surface))
        .child(this.renderToolbar(t, cx))
        .child(this.renderEngineUnavailable(t, cx));
    }

    const ctx = resolveDockerContext({
      props: p,
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      focused: focused(),
      shared,
    });

    let mainList;
    if (this.activeSection === "images") {
      mainList = this.renderImagesSection(t, ctx, cx);
    } else if (this.activeSection === "volumes") {
      mainList = this.renderVolumesSection(t, ctx, cx);
    } else if (this.activeSection === "networks") {
      mainList = this.renderNetworksSection(t, ctx, cx);
    } else if (this.activeSection === "system") {
      mainList = this.renderSystemSection(t, ctx, cx);
    } else {
      mainList = this.renderContainersSection(t, ctx, cx);
    }

    // Root layout container with focus & size tracking and Esc handling (DM-12, DM-40, SPEC §7)
    return v_flex()
      .id("docker-manager-root")
      .size_full()
      .relative()
      .bg(toColor(t.surface))
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        this.panelSize = size;
      })
      .on_mouse_down("right", (event, cx) => this.openRowContextMenu(event, cx))
      .on_key_down((e, cx) => {
        if (e.key === "Escape") {
          if (this.contextMenu) {
            this.contextMenu = null;
            cx.notify();
            return;
          }
          if (this.confirmDialog) {
            this.confirmDialog = null;
            cx.notify();
            return;
          }
          if (this.dockerfileDialog) {
            this.dockerfileDialog = null;
            cx.notify();
            return;
          }
          if (this.imageDialog) {
            this.imageDialog = null;
            cx.notify();
            return;
          }
          if (this.volumeDialog) {
            this.volumeDialog = null;
            cx.notify();
            return;
          }
          if (this.toolbarMenuOpen) {
            this.toolbarMenuOpen = false;
            cx.notify();
            return;
          }
          if (this.drawerOpen) {
            this.drawerOpen = false;
            cx.notify();
            return;
          }
          if (this.filterQuery) {
            this.filterInput.set_value("");
            this.filterQuery = "";
            cx.notify();
            return;
          }
        }
      })
      .child(this.renderToolbar(t, cx))
      .child(this.renderSectionSwitcher(t, cx))
      .child(this.renderFilterBox(t, cx))
      // Main list with optional resizable inspector drawer (DM-40..43)
      .when(this.drawerOpen && Boolean(this.selectedTarget), (el) =>
        el.child(
          v_resizable("docker-panel-resizable-split")
            .flex_1()
            .min_h(0)
            .child(resizable_panel().child(mainList))
            .child(
              resizable_panel()
                .size(this.drawerHeight)
                .size_range(140, 600)
                .child(this.renderInspectorDrawer(t, cx))
            )
        )
      )
      .when(!this.drawerOpen || !this.selectedTarget, (el) =>
        el.child(v_flex().flex_1().min_h(0).child(mainList))
      )
      // Overlays painted last in painter's algorithm order
      .when(Boolean(this.contextMenu), (el) => el.child(this.renderContextMenu(t, cx)))
      .when(Boolean(this.confirmDialog), (el) => el.child(this.renderConfirmDialog(t, cx)))
      .when(Boolean(this.dockerfileDialog), (el) => el.child(this.renderDockerfileDialog(t, cx)))
      .when(Boolean(this.imageDialog), (el) => el.child(this.renderImageDialog(t, cx)))
      .when(Boolean(this.volumeDialog), (el) => el.child(this.renderVolumeDialog(t, cx)))
      .when(Boolean(this.toolbarMenuOpen), (el) => el.child(this.renderToolbarMenu(t, cx)))
      .when(Boolean(this.sortMenuOpen), (el) => el.child(this.renderSortMenu(t, cx)));
  }
}
