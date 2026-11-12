// Pure, zero-dependency domain logic for docker-manager mod.
// Handles label extraction, CLI argv generation, workspace tree construction,
// secret masking, and inspect normalization without DOM or GPUI dependencies.

/**
 * Validates Docker resource identifiers (container names, project names, volumes, networks).
 * Prevents shell injection, path traversal, and empty arguments (DM-87).
 *
 * @param {string} name
 * @param {string} [type="identifier"]
 * @returns {boolean}
 */
export function validateDockerIdentifier(name, type = "identifier") {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`Invalid Docker ${type}: name must be a non-empty string`);
  }
  const trimmed = name.trim();
  // Reject shell metacharacters: ;, &, |, $, `, \, ", ', <, >, (, ), whitespace, control chars
  if (/[\s;&|$`\\"\'<>(){}\r\n\t\0]/.test(trimmed)) {
    throw new Error(`Invalid Docker ${type}: "${trimmed}" contains forbidden characters`);
  }
  // Reject path traversal
  if (trimmed.includes("..")) {
    throw new Error(`Invalid Docker ${type}: "${trimmed}" contains path traversal`);
  }
  // Docker names, ids and image refs start with an alphanumeric character. A leading "-"
  // would be parsed as a CLI flag by docker and a leading "/" as an absolute path, so both
  // must fail here rather than at the CLI (DM-87).
  // Image references legitimately contain '/', ':' and '@' (registry/repo:tag@digest); container
  // names, volume names, network ids and project names do not, so a path-like value is rejected
  // there instead of being passed to docker as if it were a name.
  const looksLikeImage = /image/i.test(type) || /[:@]/.test(trimmed);
  const shape = looksLikeImage
    ? /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/
    : /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  if (!shape.test(trimmed)) {
    throw new Error(`Invalid Docker ${type}: "${trimmed}" is not a Docker identifier`);
  }
  return true;
}

/**
 * Classifies a file path into a Docker file type based on its basename (DM-30..34, DM-90..91).
 *
 * @param {string} filePath
 * @returns {"compose" | "dockerfile" | null}
 */
export function classifyDockerFile(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const basename = filePath.split("/").pop() || "";
  // Compose files: compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml,
  // plus compose.override.yml, compose.dev.yaml, docker-compose.prod.yml, etc.
  if (/^(?:docker-)?compose(?:\.[a-z0-9_-]+)*\.ya?ml$/i.test(basename)) {
    return "compose";
  }
  // Dockerfiles: Dockerfile, Dockerfile.dev, web.Dockerfile, Containerfile, Containerfile.prod, etc.
  if (/^(?:Dockerfile(?:\.[a-z0-9_-]+)*|[a-z0-9_.-]+\.Dockerfile|Containerfile(?:\.[a-z0-9_-]+)*)$/i.test(basename)) {
    return "dockerfile";
  }
  return null;
}

/**
 * Checks whether an environment variable key should be masked as a secret (DM-45).
 * Matches PASS, SECRET, TOKEN, KEY, CREDENTIAL, PRIVATE, etc.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretEnvKey(key) {
  if (!key || typeof key !== "string") return false;
  const k = String(key).toUpperCase();
  // DM-45: PASS/PASSWORD/SECRET/TOKEN/KEY/PRIVATE/CREDENTIAL. Suffixes with no separator
  // (PGPASSWORD, DBPASSWORD) and bare *_KEY (SSH_KEY, ENCRYPTION_KEY) must mask too: leaking a
  // signing key in the Environment view is worse than masking a harmless value.
  if (/(?:^|_)(?:PASS|PASSWORD|PASSPHRASE|SECRET|TOKEN|KEY|AUTH|CREDENTIAL|CREDENTIALS|PRIVATE)(?:$|_)/.test(k)) return true;
  if (/(?:PASSWORD|PASSPHRASE|SECRET|TOKEN|KEY|CREDENTIAL|CREDENTIALS)$/.test(k)) return true;
  return /API_?KEY|PRIVATE_?KEY|CLIENT_SECRET|DATABASE_URL|REDIS_URL|CONNECTION_STRING/.test(k);
}

/**
 * Parses raw comma-separated labels string from `docker container ls --format '{{json .}}'`
 * into a key-value record.
 * Preserves multi-file paths in `com.docker.compose.project.config_files` and other comma-containing values
 * by only splitting on commas immediately preceding a valid key token (DESIGN §4.1).
 *
 * @param {string | Record<string, string>} rawLabels
 * @returns {Record<string, string>}
 */
export function parseContainerLabels(rawLabels) {
  if (!rawLabels) return {};
  if (typeof rawLabels === "object") return { ...rawLabels };
  if (typeof rawLabels !== "string") return {};

  const trimmed = rawLabels.trim();
  if (trimmed.length === 0) return {};

  const labels = {};
  // Split only on commas that are followed by a key token ending with '='
  // e.g. `,com.docker.compose.project=` or `,desktop.docker.io/binds/0/source=`
  const tokens = trimmed.split(/,(?=[a-zA-Z0-9_./-]+=[^,]*)/);

  for (const token of tokens) {
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx).trim();
      const val = token.slice(eqIdx + 1).trim();
      labels[key] = val;
    }
  }

  return labels;
}

/**
 * Checks if a target path is equal to or inside a parent directory.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isPathInside(parent, child) {
  if (!parent || !child || typeof parent !== "string" || typeof child !== "string") return false;
  const p = parent.replace(/\/+$/, "");
  const c = child.replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
}

/**
 * Resolves current workspace execution context (cwd, on/machine)
 * following Herdr standard (DESIGN §3).
 *
 * @param {object} params
 * @param {object} [params.props]
 * @param {Array<object>} [params.spaces]
 * @param {Array<object>} [params.panes]
 * @param {Array<object>} [params.terminals]
 * @param {object} [params.focused]
 * @param {Function} [params.shared]
 * @param {string} [params.currentRoot]
 * @returns {{ cwd: string, on: string | null, machine: string | null }}
 */
export function resolveDockerContext({ props, spaces = [], panes = [], terminals = [], focused = null, shared = null, currentRoot = null } = {}) {
  // 1. Explicit props override
  if (props?.folder || props?.cwd || props?.repo) {
    const cwd = props.folder || props.cwd || props.repo;
    const on = props.on ?? null;
    return { cwd, on, machine: on };
  }

  // 2. Active space
  const spaceList = typeof spaces === "function" ? spaces() : spaces;
  const activeSpace = spaceList.find((s) => s.active);
  const machine = activeSpace?.machine ?? null;

  if (activeSpace) {
    // Check pinned location
    const pinnedMap = typeof shared === "function" ? shared("spaces.pinned_locations") : null;
    if (pinnedMap && pinnedMap[activeSpace.id]) {
      const cwd = pinnedMap[activeSpace.id];
      return { cwd, on: machine, machine };
    }

    // Check focused cwd if it matches active space
    const f = typeof focused === "function" ? focused() : focused;
    if (f && f.space === activeSpace.id && f.cwd) {
      return { cwd: f.cwd, on: machine, machine };
    }

    // Terminal cwd in active space
    const paneList = typeof panes === "function" ? panes() : panes;
    const activePanes = paneList.filter((p) => p.space === activeSpace.id);
    for (const p of activePanes) {
      if (p.cwd) {
        return { cwd: p.cwd, on: machine, machine };
      }
    }

    if (activeSpace.folder) {
      return { cwd: activeSpace.folder, on: machine, machine };
    }
  }

  const cwd = currentRoot || "/";
  return { cwd, on: machine, machine };
}

/**
 * Builds standard Compose argv array for a target project (DESIGN §4.5).
 *
 * @param {{ project: string, workingDir?: string | null, configFiles?: string[] }} target
 * @param {string[]} subcommandArgs
 * @returns {string[]}
 */
export function buildComposeArgs(target, subcommandArgs = []) {
  if (!target || !target.project) {
    throw new Error("Target must specify a project name");
  }
  validateDockerIdentifier(target.project, "project name");

  const files = Array.isArray(target.configFiles) ? target.configFiles.filter(Boolean) : [];
  const args = ["compose", "-p", target.project];

  if (files.length > 0) {
    if (target.workingDir) {
      args.push("--project-directory", target.workingDir);
    }
    for (const f of files) {
      args.push("-f", f);
    }
  }

  return [...args, ...subcommandArgs];
}

// Lifecycle argv builders
export function buildComposeUpArgs(target, { build = false, service = null } = {}) {
  const sub = ["up", "-d"];
  if (build) sub.push("--build");
  if (service) {
    validateDockerIdentifier(service, "service name");
    sub.push(service);
  }
  return buildComposeArgs(target, sub);
}

export function buildComposeDownArgs(target, { volumes = false } = {}) {
  const sub = ["down"];
  if (volumes) sub.push("-v");
  return buildComposeArgs(target, sub);
}

export function buildComposeStartArgs(target, service = null) {
  const sub = ["start"];
  if (service) {
    validateDockerIdentifier(service, "service name");
    sub.push(service);
  }
  return buildComposeArgs(target, sub);
}

export function buildComposeStopArgs(target, service = null) {
  const sub = ["stop"];
  if (service) {
    validateDockerIdentifier(service, "service name");
    sub.push(service);
  }
  return buildComposeArgs(target, sub);
}

export function buildComposeRestartArgs(target, service = null) {
  const sub = ["restart"];
  if (service) {
    validateDockerIdentifier(service, "service name");
    sub.push(service);
  }
  return buildComposeArgs(target, sub);
}

export function buildComposePullArgs(target, service = null) {
  const sub = ["pull"];
  if (service) {
    validateDockerIdentifier(service, "service name");
    sub.push(service);
  }
  return buildComposeArgs(target, sub);
}

export function buildComposeBuildArgs(target, service = null) {
  const sub = ["build"];
  if (service) {
    validateDockerIdentifier(service, "service name");
    sub.push(service);
  }
  return buildComposeArgs(target, sub);
}

export function buildComposeRebuildArgs(target, service) {
  if (!service) throw new Error("Service name is required for rebuild");
  validateDockerIdentifier(service, "service name");
  return buildComposeArgs(target, ["up", "-d", "--build", "--force-recreate", "--no-deps", service]);
}

export function buildComposeRecreateArgs(target, service) {
  if (!service) throw new Error("Service name is required for recreate");
  validateDockerIdentifier(service, "service name");
  return buildComposeArgs(target, ["up", "-d", "--force-recreate", "--no-deps", service]);
}

export function buildComposeRmArgs(target, service) {
  if (!service) throw new Error("Service name is required for rm");
  validateDockerIdentifier(service, "service name");
  return buildComposeArgs(target, ["rm", "-s", "-f", service]);
}

export function buildComposeLogsArgs(target, service = null, tail = 500) {
  const sub = ["logs", "-f", "--tail", String(tail)];
  if (service) {
    validateDockerIdentifier(service, "service name");
    sub.push(service);
  }
  return ["docker", ...buildComposeArgs(target, sub)];
}

export function buildContainerLogsArgs(containerId, tail = 500) {
  validateDockerIdentifier(containerId, "container ID");
  return ["docker", "logs", "-f", "--tail", String(tail), containerId];
}

export function buildContainerShellArgs(containerId, shellType = "auto") {
  validateDockerIdentifier(containerId, "container ID");
  if (shellType === "bash") {
    return ["docker", "exec", "-it", containerId, "bash"];
  }
  if (shellType === "sh") {
    return ["docker", "exec", "-it", containerId, "sh"];
  }
  // "auto": try bash, else fallback to sh
  return [
    "docker",
    "exec",
    "-it",
    containerId,
    "sh",
    "-c",
    "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
  ];
}

export function buildContainerActionArgs(action, containerId) {
  validateDockerIdentifier(containerId, "container ID");
  if (!["start", "stop", "restart", "pause", "unpause", "kill"].includes(action)) {
    throw new Error(`Invalid container action: ${action}`);
  }
  return ["docker", action, containerId];
}

export function buildContainerRmArgs(containerId, { force = false } = {}) {
  validateDockerIdentifier(containerId, "container ID");
  return ["docker", "rm", ...(force ? ["-f"] : []), containerId];
}

export function buildVolumeInspectArgs(volumeName) {
  validateDockerIdentifier(volumeName, "volume name");
  return ["volume", "inspect", "--format", "{{json .}}", volumeName];
}

export function buildVolumeBrowseArgs(volumeName, helperImage = "alpine:3") {
  validateDockerIdentifier(volumeName, "volume name");
  return ["docker", "run", "--rm", "-it", "-v", `${volumeName}:/data:ro`, "-w", "/data", helperImage, "sh"];
}

export function buildVolumeBackupArgs(volumeName, destDir, archiveName, helperImage = "alpine:3") {
  validateDockerIdentifier(volumeName, "volume name");
  validateDockerIdentifier(archiveName.replace(/\.tar\.gz$/, ""), "archive name");
  return [
    "run",
    "--rm",
    "-v",
    `${volumeName}:/data:ro`,
    "-v",
    `${destDir}:/backup`,
    helperImage,
    "tar",
    "czf",
    `/backup/${archiveName}`,
    "-C",
    "/data",
    ".",
  ];
}

export function buildVolumeRestoreArgs(volumeName, srcDir, archiveName, helperImage = "alpine:3") {
  validateDockerIdentifier(volumeName, "volume name");
  validateDockerIdentifier(archiveName.replace(/\.tar\.gz$/, ""), "archive name");
  return [
    "run",
    "--rm",
    "-v",
    `${volumeName}:/data`,
    "-v",
    `${srcDir}:/backup:ro`,
    helperImage,
    "sh",
    "-c",
    `rm -rf /data/* /data/..?* /data/.[!.]* && tar xzf "/backup/${archiveName}" -C /data`,
  ];
}

export function buildVolumeCloneArgs(srcVolume, destVolume, helperImage = "alpine:3") {
  validateDockerIdentifier(srcVolume, "source volume");
  validateDockerIdentifier(destVolume, "dest volume");
  return {
    createArgs: ["volume", "create", destVolume],
    copyArgs: [
      "run",
      "--rm",
      "-v",
      `${srcVolume}:/from:ro`,
      "-v",
      `${destVolume}:/to`,
      helperImage,
      "sh",
      "-c",
      "cp -a /from/. /to/",
    ],
  };
}

export function buildVolumePruneArgs(all = false) {
  return ["volume", "prune", "-f", ...(all ? ["--all"] : [])];
}

export function buildImageHistoryArgs(imageId) {
  validateDockerIdentifier(imageId, "image ID");
  return ["image", "history", "--no-trunc", "--format", "{{json .}}", imageId];
}

export function buildImagePruneArgs({ all = false } = {}) {
  return ["image", "prune", "-f", ...(all ? ["-a"] : [])];
}

export function buildImageRmArgs(imageId, { force = false } = {}) {
  validateDockerIdentifier(imageId, "image ID");
  return ["image", "rm", ...(force ? ["-f"] : []), imageId];
}

export function buildNetworkInspectArgs(networkId) {
  validateDockerIdentifier(networkId, "network ID");
  return ["network", "inspect", "--format", "{{json .}}", networkId];
}

export function buildNetworkPruneArgs() {
  return ["network", "prune", "-f"];
}

export function buildNetworkRmArgs(networkId) {
  validateDockerIdentifier(networkId, "network ID");
  return ["network", "rm", networkId];
}

export function buildSystemDfArgs({ verbose = false } = {}) {
  return verbose ? ["system", "df", "-v", "--format", "json"] : ["system", "df", "--format", "{{json .}}"];
}

export function buildBuilderPruneArgs({ olderThan7d = false } = {}) {
  return ["builder", "prune", "-f", ...(olderThan7d ? ["--filter", "until=168h"] : [])];
}

/**
 * Normalizes raw `docker inspect` JSON output into a structured ContainerInspect object (DM-40..45).
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeContainerInspect(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = raw.Id || "";
  const shortId = id.slice(0, 12);
  const name = (raw.Name || "").replace(/^\//, "");
  const labels = raw.Config?.Labels || {};

  const project = labels["com.docker.compose.project"] || null;
  const service = labels["com.docker.compose.service"] || null;
  const containerNumber = labels["com.docker.compose.container-number"] || null;
  const sourceFile = labels["herdr.docker-manager.source"] || null;

  // Ports extraction
  const ports = [];
  // `NetworkSettings.Ports` is `{}` for a created/stopped container (truthy!), so a plain
  // `||` never reaches HostConfig.PortBindings and every stopped container lost its ports.
  const networkPorts = raw.NetworkSettings?.Ports;
  const hasPublishedPorts =
    networkPorts && Object.values(networkPorts).some((b) => Array.isArray(b) && b.length > 0);
  const portSettings = hasPublishedPorts ? networkPorts : (raw.HostConfig?.PortBindings || {});
  for (const [key, bindings] of Object.entries(portSettings)) {
    const [portStr, proto = "tcp"] = key.split("/");
    const containerPort = parseInt(portStr, 10);
    if (Array.isArray(bindings) && bindings.length > 0) {
      for (const b of bindings) {
        ports.push({
          hostIp: b.HostIp || "0.0.0.0",
          hostPort: parseInt(b.HostPort, 10) || null,
          containerPort,
          proto,
        });
      }
    } else {
      ports.push({
        hostIp: null,
        hostPort: null,
        containerPort,
        proto,
      });
    }
  }

  // Mounts extraction
  const mounts = (raw.Mounts || []).map((m) => ({
    type: m.Type || "bind",
    name: m.Name || null,
    source: m.Source || "",
    destination: m.Destination || "",
    rw: m.RW !== false,
    driver: m.Driver || null,
  }));

  // Networks extraction
  const networks = Object.entries(raw.NetworkSettings?.Networks || {}).map(([netName, net]) => ({
    name: netName,
    ipAddress: net.IPAddress || "",
    gateway: net.Gateway || "",
    macAddress: net.MacAddress || "",
    aliases: net.Aliases || [],
    networkId: net.NetworkID ? net.NetworkID.slice(0, 12) : "",
  }));

  // Environment extraction with secret masking
  const env = (raw.Config?.Env || []).map((entry) => {
    const eqIdx = entry.indexOf("=");
    if (eqIdx >= 0) {
      const k = entry.slice(0, eqIdx);
      const v = entry.slice(eqIdx + 1);
      return { key: k, value: v, secret: isSecretEnvKey(k) };
    }
    return { key: entry, value: "", secret: isSecretEnvKey(entry) };
  });

  const entrypoint = Array.isArray(raw.Config?.Entrypoint)
    ? raw.Config.Entrypoint.join(" ")
    : raw.Config?.Entrypoint || "";
  const cmd = Array.isArray(raw.Config?.Cmd)
    ? raw.Config.Cmd.join(" ")
    : raw.Config?.Cmd || "";

  const composeFiles = labels["com.docker.compose.project.config_files"]
    ? labels["com.docker.compose.project.config_files"].split(",")
    : [];

  return {
    id,
    shortId,
    name,
    project,
    service,
    containerNumber,
    sourceFile,
    image: raw.Config?.Image || "",
    imageId: raw.Image ? raw.Image.replace(/^sha256:/, "").slice(0, 12) : "",
    created: raw.Created || "",
    startedAt: raw.State?.StartedAt || "",
    // Docker reports a never-finished container with the zero time; showing 0001-01-01 is noise.
    finishedAt: raw.State?.FinishedAt && !raw.State.FinishedAt.startsWith("0001-01-01") ? raw.State.FinishedAt : "",
    state: {
      status: raw.State?.Status || "unknown",
      running: Boolean(raw.State?.Running),
      paused: Boolean(raw.State?.Paused),
      restarting: Boolean(raw.State?.Restarting),
      oomKilled: Boolean(raw.State?.OOMKilled),
      dead: Boolean(raw.State?.Dead),
      exitCode: raw.State?.ExitCode ?? 0,
      error: raw.State?.Error || "",
    },
    health: {
      status: raw.State?.Health?.Status || null,
      failingStreak: raw.State?.Health?.FailingStreak ?? 0,
      lastLog:
        raw.State?.Health?.Log && raw.State.Health.Log.length > 0
          ? raw.State.Health.Log[raw.State.Health.Log.length - 1].Output || ""
          : "",
    },
    restartPolicy: {
      name: raw.HostConfig?.RestartPolicy?.Name || "no",
      maximumRetryCount: raw.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0,
    },
    ports,
    mounts,
    networks,
    env,
    entrypoint,
    cmd,
    workingDir: raw.Config?.WorkingDir || "",
    labels,
    composeFiles,
    dependsOn: labels["com.docker.compose.depends_on"] || "",
  };
}

/**
 * Builds the hierarchical container tree according to DM-20..27, DM-35..36.
 *
 * @param {object} params
 * @param {Array<object>} params.containers - Normalized containers from docker container ls -a
 * @param {Array<object>} [params.composeLs] - Output from docker compose ls --all
 * @param {Array<object>} [params.discoveredCompose] - Discovered compose files in workspace
 * @param {Array<object>} [params.discoveredDockerfiles] - Discovered Dockerfiles in workspace
 * @param {string} [params.spaceRoot] - Root directory of the space
 * @param {"all" | "space"} [params.scope="all"] - Filtering scope
 * @param {string} [params.filter=""] - Text search filter (DM-12)
 * @returns {Array<object>}
 */
export function buildContainerTree({
  containers = [],
  composeLs = [],
  discoveredCompose = [],
  discoveredDockerfiles = [],
  spaceRoot = null,
  scope = "all",
  filter = "",
} = {}) {
  const normFilter = (filter || "").trim().toLowerCase();

  // Helper: check if a container matches filter query
  function containerMatchesFilter(c) {
    if (!normFilter) return true;
    const name = (c.name || c.Names || "").toLowerCase();
    const image = (c.image || c.Image || "").toLowerCase();
    const service = (c.service || "").toLowerCase();
    const project = (c.project || "").toLowerCase();
    const ports = (c.ports || c.Ports || "").toLowerCase();
    return (
      name.includes(normFilter) ||
      image.includes(normFilter) ||
      service.includes(normFilter) ||
      project.includes(normFilter) ||
      ports.includes(normFilter)
    );
  }

  // Step 1: Normalize all container rows
  const normalizedContainers = containers.map((c) => {
    const rawLabels = c.Labels || c.labels || "";
    const labels = typeof rawLabels === "string" ? parseContainerLabels(rawLabels) : { ...rawLabels };
    const project = labels["com.docker.compose.project"] || null;
    const service = labels["com.docker.compose.service"] || null;
    const containerNumber = parseInt(labels["com.docker.compose.container-number"] || "1", 10);
    const workingDir = labels["com.docker.compose.project.working_dir"] || null;
    const configFilesStr = labels["com.docker.compose.project.config_files"] || "";
    const configFiles = configFilesStr ? configFilesStr.split(",") : [];
    const sourceLabel = labels["herdr.docker-manager.source"] || null;
    const rawState = (c.State || c.state || "").toLowerCase();
    const rawStatus = c.Status || c.status || "";
    const running = rawState === "running" || rawStatus.toLowerCase().startsWith("up");
    const id = c.ID || c.Id || c.id || "";
    const name = (c.Names || c.names || c.Name || c.name || "").replace(/^\//, "");
    const image = c.Image || c.image || "";
    const ports = c.Ports || c.ports || "";

    return {
      id,
      shortId: id.slice(0, 12),
      name,
      image,
      ports,
      project,
      service,
      containerNumber,
      workingDir,
      configFiles,
      sourceLabel,
      state: rawState || (running ? "running" : "exited"),
      status: rawStatus,
      running,
      labels,
    };
  });

  // Step 2: Assemble Compose Projects
  const projectMap = new Map();

  // Seed projects from compose ls
  for (const item of composeLs) {
    const name = item.Name || item.name;
    if (name && !projectMap.has(name)) {
      const configFiles = (item.ConfigFiles || item.configFiles || "").split(",").filter(Boolean);
      projectMap.set(name, {
        name,
        containers: [],
        configFiles,
        workingDirs: new Set(),
        discoveredConfig: null,
      });
    }
  }

  // Seed projects from discovered compose files
  for (const disc of discoveredCompose) {
    const name = disc.project;
    if (name) {
      if (!projectMap.has(name)) {
        projectMap.set(name, {
          name,
          containers: [],
          configFiles: [disc.filePath],
          workingDirs: new Set(disc.folder ? [disc.folder] : []),
          discoveredConfig: disc,
        });
      } else {
        const p = projectMap.get(name);
        if (!p.discoveredConfig) p.discoveredConfig = disc;
        if (disc.filePath && !p.configFiles.includes(disc.filePath)) {
          p.configFiles.push(disc.filePath);
        }
        if (disc.folder) p.workingDirs.add(disc.folder);
      }
    }
  }

  // Add containers to their Compose projects
  const nonComposeContainers = [];
  for (const c of normalizedContainers) {
    if (c.project) {
      if (!projectMap.has(c.project)) {
        projectMap.set(c.project, {
          name: c.project,
          containers: [],
          configFiles: [...c.configFiles],
          workingDirs: new Set(),
          discoveredConfig: null,
        });
      }
      const p = projectMap.get(c.project);
      p.containers.push(c);
      if (c.workingDir) p.workingDirs.add(c.workingDir);
      for (const cf of c.configFiles) {
        if (!p.configFiles.includes(cf)) p.configFiles.push(cf);
      }
    } else {
      nonComposeContainers.push(c);
    }
  }

  // Build Compose Project Nodes
  const projectNodes = [];
  for (const [projName, projData] of projectMap.entries()) {
    const workingDirsList = Array.from(projData.workingDirs);
    const mixedSources = workingDirsList.length > 1; // DM-25

    // inSpace determination
    let inSpace = false;
    if (spaceRoot) {
      inSpace =
        workingDirsList.some((dir) => isPathInside(spaceRoot, dir)) ||
        projData.configFiles.some((f) => isPathInside(spaceRoot, f)) ||
        Boolean(projData.discoveredConfig && isPathInside(spaceRoot, projData.discoveredConfig.filePath));
    }

    // Scope filtering (DM-36)
    if (scope === "space" && !inSpace) {
      continue;
    }

    // Assemble services
    const serviceMap = new Map();
    for (const c of projData.containers) {
      const sName = c.service || "default";
      if (!serviceMap.has(sName)) {
        serviceMap.set(sName, []);
      }
      serviceMap.get(sName).push(c);
    }

    // Include declared services from discovered compose config (DM-24, DM-33)
    const declaredServices = projData.discoveredConfig?.config?.services || {};
    const inactiveProfilesList = [];
    const activeProfiles = projData.discoveredConfig?.activeProfiles || [];

    for (const [sName, sCfg] of Object.entries(declaredServices)) {
      const sProfiles = sCfg.profiles || [];
      const existingContainers = serviceMap.get(sName);
      const hasContainers = Array.isArray(existingContainers) && existingContainers.length > 0;
      // DM-33: a profiled service that IS running belongs in the tree, not under "profiles".
      // `activeProfiles` is not supplied by the caller, so the container check is what keeps
      // the same service from appearing twice.
      const isInactive =
        sProfiles.length > 0 &&
        !sProfiles.some((p) => activeProfiles.includes(p)) &&
        !hasContainers;

      if (isInactive) {
        inactiveProfilesList.push({
          name: sName,
          profiles: sProfiles,
          image: sCfg.image || sCfg.build || "",
          ports: sCfg.ports || [],
        });
        continue;
      }

      if (!serviceMap.has(sName)) {
        serviceMap.set(sName, []); // Service declared but not created (0 containers)
      }
    }

    // Construct service nodes
    const serviceNodes = [];
    for (const [sName, svcContainers] of serviceMap.entries()) {
      svcContainers.sort((a, b) => a.containerNumber - b.containerNumber);

      const notCreated = svcContainers.length === 0;
      const runningCount = svcContainers.filter((c) => c.running).length;
      const totalCount = svcContainers.length;

      let statusText = "not created";
      let statusColor = "dim";
      let portsText = "";

      if (!notCreated) {
        if (runningCount === totalCount && totalCount > 0) {
          statusText = svcContainers[0].status || "running";
          statusColor = "done";
        } else if (runningCount > 0) {
          statusText = `${runningCount}/${totalCount} running`;
          statusColor = "working";
        } else {
          statusText = svcContainers[0].status || "stopped";
          statusColor = "muted";
        }
        portsText = svcContainers.map((c) => c.ports).filter(Boolean).join(", ");
      } else {
        const declared = declaredServices[sName];
        if (declared && declared.ports) {
          portsText = Array.isArray(declared.ports)
            ? declared.ports.map((p) => (typeof p === "string" ? p : `${p.published}→${p.target}`)).join(", ")
            : "";
        }
      }

      serviceNodes.push({
        kind: "service",
        project: projName,
        name: sName,
        containers: svcContainers,
        notCreated,
        runningCount,
        totalCount,
        statusText,
        statusColor,
        portsText,
      });
    }

    // Sort services: declaration order if known, then alphabetical
    const declaredKeys = Object.keys(declaredServices);
    serviceNodes.sort((a, b) => {
      const idxA = declaredKeys.indexOf(a.name);
      const idxB = declaredKeys.indexOf(b.name);
      if (idxA >= 0 && idxB >= 0) return idxA - idxB;
      if (idxA >= 0) return -1;
      if (idxB >= 0) return 1;
      return a.name.localeCompare(b.name);
    });

    // Project aggregate status
    const allContainers = projData.containers;
    const runningContainersCount = allContainers.filter((c) => c.running).length;
    const totalContainersCount = allContainers.length;
    const isProjectNotCreated = totalContainersCount === 0;

    let aggregateStatus = "stopped";
    let aggregateColor = "muted";

    if (isProjectNotCreated) {
      aggregateStatus = "not-created";
      aggregateColor = "dim";
    } else if (runningContainersCount === totalContainersCount) {
      aggregateStatus = "running";
      aggregateColor = "done";
    } else if (runningContainersCount > 0) {
      aggregateStatus = "partial";
      aggregateColor = "working";
    }

    // Basenames of compose files
    const composeBasenames = projData.configFiles
      .map((f) => f.split("/").pop())
      .filter(Boolean)
      .join(", ");

    projectNodes.push({
      kind: "project",
      name: projName,
      inSpace,
      mixedSources,
      workingDirs: workingDirsList,
      configFiles: projData.configFiles,
      composeBasenames,
      runningCount: runningContainersCount,
      totalCount: totalContainersCount,
      notCreated: isProjectNotCreated,
      status: aggregateStatus,
      statusColor: aggregateColor,
      services: serviceNodes,
      inactiveProfiles: inactiveProfilesList,
    });
  }

  // Sort projects: inSpace first, then alphabetical (DM-20, DM-27)
  projectNodes.sort((a, b) => {
    if (a.inSpace !== b.inSpace) return a.inSpace ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Step 3: Dockerfile projects (DM-34)
  const dockerfileContainers = [];
  const standaloneContainers = [];

  for (const c of nonComposeContainers) {
    if (c.sourceLabel) {
      dockerfileContainers.push(c);
    } else {
      standaloneContainers.push(c);
    }
  }

  const dockerfileMap = new Map();
  // Seed with discovered Dockerfiles
  for (const df of discoveredDockerfiles) {
    const rel = df.relativePath || (spaceRoot && isPathInside(spaceRoot, df.filePath) ? df.filePath.slice(spaceRoot.replace(/\/+$/, "").length).replace(/^\//, "") : df.filePath);
    dockerfileMap.set(df.filePath, {
      filePath: df.filePath,
      relativePath: rel,
      containers: [],
    });
  }

  // Add matching containers
  for (const c of dockerfileContainers) {
    if (!dockerfileMap.has(c.sourceLabel)) {
      const rel = spaceRoot && isPathInside(spaceRoot, c.sourceLabel)
        ? c.sourceLabel.slice(spaceRoot.replace(/\/+$/, "").length).replace(/^\//, "")
        : c.sourceLabel;
      dockerfileMap.set(c.sourceLabel, {
        filePath: c.sourceLabel,
        relativePath: rel,
        containers: [],
      });
    }
    dockerfileMap.get(c.sourceLabel).containers.push(c);
  }

  const dockerfileNodes = [];
  for (const [fPath, dfData] of dockerfileMap.entries()) {
    const inSpace = spaceRoot ? isPathInside(spaceRoot, fPath) : false;
    if (scope === "space" && !inSpace) continue;

    dockerfileNodes.push({
      kind: "dockerfile",
      filePath: fPath,
      relativePath: dfData.relativePath,
      inSpace,
      containers: dfData.containers,
      runningCount: dfData.containers.filter((c) => c.running).length,
      totalCount: dfData.containers.length,
    });
  }

  // Step 4: Standalone Containers (DM-20, DM-36)
  let visibleStandalone = [];
  if (scope !== "space") {
    visibleStandalone = standaloneContainers.map((c) => ({
      kind: "standalone",
      id: c.id,
      shortId: c.shortId,
      name: c.name,
      image: c.image,
      ports: c.ports,
      status: c.status,
      running: c.running,
      statusColor: c.running ? "done" : "muted",
    }));
  }

  // Step 5: Filter handling (DM-12)
  let filteredProjects = projectNodes;
  let filteredDockerfiles = dockerfileNodes;
  let filteredStandalone = visibleStandalone;

  if (normFilter) {
    filteredProjects = [];
    for (const p of projectNodes) {
      const pMatches = p.name.toLowerCase().includes(normFilter) || p.composeBasenames.toLowerCase().includes(normFilter);
      const matchingServices = [];
      for (const s of p.services) {
        const sMatches = s.name.toLowerCase().includes(normFilter) || s.portsText.toLowerCase().includes(normFilter);
        const matchingContainers = s.containers.filter(containerMatchesFilter);
        if (pMatches || sMatches || matchingContainers.length > 0) {
          matchingServices.push({
            ...s,
            containers: pMatches || sMatches ? s.containers : matchingContainers,
          });
        }
      }
      if (pMatches || matchingServices.length > 0) {
        filteredProjects.push({
          ...p,
          services: pMatches ? p.services : matchingServices,
        });
      }
    }

    filteredDockerfiles = dockerfileNodes.filter((df) => {
      const dfMatches = df.relativePath.toLowerCase().includes(normFilter);
      const cMatches = df.containers.some(containerMatchesFilter);
      return dfMatches || cMatches;
    });

    filteredStandalone = visibleStandalone.filter(containerMatchesFilter);
  }

  // Return root groups (empty groups hidden per DM-20)
  const result = [];
  if (filteredProjects.length > 0) {
    result.push({
      kind: "group",
      id: "projects",
      title: "Compose Projects",
      items: filteredProjects,
    });
  }
  if (filteredDockerfiles.length > 0) {
    result.push({
      kind: "group",
      id: "dockerfiles",
      title: "Dockerfiles",
      items: filteredDockerfiles,
    });
  }
  if (filteredStandalone.length > 0) {
    result.push({
      kind: "group",
      id: "standalone",
      title: "Standalone",
      items: filteredStandalone,
    });
  }

  return result;
}

/**
 * Returns the ordered list of context menu items for a Compose project (DM-50..59).
 * Each item has: { id, label, icon, enabled, disabledReason, destructive, requiresTypedConfirm }
 *
 * @param {object} project
 * @returns {Array<object>}
 */
export function getProjectMenuItems(project) {
  if (!project) return [];
  const hasConfigFiles = Array.isArray(project.configFiles) && project.configFiles.length > 0;
  const hasWorkingDir = Array.isArray(project.workingDirs) && project.workingDirs.length > 0;
  const isRunning = (project.runningCount ?? 0) > 0;
  const isAllRunning = project.totalCount > 0 && project.runningCount === project.totalCount;
  const isNotCreated = Boolean(project.notCreated) || project.totalCount === 0;

  return [
    {
      id: "up",
      label: "Up",
      icon: "play.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "up-build",
      label: "Up (build)",
      icon: "rebuild.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "start",
      label: "Start",
      icon: "play.svg",
      enabled: !isNotCreated && !isAllRunning,
      disabledReason: isNotCreated ? "no containers created" : isAllRunning ? "already running" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "stop",
      label: "Stop",
      icon: "stop.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "already stopped",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "restart",
      label: "Restart",
      icon: "restart.svg",
      enabled: !isNotCreated,
      disabledReason: isNotCreated ? "no containers created" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "pull",
      label: "Pull images",
      icon: "refresh.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "build",
      label: "Build",
      icon: "rebuild.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "logs",
      label: "Logs (all services)",
      icon: "logs.svg",
      enabled: !isNotCreated,
      disabledReason: isNotCreated ? "no containers created" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "open-compose",
      label: "Open compose file(s)",
      icon: "folder.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "copy-name",
      label: "Copy project name",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "reveal-folder",
      label: "Reveal folder in Files",
      icon: "folder.svg",
      enabled: hasWorkingDir,
      disabledReason: hasWorkingDir ? null : "working directory not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "down",
      label: "Down",
      icon: "stop.svg",
      enabled: !isNotCreated,
      disabledReason: isNotCreated ? "no containers created" : null,
      destructive: true,
      requiresTypedConfirm: false,
    },
    {
      id: "down-volumes",
      label: "Down + remove volumes",
      icon: "trash.svg",
      enabled: !isNotCreated,
      disabledReason: isNotCreated ? "no containers created" : null,
      destructive: true,
      requiresTypedConfirm: true,
    },
  ];
}

/**
 * Returns the ordered list of context menu items for a service (DM-60..69).
 *
 * @param {object} service
 * @param {object} [project]
 * @returns {Array<object>}
 */
export function getServiceMenuItems(service, project = null) {
  if (!service) return [];
  const hasConfigFiles = project ? Array.isArray(project.configFiles) && project.configFiles.length > 0 : true;
  const isRunning = (service.runningCount ?? 0) > 0;
  const isAllRunning = service.totalCount > 0 && service.runningCount === service.totalCount;
  const notCreated = Boolean(service.notCreated);
  const containerId = service.containers && service.containers.length > 0 ? service.containers[0].id : service.id;

  const items = [
    {
      id: "start",
      label: "Start",
      icon: "play.svg",
      enabled: !notCreated && !isAllRunning,
      disabledReason: notCreated ? "not created" : isAllRunning ? "already running" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "stop",
      label: "Stop",
      icon: "stop.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "already stopped",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "restart",
      label: "Restart",
      icon: "restart.svg",
      enabled: !notCreated,
      disabledReason: notCreated ? "not created" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "up",
      label: "Up (this service)",
      icon: "play.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "rebuild",
      label: "Rebuild",
      icon: "rebuild.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "recreate",
      label: "Recreate (no build)",
      icon: "restart.svg",
      enabled: hasConfigFiles,
      disabledReason: hasConfigFiles ? null : "compose file not found",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "logs",
      label: "Logs",
      icon: "logs.svg",
      enabled: !notCreated,
      disabledReason: notCreated ? "not created" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "shell",
      label: "Shell",
      icon: "terminal.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "container not running",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "inspect",
      label: "Inspect",
      icon: "search.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "inspect-tab",
      label: "Open in Inspector Tab",
      icon: "expand.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
  ];

  // Published ports
  const portsList = [];
  if (service.containers && service.containers.length > 0) {
    for (const c of service.containers) {
      if (c.ports) {
        const matches = c.ports.matchAll(/(?:(?:\d{1,3}\.){3}\d{1,3}|::|\[::\])?:(\d+)->/g);
        for (const m of matches) {
          const port = parseInt(m[1], 10);
          if (port && !portsList.includes(port)) portsList.push(port);
        }
      }
    }
  }
  for (const port of portsList) {
    items.push({
      id: `open-port:${port}`,
      port,
      label: `Open :${port} in browser`,
      icon: "external-link.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "container not running",
      destructive: false,
      requiresTypedConfirm: false,
    });
  }

  items.push(
    {
      id: "copy-name",
      label: "Copy service name",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "copy-id",
      label: "Copy container ID",
      icon: "copy.svg",
      enabled: Boolean(containerId),
      disabledReason: containerId ? null : "no container created",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "remove",
      label: "Remove",
      icon: "trash.svg",
      enabled: !notCreated,
      disabledReason: notCreated ? "not created" : null,
      destructive: true,
      requiresTypedConfirm: false,
    }
  );

  return items;
}

/**
 * Returns the ordered list of context menu items for a container (DM-70..73).
 *
 * @param {object} container
 * @returns {Array<object>}
 */
export function getContainerMenuItems(container) {
  if (!container) return [];
  const isRunning = Boolean(container.running);
  const isPaused =
    (container.state || "").toLowerCase() === "paused" ||
    (container.status || "").toLowerCase().includes("paused");
  const id = container.id || container.shortId;

  const items = [
    {
      id: "start",
      label: "Start",
      icon: "play.svg",
      enabled: !isRunning,
      disabledReason: isRunning ? "already running" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "stop",
      label: "Stop",
      icon: "stop.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "already stopped",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "restart",
      label: "Restart",
      icon: "restart.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "pause",
      label: "Pause",
      icon: "stop.svg",
      enabled: isRunning && !isPaused,
      disabledReason: !isRunning ? "container not running" : isPaused ? "already paused" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "unpause",
      label: "Unpause",
      icon: "play.svg",
      enabled: isRunning && isPaused,
      disabledReason: !isRunning ? "container not running" : !isPaused ? "container not paused" : null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "logs",
      label: "Logs",
      icon: "logs.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "shell",
      label: "Shell",
      icon: "terminal.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "container not running",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "inspect",
      label: "Inspect",
      icon: "search.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "inspect-tab",
      label: "Open in Inspector Tab",
      icon: "expand.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
  ];

  // Published ports
  const portsList = [];
  if (container.ports) {
    const matches = container.ports.matchAll(/(?:(?:\d{1,3}\.){3}\d{1,3}|::|\[::\])?:(\d+)->/g);
    for (const m of matches) {
      const port = parseInt(m[1], 10);
      if (port && !portsList.includes(port)) portsList.push(port);
    }
  }
  for (const port of portsList) {
    items.push({
      id: `open-port:${port}`,
      port,
      label: `Open :${port} in browser`,
      icon: "external-link.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "container not running",
      destructive: false,
      requiresTypedConfirm: false,
    });
  }

  items.push(
    {
      id: "copy-name",
      label: "Copy container name",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "copy-id",
      label: "Copy container ID",
      icon: "copy.svg",
      enabled: Boolean(id),
      disabledReason: id ? null : "no container ID",
      destructive: false,
      requiresTypedConfirm: false,
    },
    {
      id: "kill",
      label: "Kill",
      icon: "stop.svg",
      enabled: isRunning,
      disabledReason: isRunning ? null : "container not running",
      destructive: true,
      requiresTypedConfirm: false,
    },
    {
      id: "remove",
      label: "Remove",
      icon: "trash.svg",
      enabled: true,
      disabledReason: null,
      destructive: true,
      requiresTypedConfirm: false,
    }
  );

  return items;
}

/**
 * Builds confirmation dialog spec for destructive actions (DM-85..86).
 *
 * @param {string} action
 * @param {object} target
 * @returns {{ title: string, message: string, confirmLabel: string, destructive: boolean, typedTarget: string | null }}
 */
export function buildConfirmationSpec(action, target) {
  // A destructive dialog with a null spec renders `undefined` title/message and leaves the
  // confirm button live (no typed gate). Never return null: fall back to a generic target name.
  const fallbackNames = {
    "prune-networks": "all unused networks",
    "prune-dangling-images": "dangling images",
    "prune-unused-images": "all unused images",
    "prune-volumes": "all unused volumes",
    "prune-containers": "all stopped containers",
    "prune-build-cache": "the build cache",
    "prune-granular": "the selected resources",
  };
  if (!target) {
    target = { name: fallbackNames[action] || "this resource" };
  }
  const targetName = target.name || target.shortId || target.id || "target";

  if (action === "down") {
    return {
      title: "Down Project",
      message: `Stops and removes all containers and networks for Compose project "${targetName}".`,
      confirmLabel: "Down Project",
      destructive: true,
      typedTarget: null,
    };
  }

  if (action === "down-volumes") {
    return {
      title: "Down and Remove Volumes",
      message: `Permanently stops and removes all containers, networks, AND named volumes for project "${targetName}". All persisted data will be lost.`,
      confirmLabel: "Remove Everything",
      destructive: true,
      typedTarget: targetName,
    };
  }

  if (action === "remove") {
    const isService = target.kind === "service" || (target.project && target.name);
    return {
      title: isService ? "Remove Service" : "Remove Container",
      message: isService
        ? `Stops and removes all containers for service "${targetName}".`
        : `Permanently removes container "${targetName}".`,
      confirmLabel: "Remove",
      destructive: true,
      typedTarget: null,
    };
  }

  if (action === "kill") {
    return {
      title: "Kill Container",
      message: `Forces immediate SIGKILL termination of container "${targetName}".`,
      confirmLabel: "Kill",
      destructive: true,
      typedTarget: null,
    };
  }

  if (action === "remove-image") {
    return {
      title: "Remove Image",
      message: `Permanently removes Docker image "${targetName}".`,
      confirmLabel: "Remove",
      destructive: true,
      typedTarget: null,
    };
  }

  if (action === "remove-volume" || action === "volume-rm") {
    return {
      title: "Remove Volume",
      message: `Permanently removes volume "${targetName}". All data stored in this volume will be permanently lost.`,
      confirmLabel: "Remove Volume",
      destructive: true,
      typedTarget: targetName,
    };
  }

  if (action === "restore-volume") {
    return {
      title: "Restore Volume",
      message: `Restoring volume "${targetName}" will overwrite all existing data in this volume.`,
      confirmLabel: "Restore Data",
      destructive: true,
      typedTarget: targetName,
    };
  }

  if (action === "remove-network") {
    return {
      title: "Remove Network",
      message: `Permanently removes Docker network "${targetName}".`,
      confirmLabel: "Remove Network",
      destructive: true,
      typedTarget: null,
    };
  }

  if (action === "prune-unused-images") {
    return {
      title: "Prune All Unused Images",
      message: "Permanently removes ALL images not referenced by at least one existing container.",
      confirmLabel: "Prune Images",
      destructive: true,
      typedTarget: "prune",
    };
  }

  if (action === "prune-volumes") {
    return {
      title: "Prune Unused Volumes",
      message: "Permanently removes ALL local volumes not used by at least one existing container.",
      confirmLabel: "Prune Volumes",
      destructive: true,
      typedTarget: "prune",
    };
  }

  if (action === "prune-granular") {
    return {
      title: "Prune Selected Resources",
      message: target.message || "Permanently removes selected Docker resources according to your prune selection.",
      confirmLabel: "Prune Selected",
      destructive: true,
      typedTarget: target.requiresTypedConfirm ? "prune" : null,
    };
  }

  return {
    title: "Confirm Action",
    message: `Are you sure you want to proceed with "${action}" on ${targetName}?`,
    confirmLabel: "Confirm",
    destructive: true,
    typedTarget: null,
  };
}

/**
 * Finds an existing live terminal in spaceId matching terminalName (DM-82).
 *
 * @param {Array<object> | Function} terminalsList
 * @param {string | null} spaceId
 * @param {string} terminalName
 * @returns {object | null}
 */
export function findExistingActionTerminal(terminalsList, spaceId, terminalName) {
  if (!terminalName) return null;
  const list = typeof terminalsList === "function" ? terminalsList() : terminalsList || [];
  return (
    list.find((t) => {
      if (spaceId && t.space && t.space !== spaceId) return false;
      return t.name === terminalName || t.title === terminalName;
    }) || null
  );
}

/**
 * Clamps context menu position inside panel dimensions (DESIGN §5.4).
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [menuWidth=220]
 * @param {number} [menuHeight=260]
 * @param {number} [panelWidth=368]
 * @param {number} [panelHeight=600]
 * @returns {{ x: number, y: number }}
 */
export function clampMenuPosition(
  x,
  y,
  menuWidth = 220,
  menuHeight = 260,
  panelWidth = 368,
  panelHeight = 600
) {
  const pad = 8;
  const maxW = Math.max(menuWidth + pad * 2, panelWidth || 368);
  const maxH = Math.max(menuHeight + pad * 2, panelHeight || 600);

  let posX = x;
  if (posX + menuWidth > maxW - pad) {
    if (posX - menuWidth >= pad) {
      posX = posX - menuWidth;
    } else {
      posX = Math.max(pad, maxW - menuWidth - pad);
    }
  } else {
    posX = Math.max(pad, posX);
  }

  let posY = y;
  if (posY + menuHeight > maxH - pad) {
    if (posY - menuHeight >= pad) {
      posY = posY - menuHeight;
    } else {
      posY = Math.max(pad, maxH - menuHeight - pad);
    }
  } else {
    posY = Math.max(pad, posY);
  }

  return { x: Math.round(posX), y: Math.round(posY) };
}

/**
 * Resolves the panel-local position for a right-click menu from a bubbled
 * panel-root event. The file-editor fix for the same problem: `local_position`
 * is pane-relative while `position` is window-relative, and GPUI reports both
 * in zoomed pixels; divide by the window zoom and clamp/flip inside the pane.
 *
 * @param {{
 *   bounds?: {x:number,y:number,width:number,height:number} | null,
 *   event?: {position?: {x:number,y:number}, bounds?: object} | null,
 *   localPosition?: {x:number,y:number} | null,
 *   zoom?: number,
 *   menuWidth?: number,
 *   menuHeight?: number,
 *   defaultX?: number,
 *   defaultY?: number,
 * }} [input]
 * @returns {{x: number, y: number}}
 */
export function resolveDockerMenuPosition({
  bounds = null,
  event = null,
  localPosition = null,
  zoom = 1,
  menuWidth = 220,
  menuHeight = 260,
  defaultX = 120,
  defaultY = 120,
} = {}) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const margin = 8;
  const paneBounds = bounds || event?.bounds || null;
  const paneX = Number.isFinite(paneBounds?.x) ? paneBounds.x : 0;
  const paneY = Number.isFinite(paneBounds?.y) ? paneBounds.y : 0;
  const paneW = Number.isFinite(paneBounds?.width) && paneBounds.width > 0 ? paneBounds.width / scale : 0;
  const paneH = Number.isFinite(paneBounds?.height) && paneBounds.height > 0 ? paneBounds.height / scale : 0;

  let x =
    typeof localPosition?.x === "number"
      ? localPosition.x / scale
      : typeof event?.position?.x === "number"
        ? (event.position.x - paneX) / scale
        : defaultX;
  let y =
    typeof localPosition?.y === "number"
      ? localPosition.y / scale
      : typeof event?.position?.y === "number"
        ? (event.position.y - paneY) / scale
        : defaultY;

  // Raw window coordinates leaking into the pane would clamp to the far edge;
  // use the default near the top-left instead.
  if (paneW && (x < -margin || x > paneW + margin)) x = defaultX;
  if (paneH && (y < -margin || y > paneH + margin)) y = defaultY;

  if (paneW) {
    if (x + menuWidth > paneW - margin) {
      const flipped = x - menuWidth;
      x = flipped >= margin ? flipped : Math.max(margin, paneW - menuWidth - margin);
    }
    x = Math.max(margin, Math.min(x, Math.max(margin, paneW - margin - menuWidth)));
  }
  if (paneH) {
    if (y + menuHeight > paneH - margin) {
      const flipped = y - menuHeight;
      y = flipped >= margin ? flipped : Math.max(margin, paneH - menuHeight - margin);
    }
    y = Math.max(margin, Math.min(y, Math.max(margin, paneH - margin - menuHeight)));
  }

  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Groups discovered Compose files by folder and pairs overrides (DM-30..32, DESIGN §4.2).
 *
 * @param {string[]} filePaths
 * @returns {Array<{ folder: string, files: string[], primaryFile: string, overrideFile: string | null, isOverride: boolean, isVariant: boolean, name: string }>}
 */
export function groupDiscoveredComposeFiles(filePaths = []) {
  if (!Array.isArray(filePaths)) return [];

  const byFolder = new Map();
  for (const fp of filePaths) {
    if (!fp || typeof fp !== "string") continue;
    const cleanPath = fp.trim();
    if (!cleanPath) continue;
    const lastSlash = cleanPath.lastIndexOf("/");
    const folder = lastSlash > 0 ? cleanPath.slice(0, lastSlash) : (lastSlash === 0 ? "/" : ".");
    if (!byFolder.has(folder)) {
      byFolder.set(folder, []);
    }
    byFolder.get(folder).push(cleanPath);
  }

  const PRIMARY_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  const OVERRIDE_NAMES = ["compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"];

  const results = [];

  for (const [folder, files] of byFolder.entries()) {
    const folderBase = folder.split("/").pop() || "project";

    let primary = null;
    for (const pName of PRIMARY_NAMES) {
      const match = files.find((f) => f.split("/").pop() === pName);
      if (match) {
        primary = match;
        break;
      }
    }

    let override = null;
    for (const oName of OVERRIDE_NAMES) {
      const match = files.find((f) => f.split("/").pop() === oName);
      if (match) {
        override = match;
        break;
      }
    }

    const handled = new Set();

    if (primary && override) {
      handled.add(primary);
      handled.add(override);
      results.push({
        folder,
        files: [primary, override],
        primaryFile: primary,
        overrideFile: override,
        isOverride: true,
        isVariant: false,
        name: folderBase,
      });
    } else if (primary) {
      handled.add(primary);
      results.push({
        folder,
        files: [primary],
        primaryFile: primary,
        overrideFile: null,
        isOverride: false,
        isVariant: false,
        name: folderBase,
      });
    } else if (override) {
      handled.add(override);
      results.push({
        folder,
        files: [override],
        primaryFile: override,
        overrideFile: null,
        isOverride: true,
        isVariant: false,
        name: folderBase,
      });
    }

    // Process remaining files (variants like compose.dev.yaml, or other compose files)
    for (const f of files) {
      if (handled.has(f)) continue;
      handled.add(f);

      const base = f.split("/").pop();
      const isVariant = /^(?:docker-)?compose\.[^.]+\.ya?ml$/i.test(base);
      const variantNameMatch = base.match(/^(?:docker-)?compose\.([^.]+)\.ya?ml$/i);
      const variantSuffix = variantNameMatch ? ` (${variantNameMatch[1]})` : "";

      results.push({
        folder,
        files: [f],
        primaryFile: f,
        overrideFile: null,
        isOverride: false,
        isVariant,
        name: `${folderBase}${variantSuffix}`,
      });
    }
  }

  return results;
}

/**
 * Parses output of `docker compose config --format json` (DM-30..33).
 *
 * @param {string} stdout
 * @returns {{ projectName: string, services: Record<string, { name: string, image: string | null, build: any, ports: any[], volumes: any[], networks: any, profiles: string[], environment: any, dependsOn: string[] }> }}
 */
export function parseComposeConfigJson(stdout) {
  if (!stdout || typeof stdout !== "string") {
    return { projectName: "", services: {} };
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { projectName: "", services: {} };
  }

  if (!data || typeof data !== "object") {
    return { projectName: "", services: {} };
  }

  const projectName = typeof data.name === "string" ? data.name : "";
  const rawServices = data.services && typeof data.services === "object" ? data.services : {};
  const services = {};

  for (const [sName, sDef] of Object.entries(rawServices)) {
    if (!sDef || typeof sDef !== "object") continue;
    services[sName] = {
      name: sName,
      image: sDef.image || null,
      build: sDef.build || null,
      ports: Array.isArray(sDef.ports) ? sDef.ports : [],
      volumes: Array.isArray(sDef.volumes) ? sDef.volumes : [],
      networks: sDef.networks || null,
      profiles: Array.isArray(sDef.profiles) ? sDef.profiles : [],
      environment: sDef.environment || {},
      dependsOn: sDef.depends_on
        ? (Array.isArray(sDef.depends_on) ? sDef.depends_on : Object.keys(sDef.depends_on))
        : [],
    };
  }

  return { projectName, services };
}

/**
 * Parses exposed ports from Dockerfile content (DM-76).
 * E.g. "EXPOSE 8080 3000/tcp\nEXPOSE 4321/udp" -> ["8080", "3000", "4321"]
 *
 * @param {string} dockerfileText
 * @returns {string[]}
 */
export function parseDockerfileExpose(dockerfileText) {
  if (!dockerfileText || typeof dockerfileText !== "string") return [];

  const lines = dockerfileText.split(/\r?\n/);
  const ports = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^EXPOSE\s+(.+)$/i);
    if (!match) continue;

    const tokens = match[1].split(/\s+/);
    for (let token of tokens) {
      token = token.trim();
      if (!token || token.startsWith("#")) break;
      const slashIdx = token.indexOf("/");
      const portStr = slashIdx >= 0 ? token.slice(0, slashIdx) : token;
      const portNum = parseInt(portStr, 10);
      if (Number.isInteger(portNum) && portNum > 0 && portNum <= 65535) {
        const strVal = String(portNum);
        if (!ports.includes(strVal)) {
          ports.push(strVal);
        }
      }
    }
  }

  return ports;
}

/**
 * Returns context menu items for a Dockerfile row (DM-75..78).
 *
 * @param {object} dockerfileItem
 * @param {object | null} lastRunConfig
 * @returns {Array<{ id: string, label: string, icon: string, enabled: boolean, disabledReason?: string | null, destructive: boolean }>}
 */
export function getDockerfileMenuItems(dockerfileItem, lastRunConfig = null) {
  const hasPriorRun = Boolean(lastRunConfig);
  return [
    { id: "build-image", label: "Build image…", icon: "hammer.svg", enabled: true, destructive: false },
    { id: "build-run", label: "Build & run…", icon: "play.svg", enabled: true, destructive: false },
    {
      id: "rebuild-replace",
      label: "Rebuild & replace",
      icon: "refresh.svg",
      enabled: hasPriorRun,
      disabledReason: hasPriorRun ? null : "no prior Build & run",
      destructive: false,
    },
    { id: "open-dockerfile", label: "Open Dockerfile", icon: "folder.svg", enabled: true, destructive: false },
    { id: "copy-path", label: "Copy path", icon: "copy.svg", enabled: true, destructive: false },
  ];
}

/**
 * Builds arguments for building a Dockerfile (DM-75).
 * Returns ["build", "-t", tag, "-f", filePath, ...buildArgFlags, contextDir].
 *
 * @param {object} params
 * @param {string} params.filePath
 * @param {string} [params.contextDir]
 * @param {string} params.tag
 * @param {string[] | Record<string, string>} [params.buildArgs]
 * @returns {string[]}
 */
export function buildDockerfileBuildArgs({ filePath, contextDir = null, tag, buildArgs = null } = {}) {
  if (!filePath) throw new Error("filePath is required");
  if (!tag) throw new Error("tag is required");

  const lastSlash = filePath.lastIndexOf("/");
  const defaultContext = lastSlash > 0 ? filePath.slice(0, lastSlash) : (lastSlash === 0 ? "/" : ".");
  const ctx = contextDir || defaultContext;

  const buildArgFlags = [];
  if (Array.isArray(buildArgs)) {
    for (const ba of buildArgs) {
      if (ba) buildArgFlags.push("--build-arg", String(ba));
    }
  } else if (buildArgs && typeof buildArgs === "object") {
    for (const [k, v] of Object.entries(buildArgs)) {
      buildArgFlags.push("--build-arg", `${k}=${v}`);
    }
  }

  return ["build", "-t", tag, "-f", filePath, ...buildArgFlags, ctx];
}

/**
 * Builds arguments for running a container from a Dockerfile image (DM-76).
 * Returns ["run", ...(detached ? ["-d"] : ["--rm"]), "--name", containerName, "--label", `herdr.docker-manager.source=${filePath}`, ...portFlags, ...envFileFlags, tag].
 *
 * @param {object} params
 * @param {string} params.filePath
 * @param {string} params.tag
 * @param {string} params.containerName
 * @param {string[] | string} [params.ports]
 * @param {string} [params.envFile]
 * @param {boolean} [params.detached=true]
 * @returns {string[]}
 */
export function buildDockerfileRunArgs({ filePath, tag, containerName, ports = [], envFile = null, detached = true } = {}) {
  if (!filePath) throw new Error("filePath is required");
  if (!tag) throw new Error("tag is required");
  if (!containerName) throw new Error("containerName is required");

  validateDockerIdentifier(containerName, "container name");

  const portFlags = [];
  const portsList = Array.isArray(ports) ? ports : (ports ? [ports] : []);
  for (const p of portsList) {
    if (p) portFlags.push("-p", String(p));
  }

  const envFileFlags = [];
  if (envFile) {
    envFileFlags.push("--env-file", envFile);
  }

  return [
    "run",
    ...(detached ? ["-d"] : ["--rm"]),
    "--name",
    containerName,
    "--label",
    `herdr.docker-manager.source=${filePath}`,
    ...portFlags,
    ...envFileFlags,
    tag,
  ];
}

/**
 * Re-resolves the latest container ID for (project, service) when containers recreate/rebuild (DM-46).
 *
 * @param {Array<object>} containers
 * @param {string} project
 * @param {string} service
 * @param {string} fallbackId
 * @returns {string}
 */
export function resolveServiceContainerId(containers = [], project, service, fallbackId) {
  if (!Array.isArray(containers) || !project || !service) {
    return fallbackId;
  }

  const matches = containers.filter((c) => {
    const cProj = c.project || c.composeProject || c.labels?.["com.docker.compose.project"];
    const cSvc = c.service || c.composeService || c.labels?.["com.docker.compose.service"];
    return cProj === project && cSvc === service;
  });

  if (matches.length === 0) return fallbackId;

  const running = matches.find((c) => {
    const rawState = (c.State || c.state || "").toLowerCase();
    const rawStatus = (c.Status || c.status || "").toLowerCase();
    return c.running || rawState === "running" || rawStatus.startsWith("up");
  });

  const target = running || matches[0];
  return target.id || target.Id || target.ID || fallbackId;
}

/**
 * Matches cross-mod request { action, kind, file, folder } to the corresponding project or Dockerfile in the tree (DM-93, INTEGRATION §3.4).
 *
 * @param {{ action?: string, kind?: string, file?: string, folder?: string }} request
 * @param {Array<object> | { composeProjects: object[], dockerfiles: object[] }} tree
 * @returns {{ type: "project" | "dockerfile", target: object } | null}
 */
export function matchDockerRequestTarget(request, tree) {
  if (!request || !tree) return null;

  // buildContainerTree returns group nodes ({kind:"group", items:[...]}); accept both that and
  // a flat array, otherwise every cross-mod reveal resolves to nothing (DM-93 / INTEGRATION §3.4).
  const flat = Array.isArray(tree)
    ? tree.flatMap((n) =>
        n && n.kind === "group" && Array.isArray(n.items) ? n.items : (n ? [n] : [])
      )
    : [];
  const projects = Array.isArray(tree) ? flat.filter((n) => n && n.kind === "project") : (tree.composeProjects || []);
  const dockerfiles = Array.isArray(tree) ? flat.filter((n) => n && n.kind === "dockerfile") : (tree.dockerfiles || []);

  const reqFile = request.file || "";
  const reqFolder = request.folder || "";
  const reqKind = request.kind || "";

  if (reqKind === "compose" || classifyDockerFile(reqFile) === "compose") {
    for (const p of projects) {
      if (reqFile && p.configFiles && p.configFiles.includes(reqFile)) {
        return { type: "project", target: p };
      }
      if (reqFolder && p.workingDirs && p.workingDirs.includes(reqFolder)) {
        return { type: "project", target: p };
      }
      if (reqFolder && p.folder === reqFolder) {
        return { type: "project", target: p };
      }
      // Only match basename if reqFile does not contain directory slashes
      if (reqFile && !reqFile.includes("/") && p.composeBasenames && p.composeBasenames.includes(reqFile)) {
        return { type: "project", target: p };
      }
    }
  }

  if (reqKind === "dockerfile" || classifyDockerFile(reqFile) === "dockerfile") {
    for (const df of dockerfiles) {
      if (reqFile && (df.filePath === reqFile || df.relativePath === reqFile)) {
        return { type: "dockerfile", target: df };
      }
      if (reqFolder && df.filePath && isPathInside(reqFolder, df.filePath)) {
        return { type: "dockerfile", target: df };
      }
    }
  }

  for (const p of projects) {
    if (reqFile && p.configFiles && p.configFiles.includes(reqFile)) {
      return { type: "project", target: p };
    }
  }
  for (const df of dockerfiles) {
    if (reqFile && (df.filePath === reqFile || df.relativePath === reqFile)) {
      return { type: "dockerfile", target: df };
    }
  }

  return null;
}

/**
 * Parses Docker human-readable size strings (e.g. "1.24GB", "45.2MB", "812kB", "0B") into numeric bytes (DM-100, DM-120).
 *
 * @param {string | number} sizeStr
 * @returns {number}
 */
export function parseDockerSizeBytes(sizeStr) {
  if (typeof sizeStr === "number") return sizeStr;
  if (!sizeStr || typeof sizeStr !== "string") return 0;
  const match = sizeStr.trim().match(/^([0-9.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return 0;
  const unit = (match[2] || "B").toLowerCase();
  const multipliers = {
    b: 1,
    k: 1000,
    kb: 1000,
    kib: 1024,
    m: 1000 * 1000,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    g: 1000 * 1000 * 1000,
    gb: 1000 * 1000 * 1000,
    gib: 1024 * 1024 * 1024,
    t: 1000 * 1000 * 1000 * 1000,
    tb: 1000 * 1000 * 1000 * 1000,
    tib: 1024 * 1024 * 1024 * 1024,
    p: 1000 * 1000 * 1000 * 1000 * 1000,
    pb: 1000 * 1000 * 1000 * 1000 * 1000,
  };
  return Math.round(num * (multipliers[unit] ?? 1));
}

/**
 * Returns true when volumeName is a 64-character lowercase/uppercase hex string (DM-105).
 *
 * @param {string} volumeName
 * @returns {boolean}
 */
export function isAnonymousVolume(volumeName) {
  if (!volumeName || typeof volumeName !== "string") return false;
  return /^[0-9a-f]{64}$/i.test(volumeName.trim());
}

/**
 * Builds the image tree view, cross-referencing containers to detect usage and separating dangling images (DM-100).
 *
 * @param {Array<object>} imagesRaw
 * @param {Array<object>} containersRaw
 * @param {{ filter?: string, sortBy?: "name" | "size" | "created" }} options
 * @returns {{ images: Array<object>, dangling: Array<object>, totalCount: number, inUseCount: number }}
 */
export function buildImageTree(imagesRaw = [], containersRaw = [], { filter = "", sortBy = "name" } = {}) {
  const imagesList = Array.isArray(imagesRaw) ? imagesRaw : [];
  const containersList = Array.isArray(containersRaw) ? containersRaw : [];

  const processed = [];

  for (const img of imagesList) {
    if (!img || typeof img !== "object") continue;
    const repo = img.Repository || img.repository || img.repo || "";
    const tag = img.Tag || img.tag || "";
    const id = img.ID || img.Id || img.id || "";
    const shortId = id.replace(/^sha256:/, "").slice(0, 12);
    const size = img.Size || img.size || "0B";
    const sizeBytes = parseDockerSizeBytes(size);
    const created = img.CreatedAt || img.CreatedSince || img.created || "";
    const isDangling = repo === "<none>" || tag === "<none>" || !repo || img.dangling === true;
    const name = isDangling ? (repo === "<none>" ? `<none>:${tag}` : shortId) : `${repo}:${tag}`;

    // Cross-reference containers
    const using = [];
    for (const c of containersList) {
      if (!c || typeof c !== "object") continue;
      const cName = (c.Names || c.Name || c.name || c.id || "").replace(/^\//, "");
      const cRunning = Boolean(
        c.running ||
        (c.State || c.state || "").toLowerCase() === "running" ||
        (c.Status || c.status || "").toLowerCase().startsWith("up")
      );
      const cImg = c.Image || c.image || "";
      const cImgId = c.ImageID || c.imageId || "";

      // `docker container ls --format '{{json .}}'` has no ImageID, so the id branch alone never
      // matched and Remove stayed enabled for images a container is using. Compare the plain sha
      // as well, and treat a digest-pinned reference to the same repo as a match.
      const idPlain = String(id).replace(/^sha256:/, "");
      const cImgPlain = String(cImg).replace(/^sha256:/, "");
      let matched = false;
      if (cImg && (cImg === name || cImg === repo || cImg === `${repo}:${tag}`)) {
        matched = true;
      } else if (idPlain && cImgPlain && (cImgPlain === idPlain || cImgPlain.startsWith(idPlain.slice(0, 12)))) {
        matched = true;
      } else if (repo && cImg.includes(`${repo}@`)) {
        matched = true;
      } else if (id && cImgId && (cImgId === id || cImgId.startsWith(id) || id.startsWith(cImgId))) {
        matched = true;
      }

      if (matched) {
        using.push({
          id: c.id || c.ID || cName,
          name: cName,
          running: cRunning,
        });
      }
    }

    const inUse = using.length > 0;
    const usedByRunningContainer = using.some((u) => u.running);

    // Filter matching
    if (filter) {
      const q = filter.trim().toLowerCase();
      const textMatch =
        name.toLowerCase().includes(q) ||
        repo.toLowerCase().includes(q) ||
        tag.toLowerCase().includes(q) ||
        id.toLowerCase().includes(q) ||
        shortId.toLowerCase().includes(q);
      if (!textMatch) continue;
    }

    processed.push({
      id,
      shortId,
      repository: repo,
      tag,
      name,
      size,
      sizeBytes,
      created,
      dangling: isDangling,
      inUse,
      usedByRunningContainer,
      usedByContainers: using,
      labels: parseContainerLabels(img.Labels || img.labels),
      raw: img,
    });
  }

  // Split into tagged vs dangling
  const taggedList = processed.filter((i) => !i.dangling);
  const danglingList = processed.filter((i) => i.dangling);

  // Sort
  const sortFn = (a, b) => {
    if (sortBy === "size") {
      return b.sizeBytes - a.sizeBytes;
    }
    if (sortBy === "created") {
      return (b.created || "").localeCompare(a.created || "");
    }
    return (a.name || "").localeCompare(b.name || "");
  };

  taggedList.sort(sortFn);
  danglingList.sort(sortFn);

  const totalCount = taggedList.length + danglingList.length;
  const inUseCount = taggedList.filter((i) => i.inUse).length + danglingList.filter((i) => i.inUse).length;

  return {
    images: taggedList,
    dangling: danglingList,
    totalCount,
    inUseCount,
  };
}

/**
 * Returns context menu items for an image (DM-101).
 *
 * @param {object} image
 * @returns {Array<object>}
 */
export function getImageMenuItems(image) {
  if (!image) return [];
  const isDangling = Boolean(image.dangling);
  const usedByRunning = Boolean(image.usedByRunningContainer);

  return [
    {
      id: "run-image",
      label: "Run…",
      icon: "play.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "inspect-image",
      label: "Inspect",
      icon: "layers.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "pull-image",
      label: "Pull again",
      icon: "refresh.svg",
      enabled: !isDangling,
      disabledReason: isDangling ? "Cannot pull dangling image" : null,
      destructive: false,
    },
    {
      id: "tag-image",
      label: "Tag…",
      icon: "folder.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "copy-id",
      label: "Copy ID",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "copy-name",
      label: "Copy Repository:Tag",
      icon: "copy.svg",
      enabled: !isDangling,
      disabledReason: isDangling ? "Dangling image has no tag" : null,
      destructive: false,
    },
    {
      id: "remove-image",
      label: "Remove",
      icon: "trash.svg",
      enabled: !usedByRunning,
      disabledReason: usedByRunning ? "Used by running container" : null,
      destructive: true,
    },
  ];
}

/**
 * Builds the volume tree view, cross-referencing containers to detect mounts and separating anonymous volumes (DM-105).
 *
 * @param {Array<object>} volumesRaw
 * @param {Array<object>} containersRaw
 * @param {Record<string, string>} [volumeSizes={}]
 * @param {{ scope?: "all" | "space", spaceProjects?: string[], filter?: string }} [options={}]
 * @returns {{ volumes: Array<object>, anonymous: Array<object>, totalCount: number, inUseCount: number }}
 */
export function buildVolumeTree(
  volumesRaw = [],
  containersRaw = [],
  volumeSizes = {},
  { scope = "all", spaceProjects = [], filter = "" } = {}
) {
  const volumesList = Array.isArray(volumesRaw) ? volumesRaw : [];
  const containersList = Array.isArray(containersRaw) ? containersRaw : [];

  const processed = [];

  for (const v of volumesList) {
    if (!v || typeof v !== "object") continue;
    const name = v.Name || v.name || "";
    if (!name) continue;

    const driver = v.Driver || v.driver || "local";
    const volumeScope = v.Scope || v.scope || "local";
    const labels = parseContainerLabels(v.Labels || v.labels);
    const project = labels["com.docker.compose.project"] || null;
    const composeVolume = labels["com.docker.compose.volume"] || null;
    const isAnon = isAnonymousVolume(name);
    const size = volumeSizes[name] || v.Size || null;
    const sizeBytes = size ? parseDockerSizeBytes(size) : 0;

    // Cross-reference containers
    const using = [];
    for (const c of containersList) {
      if (!c || typeof c !== "object") continue;
      const cName = (c.Names || c.Name || c.name || c.id || "").replace(/^\//, "");
      const cRunning = Boolean(
        c.running ||
        (c.State || c.state || "").toLowerCase() === "running" ||
        (c.Status || c.status || "").toLowerCase().startsWith("up")
      );
      const cProject = c.project || c.labels?.["com.docker.compose.project"] || null;

      let matched = false;
      const mounts = c.Mounts || c.mounts;
      if (Array.isArray(mounts)) {
        matched = mounts.some((m) => m && (m.Name === name || m.Source === name || m.destination === name));
      } else if (typeof mounts === "string") {
        // Exact mount-name comparison only: `mounts.includes(name)` marked `mysql` in use
        // because `whatsbot_mysql` contains it, disabling Remove on unrelated volumes.
        const tokens = mounts.split(",").map((s) => s.trim().split(":")[0]);
        matched = tokens.includes(name);
      }

      if (matched) {
        using.push({
          id: c.id || c.ID || cName,
          name: cName,
          running: cRunning,
          project: cProject,
        });
      }
    }

    const inUse = using.length > 0;
    const usedByRunningContainer = using.some((u) => u.running);

    // Scope filter ("space" keeps volumes owning to space projects or used by space containers)
    if (scope === "space" && Array.isArray(spaceProjects) && spaceProjects.length > 0) {
      const matchesProject = project && spaceProjects.includes(project);
      const matchesUsingContainer = using.some((u) => u.project && spaceProjects.includes(u.project));
      if (!matchesProject && !matchesUsingContainer) {
        continue;
      }
    }

    // Text filter matching
    if (filter) {
      const q = filter.trim().toLowerCase();
      const textMatch =
        name.toLowerCase().includes(q) ||
        (project && project.toLowerCase().includes(q)) ||
        (composeVolume && composeVolume.toLowerCase().includes(q));
      if (!textMatch) continue;
    }

    processed.push({
      name,
      driver,
      scope: volumeScope,
      project,
      composeVolume,
      isAnonymous: isAnon,
      size,
      sizeBytes,
      inUse,
      usedByRunningContainer,
      usedByContainers: using,
      labels,
      raw: v,
    });
  }

  // Split named vs anonymous
  const namedList = processed.filter((v) => !v.isAnonymous);
  const anonList = processed.filter((v) => v.isAnonymous);

  namedList.sort((a, b) => a.name.localeCompare(b.name));
  anonList.sort((a, b) => a.name.localeCompare(b.name));

  const totalCount = namedList.length + anonList.length;
  const inUseCount = namedList.filter((v) => v.inUse).length + anonList.filter((v) => v.inUse).length;

  return {
    volumes: namedList,
    anonymous: anonList,
    totalCount,
    inUseCount,
  };
}

/**
 * Returns context menu items for a volume (DM-106).
 *
 * @param {object} volume
 * @returns {Array<object>}
 */
export function getVolumeMenuItems(volume) {
  if (!volume) return [];
  const inUse = Boolean(volume.inUse);
  const usedByRunning = Boolean(volume.usedByRunningContainer);

  return [
    {
      id: "inspect-volume",
      label: "Inspect",
      icon: "volume.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "browse-volume",
      label: "Browse (read-only shell)",
      icon: "terminal.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "size-volume",
      label: "Compute Size",
      icon: "gauge.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "backup-volume",
      label: "Backup to .tar.gz…",
      icon: "folder.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "restore-volume",
      label: "Restore from .tar.gz…",
      icon: "refresh.svg",
      enabled: !usedByRunning,
      disabledReason: usedByRunning ? "Stop using containers first" : null,
      destructive: true,
    },
    {
      id: "clone-volume",
      label: "Clone volume…",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "copy-name",
      label: "Copy Name",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "remove-volume",
      label: "Remove",
      icon: "trash.svg",
      enabled: !inUse,
      disabledReason: inUse ? "Volume in use" : null,
      destructive: true,
    },
  ];
}

/**
 * Builds the network tree view, placing built-in networks at the bottom (DM-115).
 *
 * @param {Array<object>} networksRaw
 * @param {Record<string, object>} [networkInspectMap={}]
 * @param {{ filter?: string }} [options={}]
 * @returns {{ networks: Array<object>, builtIn: Array<object>, all: Array<object>, totalCount: number }}
 */
export function buildNetworkTree(networksRaw = [], networkInspectMap = {}, { filter = "" } = {}) {
  const networksList = Array.isArray(networksRaw) ? networksRaw : [];
  const processed = [];

  for (const n of networksList) {
    if (!n || typeof n !== "object") continue;
    const name = n.Name || n.name || "";
    if (!name) continue;

    const id = n.ID || n.id || "";
    const shortId = id.slice(0, 12);
    const driver = n.Driver || n.driver || "bridge";
    const scope = n.Scope || n.scope || "local";
    const labels = parseContainerLabels(n.Labels || n.labels);
    const project = labels["com.docker.compose.project"] || null;
    const composeNetwork = labels["com.docker.compose.network"] || null;
    const isBuiltIn = name === "bridge" || name === "host" || name === "none";

    // Connected containers from inspect cache
    const insp = networkInspectMap[id] || networkInspectMap[name];
    const containers = insp?.Containers
      ? Object.entries(insp.Containers).map(([cId, cInfo]) => ({
          id: cId,
          shortId: cId.slice(0, 12),
          name: (cInfo.Name || "").replace(/^\//, ""),
          ipv4: cInfo.IPv4Address || "",
          ipv6: cInfo.IPv6Address || "",
          mac: cInfo.MacAddress || "",
        }))
      : [];

    // Filter matching
    if (filter) {
      const q = filter.trim().toLowerCase();
      const textMatch =
        name.toLowerCase().includes(q) ||
        driver.toLowerCase().includes(q) ||
        id.toLowerCase().includes(q) ||
        shortId.toLowerCase().includes(q) ||
        (project && project.toLowerCase().includes(q)) ||
        (composeNetwork && composeNetwork.toLowerCase().includes(q));
      if (!textMatch) continue;
    }

    processed.push({
      id,
      shortId,
      name,
      driver,
      scope,
      project,
      composeNetwork,
      builtIn: isBuiltIn,
      connectedContainers: containers,
      connectedCount: containers.length,
      labels,
      raw: n,
    });
  }

  const customList = processed.filter((n) => !n.builtIn);
  const builtInList = processed.filter((n) => n.builtIn);

  customList.sort((a, b) => a.name.localeCompare(b.name));
  builtInList.sort((a, b) => a.name.localeCompare(b.name));

  const all = [...customList, ...builtInList];

  return {
    networks: customList,
    builtIn: builtInList,
    all,
    totalCount: all.length,
  };
}

/**
 * Returns context menu items for a network (DM-116).
 *
 * @param {object} network
 * @returns {Array<object>}
 */
export function getNetworkMenuItems(network) {
  if (!network) return [];
  const isBuiltIn = Boolean(network.builtIn);
  const connCount = network.connectedCount || 0;
  const canRemove = !isBuiltIn && connCount === 0;
  const disabledReason = isBuiltIn ? "Built-in network" : (connCount > 0 ? "Has connected containers" : null);

  return [
    {
      id: "inspect-network",
      label: "Inspect",
      icon: "network.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "disconnect-network",
      label: "Disconnect container…",
      icon: "close.svg",
      enabled: connCount > 0,
      disabledReason: connCount > 0 ? null : "No containers connected",
      destructive: false,
    },
    {
      id: "copy-name",
      label: "Copy Name",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "copy-id",
      label: "Copy ID",
      icon: "copy.svg",
      enabled: true,
      disabledReason: null,
      destructive: false,
    },
    {
      id: "remove-network",
      label: "Remove",
      icon: "trash.svg",
      enabled: canRemove,
      disabledReason: canRemove ? null : disabledReason,
      destructive: true,
    },
  ];
}

/**
 * Parses NDJSON lines from `docker system df --format '{{json .}}'` into a summary object (DM-120).
 *
 * @param {string} stdout
 * @returns {{ images: object, containers: object, volumes: object, buildCache: object }}
 */
export function parseSystemDf(stdout) {
  const result = {
    images: { type: "Images", totalCount: 0, active: 0, size: "0B", sizeBytes: 0, reclaimable: "0B", reclaimableBytes: 0 },
    containers: { type: "Containers", totalCount: 0, active: 0, size: "0B", sizeBytes: 0, reclaimable: "0B", reclaimableBytes: 0 },
    volumes: { type: "Local Volumes", totalCount: 0, active: 0, size: "0B", sizeBytes: 0, reclaimable: "0B", reclaimableBytes: 0 },
    buildCache: { type: "Build Cache", totalCount: 0, active: 0, size: "0B", sizeBytes: 0, reclaimable: "0B", reclaimableBytes: 0 },
  };

  if (!stdout || typeof stdout !== "string") return result;

  const lines = stdout.trim().split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line.trim());
      const type = (parsed.Type || "").toLowerCase();
      const totalCount = parseInt(parsed.TotalCount, 10) || 0;
      const active = parseInt(parsed.Active, 10) || 0;
      const size = parsed.Size || "0B";
      const sizeBytes = parseDockerSizeBytes(size);
      const reclaimable = parsed.Reclaimable || "0B";
      const reclaimableClean = reclaimable.replace(/\s*\(.*\)$/, "");
      const reclaimableBytes = parseDockerSizeBytes(reclaimableClean);

      const entry = {
        type: parsed.Type || "Unknown",
        totalCount,
        active,
        size,
        sizeBytes,
        reclaimable,
        reclaimableBytes,
      };

      if (type.includes("image")) {
        result.images = entry;
      } else if (type.includes("container")) {
        result.containers = entry;
      } else if (type.includes("volume")) {
        result.volumes = entry;
      } else if (type.includes("cache")) {
        result.buildCache = entry;
      }
    } catch {
      // Ignore malformed lines
    }
  }

  return result;
}

/**
 * Parses JSON output from `docker system df -v --format json` into top lists and volume sizes (DM-121).
 *
 * @param {string | object} stdout
 * @returns {{ topImages: Array<object>, topVolumes: Array<object>, topContainers: Array<object>, volumeSizes: Record<string, string> }}
 */
export function parseSystemDfVerbose(stdout) {
  const result = {
    topImages: [],
    topVolumes: [],
    topContainers: [],
    volumeSizes: {},
  };

  if (!stdout) return result;

  let data = null;
  if (typeof stdout === "object") {
    data = stdout;
  } else {
    try {
      data = JSON.parse(stdout);
    } catch {
      return result;
    }
  }

  if (!data || typeof data !== "object") return result;

  // Images
  const images = Array.isArray(data.Images) ? data.Images : [];
  result.topImages = images
    .map((img) => {
      const size = img.Size || img.UniqueSize || "0B";
      return {
        id: img.ID || "",
        repository: img.Repository || "",
        tag: img.Tag || "",
        size,
        sizeBytes: parseDockerSizeBytes(size),
        containers: parseInt(img.Containers, 10) || 0,
        created: img.CreatedAt || img.CreatedSince || "",
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 10);

  // Volumes
  const volumes = Array.isArray(data.Volumes) ? data.Volumes : [];
  result.topVolumes = volumes
    .map((vol) => {
      const name = vol.VolumeName || vol.Name || "";
      const size = vol.Size || "0B";
      if (name) {
        result.volumeSizes[name] = size;
      }
      return {
        name,
        links: parseInt(vol.Links, 10) || 0,
        size,
        sizeBytes: parseDockerSizeBytes(size),
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 10);

  // Containers
  const containers = Array.isArray(data.Containers) ? data.Containers : [];
  result.topContainers = containers
    .map((c) => {
      const size = c.Size || "0B";
      return {
        id: c.ID || "",
        names: c.Names || "",
        image: c.Image || "",
        status: c.Status || "",
        size,
        sizeBytes: parseDockerSizeBytes(size),
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 10);

  return result;
}

/**
 * Builds a granular prune execution plan from user selections (DM-122).
 *
 * @param {{ containers?: boolean, danglingImages?: boolean, unusedImages?: boolean, networks?: boolean, volumes?: boolean, buildCache?: boolean, buildCacheOlderThan7d?: boolean }} selections
 * @returns {{ commands: Array<{ label: string, argv: string[] }>, requiresTypedConfirm: boolean, highWarning: boolean }}
 */
export function buildGranularPrunePlan(selections = {}) {
  const commands = [];
  if (selections.containers) {
    commands.push({ label: "Stopped containers", argv: ["container", "prune", "-f"] });
  }
  if (selections.unusedImages) {
    commands.push({ label: "All unused images", argv: ["image", "prune", "-a", "-f"] });
  } else if (selections.danglingImages) {
    commands.push({ label: "Dangling images", argv: ["image", "prune", "-f"] });
  }
  if (selections.networks) {
    commands.push({ label: "Unused networks", argv: ["network", "prune", "-f"] });
  }
  if (selections.volumes) {
    commands.push({ label: "Unused volumes", argv: ["volume", "prune", "-f"] });
  }
  if (selections.buildCache) {
    commands.push({
      label: selections.buildCacheOlderThan7d ? "Build cache older than 7 days" : "All build cache",
      argv: ["builder", "prune", "-f", ...(selections.buildCacheOlderThan7d ? ["--filter", "until=168h"] : [])],
    });
  }

  const requiresTypedConfirm = Boolean(selections.volumes || selections.unusedImages);
  const highWarning = Boolean(selections.volumes || selections.unusedImages);

  return { commands, requiresTypedConfirm, highWarning };
}

/**
 * Normalizes raw `docker image inspect` JSON output into a structured ImageInspect object (DM-44, DM-102).
 *
 * @param {object} raw
 * @param {Array<object>} [historyRows=[]]
 * @returns {object}
 */
export function normalizeImageInspect(raw, historyRows = []) {
  if (!raw || typeof raw !== "object") return null;
  const target = Array.isArray(raw) ? raw[0] : raw;
  if (!target || typeof target !== "object") return null;

  const id = target.Id || target.ID || "";
  const shortId = id.replace(/^sha256:/, "").slice(0, 12);
  const repoTags = Array.isArray(target.RepoTags) ? target.RepoTags : [];
  const repoDigests = Array.isArray(target.RepoDigests) ? target.RepoDigests : [];
  const created = target.Created || "";
  const sizeBytes = target.Size || 0;
  const size = sizeBytes ? `${(sizeBytes / (1000 * 1000)).toFixed(1)}MB` : "0B";

  const config = target.Config || {};
  const env = Array.isArray(config.Env) ? config.Env : [];
  const exposedPorts = Object.keys(config.ExposedPorts || {});
  const cmd = Array.isArray(config.Cmd) ? config.Cmd : [];
  const entrypoint = Array.isArray(config.Entrypoint) ? config.Entrypoint : [];
  const labels = config.Labels || {};

  return {
    id,
    shortId,
    repoTags,
    repoDigests,
    created,
    size,
    sizeBytes,
    architecture: target.Architecture || "",
    os: target.Os || "",
    author: target.Author || "",
    dockerVersion: target.DockerVersion || "",
    config: {
      env,
      exposedPorts,
      cmd,
      entrypoint,
      workingDir: config.WorkingDir || "",
      user: config.User || "",
      labels,
    },
    history: Array.isArray(historyRows) ? historyRows : [],
    raw: target,
  };
}

/**
 * Normalizes raw `docker volume inspect` JSON output into a structured VolumeInspect object (DM-44, DM-106).
 *
 * @param {object} raw
 * @param {Array<object>} [usingContainers=[]]
 * @returns {object}
 */
export function normalizeVolumeInspect(raw, usingContainers = []) {
  if (!raw || typeof raw !== "object") return null;
  const target = Array.isArray(raw) ? raw[0] : raw;
  if (!target || typeof target !== "object") return null;

  return {
    name: target.Name || "",
    driver: target.Driver || "local",
    mountpoint: target.Mountpoint || "",
    createdAt: target.CreatedAt || "",
    scope: target.Scope || "local",
    labels: target.Labels || {},
    options: target.Options || {},
    usingContainers: Array.isArray(usingContainers) ? usingContainers : [],
    size: target.Size || null,
    raw: target,
  };
}

/**
 * Normalizes raw `docker network inspect` JSON output into a structured NetworkInspect object (DM-44, DM-116).
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeNetworkInspect(raw) {
  if (!raw || typeof raw !== "object") return null;
  const target = Array.isArray(raw) ? raw[0] : raw;
  if (!target || typeof target !== "object") return null;

  const id = target.Id || target.ID || "";
  const shortId = id.slice(0, 12);
  const name = target.Name || "";
  const driver = target.Driver || "";
  const scope = target.Scope || "local";

  const containers = target.Containers
    ? Object.entries(target.Containers).map(([cId, cInfo]) => ({
        id: cId,
        shortId: cId.slice(0, 12),
        name: (cInfo.Name || "").replace(/^\//, ""),
        ipv4: cInfo.IPv4Address || "",
        ipv6: cInfo.IPv6Address || "",
        mac: cInfo.MacAddress || "",
      }))
    : [];

  return {
    id,
    shortId,
    name,
    driver,
    scope,
    internal: Boolean(target.Internal),
    attachable: Boolean(target.Attachable),
    ingress: Boolean(target.Ingress),
    ipam: {
      driver: target.IPAM?.Driver || "default",
      configs: target.IPAM?.Config || [],
      subnet: target.IPAM?.Config?.[0]?.Subnet || "",
      gateway: target.IPAM?.Config?.[0]?.Gateway || "",
    },
    containers,
    labels: target.Labels || {},
    options: target.Options || {},
    raw: target,
  };
}
