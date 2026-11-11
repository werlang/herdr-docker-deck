/**
 * docker-logic.js — Pure, zero-dependency domain logic for Docker Manager mod.
 *
 * Implements label parsing, Compose/Dockerfile classification, argv construction,
 * deep container inspect normalization, secret masking, tree merging, system df parsing,
 * and context menu clamping.
 *
 * References:
 * - docs/SPEC.md: DM-20..27 (Container tree), DM-30..36 (Discovery & Scope),
 *   DM-40..46 (Inspection), DM-50..87 (CLI actions & safety), DM-100..123 (Resources & Hygiene)
 * - docs/DESIGN.md: Sections 3, 4, 5, 6
 */

/**
 * Parses raw Docker container labels.
 *
 * In `docker container ls --format '{{json .}}'`, `Labels` is a comma-separated
 * `k=v` string where values themselves can contain commas — most notably
 * `com.docker.compose.project.config_files=/path/a.yaml,/path/b.yaml` and
 * `desktop.docker.io/binds/...`.
 *
 * Splits only on commas that precede a valid label key token (`/[a-zA-Z0-9_./-]+=/`),
 * preserving multi-file paths in compose labels intact.
 *
 * @param {string | Record<string, string> | null | undefined} rawLabels
 * @returns {Record<string, string>}
 */
export function parseContainerLabels(rawLabels) {
  if (!rawLabels) return {};
  if (typeof rawLabels === "object") {
    return { ...rawLabels };
  }
  if (typeof rawLabels !== "string") return {};

  const trimmed = rawLabels.trim();
  if (trimmed.length === 0) return {};

  // Match commas that are followed by a key token like `key=` or `domain.io/key=`
  // Key must start with alphanumeric and end with `=`
  const entries = trimmed.split(/,(?=[a-zA-Z0-9][a-zA-Z0-9_./-]*=)/);
  const result = {};

  for (const entry of entries) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx === -1) {
      const key = entry.trim();
      if (key) result[key] = "";
    } else {
      const key = entry.slice(0, eqIdx).trim();
      const val = entry.slice(eqIdx + 1);
      if (key) result[key] = val;
    }
  }

  return result;
}

/**
 * Validates a Docker identifier (container name, ID, volume name, network name, project name).
 *
 * Accepts alphanumeric characters, dots, underscores, and hyphens up to 255 chars.
 * Rejects empty names, spaces, semicolons, path traversal (`..`), slashes (`/`),
 * shell command substitution (`$()`), and identifiers > 255 chars (DM-87).
 *
 * @param {string | null | undefined} name
 * @returns {boolean}
 */
export function validateDockerIdentifier(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return false;
  if (name !== trimmed) return false;
  // Docker resource names must start with an alphanumeric character
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

/**
 * Classifies a workspace file into Compose or Dockerfile target (DM-30, DM-34).
 *
 * Recognizes:
 * - Compose: `compose.yaml`, `compose.yml`, `compose.dev.yaml`, `compose.override.yaml`,
 *   `docker-compose.yml`, `docker-compose.yaml`, `docker-compose.override.yml`, etc.
 * - Dockerfile: `Dockerfile`, `Dockerfile.dev`, `app.Dockerfile`, `Containerfile`, `Containerfile.dev`, etc.
 * Rejects unrelated files like `values.yaml`, `README.md`.
 *
 * @param {string | null | undefined} filePath
 * @returns {{ type: "compose" | "dockerfile", kind: "compose" | "dockerfile", isCompose: boolean, isDockerfile: boolean, isOverride: boolean, env: string | null, variant: string | null } | null}
 */
export function classifyDockerFile(filePath) {
  if (!filePath || typeof filePath !== "string") return null;

  const base = filePath.split("/").pop();
  if (!base) return null;
  const lower = base.toLowerCase();

  // 1. Compose file patterns:
  // ^(?:docker-)?compose(?:\.(?<variant>.*?))?\.ya?ml$
  const composeMatch = lower.match(/^(?:docker-)?compose(?:\.(.+?))?\.ya?ml$/);
  if (composeMatch) {
    const variant = composeMatch[1] || null;
    const isOverride = Boolean(variant && variant.toLowerCase().includes("override"));
    const env = variant && !isOverride ? variant : null;
    return {
      type: "compose",
      kind: "compose",
      isCompose: true,
      isDockerfile: false,
      isOverride,
      env,
      variant,
    };
  }

  // 2. Dockerfile patterns:
  // dockerfile, dockerfile.<variant>, <variant>.dockerfile, containerfile, containerfile.<variant>, <variant>.containerfile
  let isDocker = false;
  let dfVariant = null;

  if (lower === "dockerfile" || lower === "containerfile") {
    isDocker = true;
  } else if (lower.startsWith("dockerfile.") || lower.startsWith("containerfile.")) {
    isDocker = true;
    dfVariant = base.slice(base.indexOf(".") + 1);
  } else if (lower.endsWith(".dockerfile") || lower.endsWith(".containerfile")) {
    isDocker = true;
    dfVariant = base.slice(0, base.indexOf("."));
  }

  if (isDocker) {
    return {
      type: "dockerfile",
      kind: "dockerfile",
      isCompose: false,
      isDockerfile: true,
      isOverride: false,
      env: null,
      variant: dfVariant,
    };
  }

  return null;
}

/**
 * Checks whether an environment variable name matches secret/sensitive patterns (DM-45).
 *
 * Matches PASSWORD, DB_PASSWORD, SECRET, TOKEN, API_KEY, PRIVATE_KEY, AUTH,
 * CREDENTIAL, CLIENT_SECRET, DATABASE_URL, REDIS_URL, CONNECTION_STRING.
 * Leaves ordinary variables like PATH, NODE_ENV, PORT, HOME unmasked.
 *
 * @param {string | null | undefined} key
 * @returns {boolean}
 */
export function isSecretEnvKey(key) {
  if (!key || typeof key !== "string") return false;
  return /(?:^|_)(?:PASS(?:WORD|PHRASE)?|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|AUTH|CREDENTIAL|CLIENT_SECRET|DATABASE_URL|REDIS_URL|CONNECTION_STRING)(?:$|_)/i.test(
    key
  );
}

/**
 * Normalizes raw container JSON from `docker inspect` into a structured, safe model (DM-40..46).
 *
 * @param {any} raw
 * @returns {Record<string, any>}
 */
export function normalizeContainerInspect(raw) {
  if (!raw) return {};
  const data = Array.isArray(raw) ? raw[0] || {} : typeof raw === "string" ? JSON.parse(raw) : raw;

  const id = data.Id || "";
  const shortId = id.slice(0, 12);
  const name = (data.Name || "").replace(/^\//, "");
  const labels = parseContainerLabels(data.Config?.Labels);
  const project = labels["com.docker.compose.project"] || null;
  const service = labels["com.docker.compose.service"] || null;
  const composeFilesStr = labels["com.docker.compose.project.config_files"] || "";
  const composeFiles = composeFilesStr ? composeFilesStr.split(",").filter(Boolean) : [];
  const dependsOnStr = labels["com.docker.compose.depends_on"] || "";
  const dependsOn = dependsOnStr ? dependsOnStr.split(",").filter(Boolean) : [];

  // State & Health
  const stateObj = data.State || {};
  const state = {
    status: stateObj.Status || "unknown",
    running: Boolean(stateObj.Running),
    paused: Boolean(stateObj.Paused),
    restarting: Boolean(stateObj.Restarting),
    oomKilled: Boolean(stateObj.OOMKilled),
    dead: Boolean(stateObj.Dead),
    exitCode: typeof stateObj.ExitCode === "number" ? stateObj.ExitCode : 0,
    error: stateObj.Error || "",
    startedAt: stateObj.StartedAt || "",
    finishedAt: stateObj.FinishedAt || "",
  };

  const healthObj = stateObj.Health || null;
  let health = null;
  if (healthObj) {
    const logArr = Array.isArray(healthObj.Log) ? healthObj.Log : [];
    const lastLog = logArr.length > 0 ? logArr[logArr.length - 1].Output || "" : null;
    health = {
      status: healthObj.Status || null,
      failingStreak: healthObj.FailingStreak || 0,
      lastLog,
    };
  }

  // HostConfig RestartPolicy
  const restartPolicyObj = data.HostConfig?.RestartPolicy || {};
  const restartPolicy = {
    name: restartPolicyObj.Name || "",
    maximumRetryCount: restartPolicyObj.MaximumRetryCount || 0,
  };

  // Ports
  const ports = [];
  const rawPorts = data.NetworkSettings?.Ports || {};
  for (const [containerPortProto, bindings] of Object.entries(rawPorts)) {
    const slashIdx = containerPortProto.indexOf("/");
    const containerPort = slashIdx !== -1 ? containerPortProto.slice(0, slashIdx) : containerPortProto;
    const proto = slashIdx !== -1 ? containerPortProto.slice(slashIdx + 1) : "tcp";

    if (Array.isArray(bindings) && bindings.length > 0) {
      for (const b of bindings) {
        ports.push({
          hostIp: b.HostIp || "0.0.0.0",
          hostPort: b.HostPort || "",
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

  // Mounts
  const mounts = (data.Mounts || []).map((m) => ({
    type: m.Type || "bind",
    name: m.Name || null,
    source: m.Source || "",
    destination: m.Destination || "",
    rw: Boolean(m.RW),
    driver: m.Driver || null,
    mode: m.Mode || "",
  }));

  // Networks
  const networks = [];
  const rawNetworks = data.NetworkSettings?.Networks || {};
  for (const [netName, netObj] of Object.entries(rawNetworks)) {
    networks.push({
      name: netName,
      ipAddress: netObj.IPAddress || "",
      gateway: netObj.Gateway || "",
      macAddress: netObj.MacAddress || "",
      aliases: Array.isArray(netObj.Aliases) ? netObj.Aliases : [],
      networkId: netObj.NetworkID || "",
    });
  }

  // Environment
  const env = (data.Config?.Env || []).map((entry) => {
    const eqIdx = entry.indexOf("=");
    const key = eqIdx === -1 ? entry : entry.slice(0, eqIdx);
    const value = eqIdx === -1 ? "" : entry.slice(eqIdx + 1);
    return {
      key,
      value,
      secret: isSecretEnvKey(key),
    };
  });

  return {
    id,
    shortId,
    name,
    project,
    service,
    image: data.Config?.Image || "",
    imageId: data.Image || "",
    created: data.Created || "",
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    state,
    health,
    restartPolicy,
    ports,
    mounts,
    networks,
    env,
    entrypoint: data.Config?.Entrypoint || null,
    cmd: data.Config?.Cmd || null,
    workingDir: data.Config?.WorkingDir || "",
    labels,
    composeFiles,
    dependsOn,
  };
}

/**
 * Checks if target has usable compose files.
 *
 * @param {{ project?: string, workingDir?: string, configFiles?: string[], hasConfigFiles?: boolean } | string} target
 * @returns {boolean}
 */
export function hasUsableConfigFiles(target) {
  if (!target || typeof target === "string") return false;
  if (target.hasConfigFiles === false) return false;
  return Array.isArray(target.configFiles) && target.configFiles.length > 0;
}

/**
 * Checks compose action availability against missing configuration files (DM-50..59).
 *
 * When compose configuration files are missing, lifecycle actions `up`, `build`,
 * and `pull` are disabled with the reason "compose file not found".
 *
 * @param {{ project?: string, workingDir?: string, configFiles?: string[], hasConfigFiles?: boolean } | string} target
 * @param {string} action
 * @returns {{ disabled: boolean, reason: string | null }}
 */
export function getComposeActionAvailability(target, action) {
  const act = String(action || "").toLowerCase();
  const hasFiles = hasUsableConfigFiles(target);
  if (!hasFiles && (act === "up" || act === "build" || act === "pull")) {
    return { disabled: true, reason: "compose file not found" };
  }
  return { disabled: false, reason: null };
}

/**
 * Builds compose CLI arguments for a project target and subcommand (DM-50..69).
 *
 * Emits `-p <project> --project-directory <dir> -f <file> …` when config files exist;
 * falls back to `-p <project>` when config files are missing, marking `up`/`build`/`pull`
 * as disabled with reason `compose file not found`.
 *
 * @param {{ project?: string, workingDir?: string, configFiles?: string[], hasConfigFiles?: boolean } | string} target
 * @param {string[]} [subcommandArgs=[]]
 * @returns {string[] & { disabled: boolean, reason: string | null, args: string[] }}
 */
export function buildComposeArgs(target, subcommandArgs = []) {
  const t = typeof target === "string" ? { project: target } : target || {};
  const project = t.project || "";
  const hasFiles = hasUsableConfigFiles(t);

  const base = ["compose", "-p", project];
  if (hasFiles) {
    if (t.workingDir) {
      base.push("--project-directory", t.workingDir);
    }
    if (Array.isArray(t.configFiles)) {
      for (const f of t.configFiles) {
        base.push("-f", f);
      }
    }
  }

  const result = [...base, ...subcommandArgs];

  // Determine if action is disabled due to missing compose files
  const firstSub = subcommandArgs.length > 0 ? subcommandArgs[0].toLowerCase() : "";
  const isUpOrBuildOrPull =
    firstSub === "up" ||
    firstSub === "build" ||
    firstSub === "pull" ||
    subcommandArgs.includes("up") ||
    subcommandArgs.includes("build") ||
    subcommandArgs.includes("pull");

  let disabled = false;
  let reason = null;
  if (!hasFiles && isUpOrBuildOrPull) {
    disabled = true;
    reason = "compose file not found";
  }

  Object.defineProperty(result, "disabled", {
    value: disabled,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(result, "reason", {
    value: reason,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(result, "args", {
    value: result,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return result;
}

// -----------------------------------------------------------------------------
// Exact CLI Argv Builders (Section 4.5 & 4.6)
// -----------------------------------------------------------------------------

/**
 * Service rebuild argv (DM-62).
 * `docker compose <target> up -d --build --force-recreate --no-deps <service>`
 */
export function buildServiceRebuildArgs(target, service) {
  return buildComposeArgs(target, ["up", "-d", "--build", "--force-recreate", "--no-deps", service]);
}

/**
 * Service recreate argv (DM-63).
 * `docker compose <target> up -d --force-recreate --no-deps <service>`
 */
export function buildServiceRecreateArgs(target, service) {
  return buildComposeArgs(target, ["up", "-d", "--force-recreate", "--no-deps", service]);
}

/**
 * Service remove argv (DM-69).
 * `docker compose <target> rm -s -f <service>`
 */
export function buildServiceRmArgs(target, service) {
  return buildComposeArgs(target, ["rm", "-s", "-f", service]);
}

/**
 * Project down argv (DM-58, DM-59).
 * `docker compose <target> down [-v]`
 */
export function buildProjectDownArgs(target, { removeVolumes = false } = {}) {
  const sub = removeVolumes ? ["down", "-v"] : ["down"];
  return buildComposeArgs(target, sub);
}

/**
 * Project down with volumes argv (DM-59).
 */
export function buildProjectDownVolumesArgs(target) {
  return buildComposeArgs(target, ["down", "-v"]);
}

/**
 * Service logs argv (DM-80).
 */
export function buildServiceLogsArgs(target, service, { tail = 500 } = {}) {
  const composeArgs = buildComposeArgs(target, []);
  return ["docker", ...composeArgs, "logs", "-f", "--tail", String(tail), service];
}

/**
 * Container logs argv (DM-80).
 */
export function buildContainerLogsArgs(containerId, { tail = 500 } = {}) {
  return ["docker", "logs", "-f", "--tail", String(tail), containerId];
}

/**
 * Container shell argv (DM-81).
 */
export function buildContainerShellArgs(containerId, shellCmd = "auto") {
  if (shellCmd === "bash") {
    return ["docker", "exec", "-it", containerId, "bash"];
  }
  if (shellCmd === "sh") {
    return ["docker", "exec", "-it", containerId, "sh"];
  }
  if (shellCmd !== "auto" && typeof shellCmd === "string") {
    return ["docker", "exec", "-it", containerId, "sh", "-c", shellCmd];
  }
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

/**
 * Container kill argv (DM-72).
 */
export function buildContainerKillArgs(containerId) {
  return ["kill", containerId];
}

/**
 * Volume browse argv (DM-106).
 */
export function buildVolumeBrowseArgs(volumeName, helperImage = "alpine:3") {
  return ["docker", "run", "--rm", "-it", "-v", `${volumeName}:/data:ro`, "-w", "/data", helperImage, "sh"];
}

/**
 * Volume backup argv (DM-107).
 */
export function buildVolumeBackupArgs(volumeName, destDir, archiveName, helperImage = "alpine:3") {
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

/**
 * Volume restore argv (DM-108).
 */
export function buildVolumeRestoreArgs(volumeName, srcDir, archiveName, helperImage = "alpine:3") {
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

/**
 * Volume clone argv (DM-109).
 */
export function buildVolumeCloneArgs(srcVolume, destVolume, helperImage = "alpine:3") {
  const createArgs = ["volume", "create", destVolume];
  const copyArgs = [
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
  ];
  return {
    createArgs,
    copyArgs,
  };
}

/**
 * Image prune dangling argv (DM-102).
 */
export function buildImagePruneDanglingArgs() {
  return ["image", "prune", "-f"];
}

/**
 * Image prune unused argv (DM-102).
 */
export function buildImagePruneUnusedArgs() {
  return ["image", "prune", "-a", "-f"];
}

/**
 * System disk usage fast argv (DM-120).
 */
export function buildSystemDfArgs() {
  return ["system", "df", "--format", "{{json .}}"];
}

/**
 * System disk usage verbose argv (DM-121).
 */
export function buildSystemDfVerboseArgs() {
  return ["system", "df", "-v", "--format", "json"];
}

/**
 * Builder prune argv (DM-122).
 */
export function buildBuilderPruneArgs({ olderThan7d = false } = {}) {
  if (olderThan7d) {
    return ["builder", "prune", "-f", "--filter", "until=168h"];
  }
  return ["builder", "prune", "-f"];
}

// -----------------------------------------------------------------------------
// System Df Parsers (DM-120, DM-121)
// -----------------------------------------------------------------------------

/**
 * Parses `docker system df` output, supporting both 4-line NDJSON and single-object JSON.
 *
 * @param {string | any} stdout
 * @returns {{ images: any, containers: any, volumes: any, buildCache: any, items: any[] }}
 */
export function parseSystemDf(stdout) {
  const emptyResult = {
    images: { type: "Images", totalCount: 0, active: 0, size: "0B", reclaimable: "0B" },
    containers: { type: "Containers", totalCount: 0, active: 0, size: "0B", reclaimable: "0B" },
    volumes: { type: "Local Volumes", totalCount: 0, active: 0, size: "0B", reclaimable: "0B" },
    buildCache: { type: "Build Cache", totalCount: 0, active: 0, size: "0B", reclaimable: "0B" },
    items: [],
  };

  if (!stdout) return emptyResult;

  let rawList = [];

  if (typeof stdout === "object") {
    if (Array.isArray(stdout)) {
      rawList = stdout;
    } else {
      // Single object mapping types
      for (const [k, v] of Object.entries(stdout)) {
        if (v && typeof v === "object") {
          rawList.push({ Type: k, ...v });
        }
      }
    }
  } else if (typeof stdout === "string") {
    const trimmed = stdout.trim();
    if (!trimmed) return emptyResult;

    // Try parsing as single JSON document first
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        rawList = parsed;
      } else if (typeof parsed === "object" && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
            rawList.push({ Type: k, ...v[0] });
          } else if (v && typeof v === "object") {
            rawList.push({ Type: k, ...v });
          }
        }
      }
    } catch {
      // NDJSON fallback (one JSON object per line)
      const lines = trimmed.split("\n");
      for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        try {
          rawList.push(JSON.parse(l));
        } catch {
          // ignore corrupted lines
        }
      }
    }
  }

  const result = { ...emptyResult, items: [] };

  for (const item of rawList) {
    const typeStr = String(item.Type || item.type || "").toLowerCase();
    const entry = {
      type: item.Type || item.type || "",
      totalCount: Number(item.TotalCount ?? item.totalCount ?? 0),
      active: Number(item.Active ?? item.active ?? 0),
      size: String(item.Size ?? item.size ?? "0B"),
      reclaimable: String(item.Reclaimable ?? item.reclaimable ?? "0B"),
      raw: item,
    };

    result.items.push(entry);

    if (typeStr.includes("image")) {
      result.images = entry;
    } else if (typeStr.includes("container")) {
      result.containers = entry;
    } else if (typeStr.includes("volume")) {
      result.volumes = entry;
    } else if (typeStr.includes("cache") || typeStr.includes("build")) {
      result.buildCache = entry;
    }
  }

  return result;
}

/**
 * Parses `docker system df -v` output, supporting both single-object JSON and NDJSON.
 *
 * @param {string | any} stdout
 * @returns {{ images: any[], containers: any[], volumes: any[], buildCache: any[] }}
 */
export function parseSystemDfVerbose(stdout) {
  const result = {
    images: [],
    containers: [],
    volumes: [],
    buildCache: [],
  };

  if (!stdout) return result;

  let parsed = null;
  if (typeof stdout === "object") {
    parsed = stdout;
  } else if (typeof stdout === "string") {
    const trimmed = stdout.trim();
    if (!trimmed) return result;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // NDJSON fallback
      const lines = trimmed.split("\n");
      const list = [];
      for (const line of lines) {
        const l = line.trim();
        if (l) {
          try {
            list.push(JSON.parse(l));
          } catch {}
        }
      }
      parsed = list;
    }
  }

  if (!parsed) return result;

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item.Images) result.images.push(...item.Images);
      if (item.Containers) result.containers.push(...item.Containers);
      if (item.Volumes) result.volumes.push(...item.Volumes);
      if (item.BuildCache) result.buildCache.push(...item.BuildCache);
    }
  } else if (typeof parsed === "object") {
    result.images = parsed.Images || parsed.images || [];
    result.containers = parsed.Containers || parsed.containers || [];
    result.volumes = parsed.Volumes || parsed.volumes || [];
    result.buildCache = parsed.BuildCache || parsed.buildCache || [];
  }

  return result;
}

// -----------------------------------------------------------------------------
// Context Menu Positioning (DM-14, DESIGN Section 5)
// -----------------------------------------------------------------------------

/**
 * Calculates clamped and flipped coordinates for an in-panel context menu overlay.
 *
 * Clamps within container bounds and flips upwards or to the left when near
 * right/bottom edges to prevent overflow.
 *
 * @param {any} options
 * @returns {{ x: number, y: number }}
 */
export function contextMenuPosition(options) {
  let x = 120;
  let y = 120;
  let menuWidth = 180;
  let menuHeight = 200;
  let maxW = 600;
  let maxH = 600;
  const margin = 10;

  if (arguments.length >= 4 && typeof arguments[0] === "number") {
    // Positional signature: (x, y, menuWidth, menuHeight, bounds)
    x = arguments[0];
    y = arguments[1];
    menuWidth = arguments[2] || menuWidth;
    menuHeight = arguments[3] || menuHeight;
    const b = arguments[4];
    if (b) {
      maxW = b.width || maxW;
      maxH = b.height || maxH;
    }
  } else if (options && typeof options === "object") {
    const bounds = options.bounds;
    maxW = options.width || bounds?.width || 600;
    maxH = options.height || bounds?.height || 600;
    menuWidth = options.menuWidth || menuWidth;
    menuHeight = options.menuHeight || menuHeight;

    if (typeof options.x === "number") {
      x = options.x;
    } else if (typeof options.overrideX === "number") {
      x = options.overrideX;
    } else if (typeof options.event?.position?.x === "number") {
      const paneX = options.origin?.x ?? (bounds && bounds.x > 0 ? bounds.x : 0);
      x = options.event.position.x - paneX;
    } else if (typeof options.defaultX === "number") {
      x = options.defaultX;
    }

    if (typeof options.y === "number") {
      y = options.y;
    } else if (typeof options.overrideY === "number") {
      y = options.overrideY;
    } else if (typeof options.event?.position?.y === "number") {
      const paneY = options.origin?.y ?? (bounds && bounds.y > 0 ? bounds.y : 0);
      y = options.event.position.y - paneY;
    } else if (typeof options.defaultY === "number") {
      y = options.defaultY;
    }
  }

  // Horizontal placement: flip to left if overflowing right edge
  if (x + menuWidth > maxW - margin) {
    if (x - menuWidth >= margin) {
      x = x - menuWidth;
    } else {
      x = Math.max(margin, maxW - menuWidth - margin);
    }
  }
  if (x < margin) x = margin;

  // Vertical placement: flip upwards if overflowing bottom edge
  if (y + menuHeight > maxH - margin) {
    if (y - menuHeight >= margin) {
      y = y - menuHeight;
    } else {
      y = Math.max(margin, maxH - menuHeight - margin);
    }
  }
  if (y < margin) y = margin;

  return { x: Math.round(x), y: Math.round(y) };
}

// -----------------------------------------------------------------------------
// Container Tree Construction (DM-20..27, DM-30..36, DESIGN Section 4.3)
// -----------------------------------------------------------------------------

/**
 * Checks whether childPath is equal to or inside parentDir.
 *
 * @param {string | null | undefined} childPath
 * @param {string | null | undefined} parentDir
 * @returns {boolean}
 */
export function isPathEqualOrInside(childPath, parentDir) {
  if (!childPath || !parentDir) return false;
  const child = childPath.replace(/\/+$/, "");
  const parent = parentDir.replace(/\/+$/, "");
  if (child === parent) return true;
  return child.startsWith(parent + "/");
}

/**
 * Builds the hierarchical container tree for Docker Manager (DM-20..27).
 *
 * Groups by:
 * 1. Compose projects (Project -> Service -> Container)
 * 2. Dockerfile targets (Dockerfile -> Containers with `herdr.docker-manager.source`)
 * 3. Standalone containers
 *
 * Merges declared services from `compose config` (synthesizing `not-created` services),
 * separates inactive profiles, computes `mixedSources` when `working_dir` differs,
 * sets `inSpace` flag, and applies `scope: "space"` vs `scope: "all"`.
 *
 * @param {{
 *   containers?: any[],
 *   composeLs?: any[],
 *   discoveredCompose?: any[],
 *   discoveredDockerfiles?: any[],
 *   spaceRoot?: string | null,
 *   scope?: "space" | "all",
 *   activeProfiles?: string[],
 * }} options
 * @returns {{
 *   projects: any[],
 *   dockerfiles: any[],
 *   standalone: any[],
 * }}
 */
export function buildContainerTree({
  containers = [],
  composeLs = [],
  discoveredCompose = [],
  discoveredDockerfiles = [],
  spaceRoot = null,
  scope = "all",
  activeProfiles = [],
} = {}) {
  const projectsMap = new Map();

  // Helper to ensure project node in map
  function getOrCreateProject(name) {
    if (!projectsMap.has(name)) {
      projectsMap.set(name, {
        name,
        type: "compose",
        status: "not-created",
        runningCount: 0,
        totalCount: 0,
        workingDirs: new Set(),
        configFiles: new Set(),
        servicesMap: new Map(),
        inactiveProfiles: [],
        discoveredConfig: null,
        mixedSources: false,
        inSpace: false,
      });
    }
    return projectsMap.get(name);
  }

  // 1. Seed from `docker compose ls`
  for (const row of composeLs) {
    const name = row.Name || row.name;
    if (!name) continue;
    const proj = getOrCreateProject(name);
    if (row.ConfigFiles || row.configFiles) {
      const files = String(row.ConfigFiles || row.configFiles).split(",");
      for (const f of files) {
        if (f.trim()) proj.configFiles.add(f.trim());
      }
    }
  }

  // 2. Seed from discovered Compose configs
  const discoveredList = Array.isArray(discoveredCompose)
    ? discoveredCompose
    : Object.values(discoveredCompose);

  for (const disc of discoveredList) {
    if (!disc) continue;
    const name = disc.project || disc.name || (disc.config && disc.config.name);
    if (!name) continue;
    const proj = getOrCreateProject(name);
    proj.discoveredConfig = disc;

    if (disc.workingDir) {
      proj.workingDirs.add(disc.workingDir);
    }
    if (disc.file) {
      proj.configFiles.add(disc.file);
    }
    if (Array.isArray(disc.files)) {
      for (const f of disc.files) proj.configFiles.add(f);
    }
  }

  // 3. Process containers
  const dockerfileContainers = [];
  const standaloneContainers = [];

  for (const rawCont of containers) {
    const labels = parseContainerLabels(rawCont.Labels || rawCont.labels);
    const projectName = labels["com.docker.compose.project"];
    const serviceName = labels["com.docker.compose.service"];
    const sourceDockerfile = labels["herdr.docker-manager.source"];

    const id = rawCont.ID || rawCont.Id || rawCont.id || "";
    const shortId = id.slice(0, 12);
    const rawName = rawCont.Names || rawCont.Name || rawCont.name || "";
    const name = rawName.replace(/^\//, "");
    const state = String(rawCont.State || rawCont.state || "").toLowerCase();
    const status = String(rawCont.Status || rawCont.status || "");
    const isRunning = state === "running" || status.toLowerCase().startsWith("up");
    const containerNumber = labels["com.docker.compose.container-number"] || "1";

    const contNode = {
      id,
      shortId,
      name,
      state,
      status,
      isRunning,
      containerNumber,
      image: rawCont.Image || rawCont.image || "",
      ports: rawCont.Ports || rawCont.ports || "",
      labels,
      raw: rawCont,
    };

    if (projectName) {
      // Compose container
      const proj = getOrCreateProject(projectName);
      proj.totalCount += 1;
      if (isRunning) proj.runningCount += 1;

      const wd = labels["com.docker.compose.project.working_dir"];
      if (wd) proj.workingDirs.add(wd);

      const cf = labels["com.docker.compose.project.config_files"];
      if (cf) {
        for (const f of cf.split(",")) {
          if (f.trim()) proj.configFiles.add(f.trim());
        }
      }

      const svcKey = serviceName || name;
      if (!proj.servicesMap.has(svcKey)) {
        proj.servicesMap.set(svcKey, {
          name: svcKey,
          project: projectName,
          status: status || state,
          running: isRunning,
          containers: [],
          declared: false,
          config: null,
          ports: contNode.ports,
        });
      }
      const svcNode = proj.servicesMap.get(svcKey);
      svcNode.containers.push(contNode);
      if (isRunning) svcNode.running = true;
    } else if (sourceDockerfile) {
      // Container carrying `herdr.docker-manager.source`
      dockerfileContainers.push({
        source: sourceDockerfile,
        container: contNode,
      });
    } else {
      // Standalone container
      standaloneContainers.push(contNode);
    }
  }

  // 4. Finalize Compose projects
  const projects = [];

  for (const proj of projectsMap.values()) {
    // Check mixedSources (DM-25)
    proj.mixedSources = proj.workingDirs.size > 1;

    // Check inSpace (DM-21)
    if (spaceRoot) {
      let matchedSpace = false;
      for (const wd of proj.workingDirs) {
        if (isPathEqualOrInside(wd, spaceRoot)) {
          matchedSpace = true;
          break;
        }
      }
      if (!matchedSpace) {
        for (const cf of proj.configFiles) {
          if (isPathEqualOrInside(cf, spaceRoot)) {
            matchedSpace = true;
            break;
          }
        }
      }
      proj.inSpace = matchedSpace;
    } else {
      proj.inSpace = false;
    }

    // Merge declared services from compose config
    const declaredServices =
      proj.discoveredConfig?.config?.services ||
      proj.discoveredConfig?.services ||
      null;

    const declaredOrder = new Map();

    if (declaredServices && typeof declaredServices === "object") {
      let orderIdx = 0;
      for (const [svcName, svcConfig] of Object.entries(declaredServices)) {
        declaredOrder.set(svcName, orderIdx++);
        const svcProfiles = Array.isArray(svcConfig?.profiles) ? svcConfig.profiles : [];
        const isInactiveProfile =
          svcProfiles.length > 0 &&
          !svcProfiles.some((p) => activeProfiles.includes(p));

        if (proj.servicesMap.has(svcName)) {
          const existing = proj.servicesMap.get(svcName);
          existing.declared = true;
          existing.config = svcConfig;
        } else {
          // Service present in compose config with 0 containers
          if (isInactiveProfile) {
            // Inactive profile service (DM-33)
            proj.inactiveProfiles.push({
              name: svcName,
              project: proj.name,
              status: "not-created",
              created: false,
              running: false,
              profiles: svcProfiles,
              config: svcConfig,
              containers: [],
            });
          } else {
            // Synthetic not-created service (DM-24)
            proj.servicesMap.set(svcName, {
              name: svcName,
              project: proj.name,
              status: "not-created",
              created: false,
              running: false,
              declared: true,
              config: svcConfig,
              containers: [],
              ports: "",
            });
          }
        }
      }
    }

    // Sort services and replicas
    const services = Array.from(proj.servicesMap.values());
    services.sort((a, b) => {
      const idxA = declaredOrder.has(a.name) ? declaredOrder.get(a.name) : 9999;
      const idxB = declaredOrder.has(b.name) ? declaredOrder.get(b.name) : 9999;
      if (idxA !== idxB) return idxA - idxB;
      return a.name.localeCompare(b.name);
    });

    for (const svc of services) {
      svc.containers.sort((a, b) => {
        const numA = parseInt(a.containerNumber || "1", 10) || 1;
        const numB = parseInt(b.containerNumber || "1", 10) || 1;
        if (numA !== numB) return numA - numB;
        return a.name.localeCompare(b.name);
      });
    }

    // Aggregate status
    if (proj.totalCount === 0) {
      proj.status = "not-created";
    } else if (proj.runningCount === proj.totalCount) {
      proj.status = "ok";
    } else if (proj.runningCount > 0) {
      proj.status = "warning";
    } else {
      proj.status = "muted";
    }

    proj.services = services;
    proj.workingDir = proj.workingDirs.values().next().value || "";
    proj.configFilesList = Array.from(proj.configFiles);

    // Apply scope filter
    if (scope === "space") {
      if (proj.inSpace) {
        projects.push(proj);
      }
    } else {
      projects.push(proj);
    }
  }

  // Stable sort projects (DM-27): inSpace first, then alphabetical
  projects.sort((a, b) => {
    if (a.inSpace !== b.inSpace) return a.inSpace ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // 5. Finalize Dockerfiles
  const dockerfilesMap = new Map();
  const discDfList = Array.isArray(discoveredDockerfiles)
    ? discoveredDockerfiles
    : Object.values(discoveredDockerfiles);

  for (const item of discDfList) {
    const p = typeof item === "string" ? item : item.path || item.absPath;
    if (!p) continue;
    dockerfilesMap.set(p, {
      path: p,
      absPath: typeof item === "object" ? item.absPath || p : p,
      inSpace: spaceRoot ? isPathEqualOrInside(p, spaceRoot) : false,
      containers: [],
    });
  }

  for (const { source, container } of dockerfileContainers) {
    if (!dockerfilesMap.has(source)) {
      dockerfilesMap.set(source, {
        path: source,
        absPath: source,
        inSpace: spaceRoot ? isPathEqualOrInside(source, spaceRoot) : false,
        containers: [],
      });
    }
    dockerfilesMap.get(source).containers.push(container);
  }

  let dockerfiles = Array.from(dockerfilesMap.values());
  if (scope === "space") {
    dockerfiles = dockerfiles.filter((df) => df.inSpace);
  }

  // 6. Finalize Standalone Containers (DM-36)
  // Standalone containers are hidden when scope === "space"
  const standalone = scope === "space" ? [] : standaloneContainers;

  return {
    projects,
    dockerfiles,
    standalone,
  };
}

/**
 * Resolves the space root directory and remote machine identifier (DESIGN Section 3).
 *
 * Follows the workspace standard:
 * 1. props.folder || props.cwd and props.on
 * 2. Active space pinned location -> focused cwd -> space.folder
 *
 * @param {any} context
 * @returns {{ root: string | null, machine: string | null }}
 */
export function resolveDockerContext({
  props: getProps = {},
  spaces: getSpaces = () => [],
  panes: _getPanes = () => [],
  terminals: _getTerminals = () => [],
  focused: getFocused = () => null,
  shared: getShared = () => null,
  currentRoot = null,
} = {}) {
  const p = typeof getProps === "function" ? getProps() : getProps || {};
  if (p.folder || p.cwd) {
    return {
      root: p.folder || p.cwd,
      machine: p.on ?? null,
    };
  }

  const spaceList = typeof getSpaces === "function" ? getSpaces() : getSpaces || [];
  const activeSpace = spaceList.find((s) => s.active) || spaceList[0];
  if (activeSpace) {
    const machine = activeSpace.machine ?? null;
    const pinnedMap = typeof getShared === "function" ? getShared("spaces.pinned_locations") : null;
    const pinned = pinnedMap && activeSpace.id ? pinnedMap[activeSpace.id] : null;
    if (pinned) {
      return { root: pinned, machine };
    }
    const foc = typeof getFocused === "function" ? getFocused() : null;
    if (foc && foc.space === activeSpace.id && foc.cwd) {
      return { root: foc.cwd, machine };
    }
    return { root: activeSpace.folder || currentRoot || null, machine };
  }

  return { root: currentRoot || null, machine: null };
}
