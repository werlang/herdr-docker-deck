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

  const imageId = data.Image || "";
  const shortImageId = imageId.replace(/^sha256:/, "").slice(0, 12);

  return {
    id,
    shortId,
    name,
    project,
    service,
    image: data.Config?.Image || "",
    imageId,
    shortImageId,
    imageShortId: shortImageId,
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
 * Formats a container restart policy into a human-readable display string (DM-41).
 *
 * @param {{ name?: string, maximumRetryCount?: number } | null | undefined} policy
 * @returns {string}
 */
export function formatRestartPolicy(policy) {
  if (!policy || !policy.name || policy.name === "no") return "no";
  if (policy.name === "on-failure") {
    return policy.maximumRetryCount > 0 ? `on-failure:${policy.maximumRetryCount}` : "on-failure";
  }
  return policy.name;
}

/**
 * Formats an image name and short id for drawer display (DM-41).
 *
 * @param {string | null | undefined} image
 * @param {string | null | undefined} shortImageId
 * @returns {string}
 */
export function formatImageLabel(image, shortImageId) {
  const img = image || "";
  const sid = shortImageId || "";
  if (img && sid && !img.includes(sid)) {
    return `${img} (${sid})`;
  }
  return img || sid || "";
}

/**
 * Formats ports into drawer rows with display label, copy value, and clickable url (DM-41).
 *
 * @param {Array<{ hostIp?: string | null, hostPort?: string | null, containerPort: string, proto?: string }>} ports
 * @returns {Array<{ label: string, url: string | null, copyVal: string, published: boolean }>}
 */
export function formatDrawerPortRows(ports) {
  if (!ports || !Array.isArray(ports) || ports.length === 0) return [];
  const results = [];
  const seen = new Set();

  for (const p of ports) {
    if (!p || !p.containerPort) continue;
    const proto = p.proto || "tcp";
    const hasHost = Boolean(p.hostPort);
    const hostPort = p.hostPort ? String(p.hostPort) : null;
    const containerPort = String(p.containerPort);

    let label;
    let url = null;
    let copyVal;

    if (hasHost) {
      const hostIp =
        p.hostIp && p.hostIp !== "0.0.0.0" && p.hostIp !== "::" && p.hostIp !== "[::]"
          ? p.hostIp
          : null;
      const hostPart = hostIp ? `${hostIp}:${hostPort}` : hostPort;
      label = `${hostPart} → ${containerPort}/${proto}`;
      url = `http://localhost:${hostPort}`;
      copyVal = url;
    } else {
      label = `${containerPort}/${proto}`;
      copyVal = label;
    }

    const dedupeKey = `${hasHost ? "pub" : "unpub"}:${label}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      results.push({
        label,
        url,
        copyVal,
        published: hasHost,
      });
    }
  }

  return results;
}

/**
 * Formats mounts into drawer rows with display text, copy value, and isNamed volume flag (DM-41).
 *
 * @param {Array<{ type?: string, name?: string | null, source?: string, destination?: string, rw?: boolean }>} mounts
 * @returns {Array<{ text: string, isNamed: boolean, name: string | null, source: string, destination: string, copyVal: string }>}
 */
export function formatDrawerMounts(mounts) {
  if (!mounts || !Array.isArray(mounts) || mounts.length === 0) return [];
  return mounts.map((m) => {
    const isNamed = m.type === "volume" && Boolean(m.name);
    const src = isNamed ? m.name : m.source;
    const mode = m.rw === false ? "ro" : "rw";
    const text = `${m.type || "bind"}: ${src} → ${m.destination} (${mode})`;
    const copyVal = m.name || m.source || text;
    return {
      text,
      isNamed,
      name: m.name || null,
      source: m.source || "",
      destination: m.destination || "",
      copyVal,
    };
  });
}

/**
 * Formats networks into drawer rows with display text, copy value, and name (DM-41).
 *
 * @param {Array<{ name: string, ipAddress?: string, aliases?: string[] }>} networks
 * @returns {Array<{ text: string, name: string, ipAddress: string, copyVal: string }>}
 */
export function formatDrawerNetworks(networks) {
  if (!networks || !Array.isArray(networks) || networks.length === 0) return [];
  return networks.map((n) => {
    const aliasStr = n.aliases && n.aliases.length > 0 ? ` [${n.aliases.join(", ")}]` : "";
    const ipStr = n.ipAddress ? ` (${n.ipAddress})` : "";
    const text = `${n.name}${ipStr}${aliasStr}`;
    const copyVal = n.ipAddress || n.name;
    return {
      text,
      name: n.name,
      ipAddress: n.ipAddress || "",
      copyVal,
    };
  });
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
          existing.declaredOrder = orderIdx;
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
              declaredOrder: orderIdx,
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
              declaredOrder: orderIdx,
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
    } else {
      proj.status = aggregateProjectStatus(services);
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
  const rawP = typeof getProps === "function" ? getProps() : getProps;
  const p = rawP || {};
  if (p.folder || p.cwd) {
    return {
      root: p.folder || p.cwd,
      machine: p.on ?? null,
    };
  }

  const rawSpaces = typeof getSpaces === "function" ? getSpaces() : getSpaces;
  const spaceList = Array.isArray(rawSpaces) ? rawSpaces : [];
  const activeSpace = spaceList.find((s) => s && s.active) || spaceList[0];
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

/**
 * Determines whether a layout node is visible in the current window tree.
 *
 * @param {any} root
 * @param {string | ((node: any) => boolean)} targetOrPredicate
 * @returns {boolean}
 */
export function isLayoutNodeVisible(root, targetOrPredicate) {
  if (!root) return true;
  const match =
    typeof targetOrPredicate === "function"
      ? targetOrPredicate
      : (node) => node?.id === targetOrPredicate || node?.content?.mod === targetOrPredicate;

  function findPath(node, path) {
    if (match(node)) return [...path, node];
    for (const child of node?.children ?? []) {
      const res = findPath(child, [...path, node]);
      if (res) return res;
    }
    return null;
  }

  const path = findPath(root, []);
  if (!path) return true;

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (node.hidden) return false;
    if (node.type === "stack" && i + 1 < path.length) {
      const activeId = node.active ?? node.children?.[0]?.id;
      if (activeId && activeId !== path[i + 1].id) return false;
    }
  }
  return true;
}

/**
 * Parses `docker compose ls --all --format json` output.
 *
 * @param {string | any[]} stdout
 * @returns {Array<{ name: string, status: string, configFiles: string, Name: string, Status: string, ConfigFiles: string, raw: any }>}
 */
export function parseComposeLs(stdout) {
  if (!stdout) return [];
  if (Array.isArray(stdout)) {
    return stdout.map((item) => {
      const name = item.Name || item.name || "";
      const status = item.Status || item.status || "";
      const configFiles = item.ConfigFiles || item.configFiles || "";
      return {
        name,
        status,
        configFiles,
        Name: name,
        Status: status,
        ConfigFiles: configFiles,
        raw: item,
      };
    });
  }
  if (typeof stdout !== "string") return [];
  const text = stdout.trim();
  if (!text) return [];

  let items = [];
  if (text.startsWith("[")) {
    try {
      items = JSON.parse(text);
    } catch {
      items = [];
    }
  } else {
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        items.push(JSON.parse(l));
      } catch {}
    }
  }

  if (!Array.isArray(items)) {
    if (typeof items === "object" && items !== null) items = [items];
    else return [];
  }

  return items.map((item) => {
    const name = item.Name || item.name || "";
    const status = item.Status || item.status || "";
    const configFiles = item.ConfigFiles || item.configFiles || "";
    return {
      name,
      status,
      configFiles,
      Name: name,
      Status: status,
      ConfigFiles: configFiles,
      raw: item,
    };
  });
}

/**
 * Parses `docker info --format '{{json .}}'` output.
 *
 * @param {string | any} stdout
 * @returns {any}
 */
export function parseEngineInfo(stdout) {
  if (!stdout) return null;
  let info = null;
  if (typeof stdout === "object") {
    info = stdout;
  } else if (typeof stdout === "string") {
    const text = stdout.trim();
    if (!text) return null;
    try {
      info = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!info || typeof info !== "object") return null;

  return {
    serverVersion: info.ServerVersion || info.Server?.Version || "",
    ServerVersion: info.ServerVersion || info.Server?.Version || "",
    containers: typeof info.Containers === "number" ? info.Containers : 0,
    containersRunning: typeof info.ContainersRunning === "number" ? info.ContainersRunning : 0,
    containersPaused: typeof info.ContainersPaused === "number" ? info.ContainersPaused : 0,
    containersStopped: typeof info.ContainersStopped === "number" ? info.ContainersStopped : 0,
    images: typeof info.Images === "number" ? info.Images : 0,
    operatingSystem: info.OperatingSystem || "",
    architecture: info.Architecture || "",
    raw: info,
  };
}

/**
 * Determines Docker engine reachable / daemon-down / cli-missing state from probe results.
 *
 * @param {{ info?: any, versionProbe?: any }} options
 * @returns {{ status: "reachable" | "daemon-down" | "cli-missing", version: string | null, reachable: boolean, error: string | null }}
 */
export function engineStateFromResults({ info = null, versionProbe = null } = {}) {
  // 1. Check CLI missing
  const vErr = versionProbe?.error || (versionProbe?.code === 127 ? "not found" : null);
  const iErr = info?.error || (info?.code === 127 ? "not found" : null);
  const vStderr = String(versionProbe?.stderr || "").toLowerCase();
  const iStderr = String(info?.stderr || "").toLowerCase();

  const isCliMissing =
    (vErr && /enoent|not found|not recognized|not installed/i.test(String(vErr))) ||
    (iErr && /enoent|not found|not recognized|not installed/i.test(String(iErr))) ||
    vStderr.includes("command not found") ||
    iStderr.includes("command not found") ||
    versionProbe?.code === 127 ||
    info?.code === 127 ||
    (!info && !versionProbe);

  if (isCliMissing) {
    return {
      status: "cli-missing",
      version: null,
      reachable: false,
      error: "Docker CLI not found",
    };
  }

  // 2. Extract potential version string
  let version = null;
  if (typeof versionProbe === "string") {
    const m = versionProbe.match(/(?:version\s+)?([0-9]+\.[0-9]+(?:\.[0-9]+[a-z0-9.-]*)?)/i);
    if (m) version = m[1];
  } else if (versionProbe && typeof versionProbe === "object") {
    if (versionProbe.Server?.Version) {
      version = versionProbe.Server.Version;
    } else if (versionProbe.stdout) {
      try {
        const parsed = JSON.parse(versionProbe.stdout);
        version = parsed.Server?.Version || parsed.Client?.Version || null;
      } catch {
        const m = versionProbe.stdout.match(/(?:version\s+)?([0-9]+\.[0-9]+(?:\.[0-9]+[a-z0-9.-]*)?)/i);
        if (m) version = m[1];
      }
    }
  }

  if (!version && info) {
    const parsed = typeof info === "string" ? parseEngineInfo(info) : info.stdout ? parseEngineInfo(info.stdout) : info;
    if (parsed?.serverVersion || parsed?.ServerVersion) {
      version = parsed.serverVersion || parsed.ServerVersion;
    }
  }

  // 3. Check daemon down
  const isDaemonDown =
    vStderr.includes("cannot connect to the docker daemon") ||
    iStderr.includes("cannot connect to the docker daemon") ||
    vStderr.includes("is the docker daemon running") ||
    iStderr.includes("is the docker daemon running") ||
    vStderr.includes("daemon is not running") ||
    iStderr.includes("daemon is not running") ||
    vStderr.includes("connection refused") ||
    iStderr.includes("connection refused") ||
    (info && info.code !== 0 && !info.serverVersion && !info.ServerVersion) ||
    (versionProbe && versionProbe.code !== 0 && !versionProbe.Server?.Version);

  if (isDaemonDown && (!info || info.code !== 0) && (!versionProbe || !versionProbe.Server?.Version)) {
    return {
      status: "daemon-down",
      version: null,
      reachable: false,
      error: (info?.stderr || versionProbe?.stderr || "Docker daemon is not reachable").trim(),
    };
  }

  return {
    status: "reachable",
    version: version || "Docker",
    reachable: true,
    error: null,
  };
}

/**
 * Parses `docker compose config --format json` output.
 *
 * @param {string | any} stdout
 * @returns {{ name: string, services: Record<string, any>, raw: any }}
 */
export function parseComposeConfig(stdout) {
  if (!stdout) return { name: "", services: {}, raw: null };
  let data = null;
  if (typeof stdout === "object") {
    data = stdout;
  } else if (typeof stdout === "string") {
    const text = stdout.trim();
    if (!text) return { name: "", services: {}, raw: null };
    try {
      data = JSON.parse(text);
    } catch {
      return { name: "", services: {}, raw: null };
    }
  }
  if (!data || typeof data !== "object") return { name: "", services: {}, raw: null };

  const services = {};
  for (const [svcName, svcDef] of Object.entries(data.services || {})) {
    if (!svcDef) continue;
    services[svcName] = {
      name: svcName,
      image: svcDef.image || null,
      build: svcDef.build || null,
      ports: Array.isArray(svcDef.ports) ? svcDef.ports : [],
      profiles: Array.isArray(svcDef.profiles) ? svcDef.profiles : [],
      volumes: Array.isArray(svcDef.volumes) ? svcDef.volumes : [],
      networks: svcDef.networks || null,
      environment: svcDef.environment || {},
      dependsOn: svcDef.depends_on || svcDef.dependsOn || [],
      raw: svcDef,
    };
  }

  return {
    name: data.name || "",
    services,
    raw: data,
  };
}

/**
 * Groups discovered Compose file paths by directory and pairs base files with overrides (DM-32).
 *
 * @param {string[]} paths
 * @returns {Array<{ dir: string, file: string, files: string[], isOverride: boolean, override?: string | null, variant?: string }>}
 */
export function discoverComposeGroups(paths = []) {
  if (!Array.isArray(paths)) return [];

  const byDir = new Map();
  for (const p of paths) {
    if (!p || typeof p !== "string") continue;
    const slashIdx = p.lastIndexOf("/");
    const dir = slashIdx === -1 ? "." : p.slice(0, slashIdx);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(p);
  }

  const result = [];

  for (const [dir, fileList] of byDir.entries()) {
    const baseFiles = [];
    const overrideFiles = [];
    const variantFiles = [];

    for (const filePath of fileList) {
      const cls = classifyDockerFile(filePath);
      if (!cls || !cls.isCompose) continue;
      if (cls.isOverride) {
        overrideFiles.push(filePath);
      } else if (cls.variant) {
        variantFiles.push({ path: filePath, variant: cls.variant });
      } else {
        baseFiles.push(filePath);
      }
    }

    const pairedOverrides = new Set();

    for (const base of baseFiles) {
      const baseName = base.slice(base.lastIndexOf("/") + 1).toLowerCase();
      let matchedOverride = null;
      for (const ov of overrideFiles) {
        if (pairedOverrides.has(ov)) continue;
        const ovName = ov.slice(ov.lastIndexOf("/") + 1).toLowerCase();
        if (
          (baseName.startsWith("docker-compose") && ovName.startsWith("docker-compose.override")) ||
          (baseName.startsWith("compose") && !baseName.startsWith("docker-compose") && ovName.startsWith("compose.override"))
        ) {
          matchedOverride = ov;
          break;
        }
      }
      if (!matchedOverride) {
        for (const ov of overrideFiles) {
          if (!pairedOverrides.has(ov)) {
            matchedOverride = ov;
            break;
          }
        }
      }

      if (matchedOverride) {
        pairedOverrides.add(matchedOverride);
        result.push({
          dir,
          file: base,
          files: [base, matchedOverride],
          isOverride: false,
          override: matchedOverride,
        });
      } else {
        result.push({
          dir,
          file: base,
          files: [base],
          isOverride: false,
          override: null,
        });
      }
    }

    for (const ov of overrideFiles) {
      if (!pairedOverrides.has(ov)) {
        result.push({
          dir,
          file: ov,
          files: [ov],
          isOverride: true,
          override: ov,
        });
      }
    }

    for (const v of variantFiles) {
      result.push({
        dir,
        file: v.path,
        files: [v.path],
        isOverride: false,
        variant: v.variant,
      });
    }
  }

  return result;
}

/**
 * Aggregates service statuses into an overall Compose project status (DM-21).
 *
 * Rules:
 * - any unhealthy, restarting, or dead -> "error"
 * - all running -> "ok"
 * - mixed -> "warning"
 * - none -> "muted"
 *
 * @param {any[]} services
 * @returns {"ok" | "warning" | "muted" | "error"}
 */
export function aggregateProjectStatus(services = []) {
  if (!Array.isArray(services) || services.length === 0) return "muted";

  for (const svc of services) {
    const sStatus = String(svc.status || "").toLowerCase();
    const sState = String(svc.state || "").toLowerCase();
    const sHealth = String(svc.health?.status || svc.health || "").toLowerCase();

    if (
      sHealth === "unhealthy" ||
      sStatus.includes("unhealthy") ||
      sState === "restarting" ||
      sStatus.includes("restarting") ||
      sState === "dead" ||
      sStatus.includes("dead")
    ) {
      return "error";
    }

    if (Array.isArray(svc.containers)) {
      for (const c of svc.containers) {
        const cStatus = String(c.status || "").toLowerCase();
        const cState = String(c.state || "").toLowerCase();
        const cHealth = String(c.health?.status || c.health || "").toLowerCase();
        if (
          cHealth === "unhealthy" ||
          cStatus.includes("unhealthy") ||
          cState === "restarting" ||
          cStatus.includes("restarting") ||
          cState === "dead" ||
          cStatus.includes("dead")
        ) {
          return "error";
        }
      }
    }
  }

  let runningCount = 0;
  let partialServiceFound = false;

  for (const svc of services) {
    if (Array.isArray(svc.containers) && svc.containers.length > 0) {
      const runningInSvc = svc.containers.filter(
        (c) =>
          c.isRunning ||
          c.running ||
          String(c.state || "").toLowerCase() === "running" ||
          String(c.status || "").toLowerCase().startsWith("up")
      ).length;

      if (runningInSvc === svc.containers.length) {
        runningCount++;
      } else if (runningInSvc > 0) {
        partialServiceFound = true;
      }
    } else {
      const sStatus = String(svc.status || "").toLowerCase();
      const sState = String(svc.state || "").toLowerCase();
      if (svc.running === true || sState === "running" || sStatus.startsWith("up")) {
        runningCount++;
      }
    }
  }

  if (partialServiceFound) return "warning";
  if (runningCount === services.length && services.length > 0) return "ok";
  if (runningCount > 0) return "warning";
  return "muted";
}

/**
 * Matches a row against a search query string across name, image, service, project, and ports (DM-12).
 * Empty query matches everything. Case-insensitive substring match.
 *
 * @param {any} row
 * @param {string} query
 * @returns {boolean}
 */
export function matchesFilter(row, query) {
  if (!query || typeof query !== "string") return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (!row) return false;

  const name = String(row.name || row.data?.name || "").toLowerCase();
  if (name.includes(q)) return true;

  const image = String(row.image || row.data?.image || "").toLowerCase();
  if (image.includes(q)) return true;

  const service = String(row.service || row.data?.service || "").toLowerCase();
  if (service.includes(q)) return true;

  const project = String(row.project || row.data?.project || "").toLowerCase();
  if (project.includes(q)) return true;

  const ports = String(row.ports || row.publishedPorts || row.port || row.data?.ports || "");
  if (ports.toLowerCase().includes(q)) return true;

  if (Array.isArray(row.ports)) {
    if (JSON.stringify(row.ports).toLowerCase().includes(q)) return true;
  }
  if (Array.isArray(row.data?.ports)) {
    if (JSON.stringify(row.data.ports).toLowerCase().includes(q)) return true;
  }

  return false;
}

/**
 * Flattens a project -> service -> replica tree into a linear list of render rows (DM-20..27).
 *
 * Ordering:
 * 1. Projects: inSpace first, then alphabetical by name.
 * 2. Services: declaration order from compose config, then alphabetical.
 * 3. Replicas: numerically by container number.
 * 4. Dockerfiles & Standalone containers.
 *
 * @param {{ projects?: any[], dockerfiles?: any[], standalone?: any[] }} tree
 * @param {any} expandState
 * @returns {any[]}
 */
export function flattenContainerRows(tree = {}, expandState = null) {
  const rows = [];
  if (!tree) return rows;

  const projects = Array.isArray(tree.projects) ? [...tree.projects] : [];
  projects.sort((a, b) => {
    const aInSpace = Boolean(a.inSpace);
    const bInSpace = Boolean(b.inSpace);
    if (aInSpace !== bInSpace) return aInSpace ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  for (const proj of projects) {
    let isProjExpanded = false;
    if (expandState instanceof Set) {
      isProjExpanded = expandState.has(proj.name) || expandState.has(`project:${proj.name}`);
    } else if (typeof expandState === "function") {
      isProjExpanded = Boolean(expandState(proj.name));
    } else if (typeof expandState === "object" && expandState !== null) {
      if (proj.name in expandState) isProjExpanded = Boolean(expandState[proj.name]);
      else if (`project:${proj.name}` in expandState) isProjExpanded = Boolean(expandState[`project:${proj.name}`]);
      else isProjExpanded = Boolean(proj.inSpace);
    } else {
      isProjExpanded = Boolean(proj.inSpace);
    }

    const services = Array.isArray(proj.services) ? [...proj.services] : [];
    const projStatus = proj.status || aggregateProjectStatus(services);

    rows.push({
      type: "project",
      kind: "project",
      id: `project:${proj.name}`,
      key: `project:${proj.name}`,
      name: proj.name,
      project: proj.name,
      status: projStatus,
      runningCount: proj.runningCount || 0,
      totalCount: proj.totalCount || 0,
      inSpace: Boolean(proj.inSpace),
      mixedSources: Boolean(proj.mixedSources),
      configFiles: proj.configFilesList || Array.from(proj.configFiles || []),
      expanded: isProjExpanded,
      depth: 0,
      data: proj,
    });

    if (isProjExpanded) {
      services.sort((a, b) => {
        const orderA = typeof a.declaredOrder === "number" ? a.declaredOrder : 9999;
        const orderB = typeof b.declaredOrder === "number" ? b.declaredOrder : 9999;
        if (orderA !== orderB) return orderA - orderB;
        return (a.name || "").localeCompare(b.name || "");
      });

      for (const svc of services) {
        const isNotCreated =
          svc.status === "not-created" ||
          svc.created === false ||
          (!svc.containers?.length && svc.declared);
        const svcStatus = isNotCreated ? "not-created" : (svc.status || (svc.running ? "running" : "stopped"));

        const containers = Array.isArray(svc.containers) ? [...svc.containers] : [];
        const hasReplicas = containers.length > 1;

        let isSvcExpanded = false;
        if (hasReplicas) {
          const k1 = `${proj.name}/${svc.name}`;
          const k2 = `${proj.name}:${svc.name}`;
          const k3 = svc.name;
          if (expandState instanceof Set) {
            isSvcExpanded = expandState.has(k1) || expandState.has(k2) || expandState.has(k3) || expandState.has(proj.name);
          } else if (typeof expandState === "object" && expandState !== null) {
            if (k1 in expandState) isSvcExpanded = Boolean(expandState[k1]);
            else if (k2 in expandState) isSvcExpanded = Boolean(expandState[k2]);
            else if (k3 in expandState) isSvcExpanded = Boolean(expandState[k3]);
            else isSvcExpanded = true;
          } else {
            isSvcExpanded = true;
          }
        }

        const targetCont = containers.length > 0 ? containers[0] : null;
        const containerId = targetCont ? targetCont.id : "";
        const shortId = targetCont ? (targetCont.shortId || targetCont.id?.slice(0, 12)) : "";
        const image = targetCont ? targetCont.image : (svc.config?.image || "");
        const ports = targetCont ? targetCont.ports : (svc.ports || "");

        rows.push({
          type: "service",
          kind: "service",
          id: `service:${proj.name}/${svc.name}`,
          key: `service:${proj.name}/${svc.name}`,
          name: svc.name,
          service: svc.name,
          project: proj.name,
          status: svcStatus,
          state: svc.state || (isNotCreated ? "not-created" : (svc.running ? "running" : "exited")),
          running: Boolean(svc.running),
          declared: Boolean(svc.declared),
          created: !isNotCreated,
          containerCount: containers.length,
          hasReplicas,
          containerId,
          shortId,
          image,
          ports,
          workingDir: proj.workingDir,
          configFiles: proj.configFiles,
          hasConfigFiles: proj.hasConfigFiles,
          expanded: isSvcExpanded,
          depth: 1,
          data: svc,
        });

        if (hasReplicas && isSvcExpanded) {
          containers.sort((a, b) => {
            const numA = parseInt(a.containerNumber || "1", 10) || 1;
            const numB = parseInt(b.containerNumber || "1", 10) || 1;
            if (numA !== numB) return numA - numB;
            return (a.name || "").localeCompare(b.name || "");
          });

          for (const c of containers) {
            rows.push({
              type: "container",
              kind: "container",
              id: `container:${c.id || c.name}`,
              key: `container:${c.id || c.name}`,
              name: c.name,
              containerId: c.id,
              shortId: c.shortId || (c.id ? c.id.slice(0, 12) : ""),
              service: svc.name,
              project: proj.name,
              workingDir: proj.workingDir,
              configFiles: proj.configFiles,
              hasConfigFiles: proj.hasConfigFiles,
              containerNumber: c.containerNumber || "1",
              status: c.status || c.state || "",
              state: c.state || "",
              running: Boolean(c.isRunning || c.running || c.state === "running"),
              image: c.image || "",
              ports: c.ports || "",
              depth: 2,
              data: c,
            });
          }
        }
      }
    }
  }

  // Dockerfiles
  const dockerfiles = Array.isArray(tree.dockerfiles) ? [...tree.dockerfiles] : [];
  for (const df of dockerfiles) {
    let isDfExpanded = false;
    if (expandState instanceof Set) {
      isDfExpanded = expandState.has(df.path);
    } else if (typeof expandState === "object" && expandState !== null && df.path in expandState) {
      isDfExpanded = Boolean(expandState[df.path]);
    } else {
      isDfExpanded = Boolean(df.inSpace);
    }

    rows.push({
      type: "dockerfile",
      kind: "dockerfile",
      id: `dockerfile:${df.path}`,
      key: `dockerfile:${df.path}`,
      name: df.path,
      path: df.path,
      inSpace: Boolean(df.inSpace),
      containerCount: df.containers?.length || 0,
      expanded: isDfExpanded,
      depth: 0,
      data: df,
    });

    if (isDfExpanded && Array.isArray(df.containers)) {
      for (const c of df.containers) {
        rows.push({
          type: "container",
          kind: "container",
          id: `container:${c.id || c.name}`,
          key: `container:${c.id || c.name}`,
          name: c.name,
          containerId: c.id,
          shortId: c.shortId || (c.id ? c.id.slice(0, 12) : ""),
          service: "",
          project: "",
          status: c.status || "",
          state: c.state || "",
          running: Boolean(c.isRunning || c.running),
          image: c.image || "",
          ports: c.ports || "",
          depth: 1,
          data: c,
        });
      }
    }
  }

  // Standalone
  const standalone = Array.isArray(tree.standalone) ? [...tree.standalone] : [];
  standalone.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  for (const c of standalone) {
    rows.push({
      type: "container",
      kind: "container",
      id: `standalone:${c.id || c.name}`,
      key: `standalone:${c.id || c.name}`,
      name: c.name,
      containerId: c.id,
      shortId: c.shortId || (c.id ? c.id.slice(0, 12) : ""),
      service: "",
      project: "",
      isStandalone: true,
      status: c.status || "",
      state: c.state || "",
      running: Boolean(c.isRunning || c.running || c.state === "running"),
      image: c.image || "",
      ports: c.ports || "",
      depth: 0,
      data: c,
    });
  }

  return rows;
}

// =============================================================================
// Section 7 & Acceptance Criteria 2 Pure Functions (R3)
// =============================================================================

/**
 * Formats raw docker Ports string or inspect bindings into compact port pills (DM-22).
 *
 * Drops host IPs (`0.0.0.0:`, `[::]:`) and protocols (`/tcp`), formats published mappings as `host→container`,
 * deduplicates identical mappings (e.g. IPv4 + IPv6 pairs), and marks unmapped exposed ports (e.g. `9000-9001/tcp`)
 * as unpublished (`published: false`).
 *
 * @param {string | any[] | null | undefined} rawPorts
 * @returns {Array<{ text: string, published: boolean, hostPort: string | null, containerPort: string }>}
 */
export function formatPortMappings(rawPorts) {
  if (!rawPorts) return [];

  const results = [];
  const seen = new Set();

  if (typeof rawPorts === "string") {
    const trimmed = rawPorts.trim();
    if (!trimmed) return [];

    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.includes("->")) {
        // Published mapping, e.g. "0.0.0.0:8080->8080/tcp" or "[::]:8080->8080/tcp"
        const [left, right] = part.split("->").map((s) => s.trim());
        let hostPort = left;
        if (hostPort.includes("]:")) {
          hostPort = hostPort.slice(hostPort.lastIndexOf("]:") + 2);
        } else if (hostPort.includes(":")) {
          hostPort = hostPort.slice(hostPort.lastIndexOf(":") + 1);
        }

        let containerPort = right;
        if (containerPort.includes("/")) {
          containerPort = containerPort.slice(0, containerPort.indexOf("/"));
        }

        const text = `${hostPort}→${containerPort}`;
        const key = `pub:${text}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            text,
            published: true,
            hostPort,
            containerPort,
            toString() {
              return this.text;
            },
          });
        }
      } else {
        // Exposed port without host publish, e.g. "9000-9001/tcp" or "80/tcp"
        let containerPort = part;
        if (containerPort.includes("/")) {
          containerPort = containerPort.slice(0, containerPort.indexOf("/"));
        }
        const text = containerPort;
        const key = `unpub:${text}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            text,
            published: false,
            hostPort: null,
            containerPort,
            toString() {
              return this.text;
            },
          });
        }
      }
    }
  } else if (Array.isArray(rawPorts)) {
    for (const p of rawPorts) {
      if (!p) continue;
      if (typeof p === "string") {
        const sub = formatPortMappings(p);
        for (const s of sub) {
          const key = `${s.published ? "pub" : "unpub"}:${s.text}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(s);
          }
        }
      } else if (typeof p === "object") {
        const hostPort = p.hostPort ? String(p.hostPort) : null;
        const containerPort = String(p.containerPort || p.port || "");
        if (!containerPort) continue;

        if (hostPort) {
          const text = `${hostPort}→${containerPort}`;
          const key = `pub:${text}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              text,
              published: true,
              hostPort,
              containerPort,
              toString() {
                return this.text;
              },
            });
          }
        } else {
          const text = containerPort;
          const key = `unpub:${text}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              text,
              published: false,
              hostPort: null,
              containerPort,
              toString() {
                return this.text;
              },
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Returns the confirmation mode for an action: "typed", "plain", or "none".
 *
 * "typed" for `down -v`, `container.remove`, `volume.restore`, `prune.*`.
 * "plain" for `down`, `container.kill`, `service.remove`.
 * "none" otherwise.
 *
 * @param {string | { id?: string }} item
 * @returns {"typed" | "plain" | "none"}
 */
export function confirmKind(item) {
  const id = typeof item === "string" ? item : (item?.id || "");
  if (
    id === "project.down_volumes" ||
    id === "down -v" ||
    id === "container.remove" ||
    id === "container.rm" ||
    id === "volume.restore" ||
    id.startsWith("prune") ||
    id.startsWith("image.prune_unused") ||
    id.startsWith("system.prune")
  ) {
    return "typed";
  }
  if (
    id === "project.down" ||
    id === "down" ||
    id === "container.kill" ||
    id === "service.remove" ||
    id === "service.rm"
  ) {
    return "plain";
  }
  return "none";
}

/**
 * Returns whether an action requires confirmation before execution (DM-85..87).
 *
 * @param {string | { id?: string }} item
 * @returns {boolean}
 */
export function requiresConfirm(item) {
  return confirmKind(item) !== "none";
}

/**
 * Validates typed confirmation input (DM-86).
 * Typed confirm only enables on exact match (case-sensitive) of project name or "prune".
 *
 * @param {"typed" | "plain" | "none"} kind
 * @param {string} typed
 * @param {string} expected
 * @returns {boolean}
 */
export function validateConfirmInput(kind, typed, expected) {
  if (kind !== "typed") return true;
  if (typeof typed !== "string") return false;
  return typed === expected;
}

/**
 * Determines placement for opening a terminal ("tab" unless alt or preference === "down").
 *
 * @param {{ alt?: boolean, preference?: string }} [opts]
 * @returns {"tab" | "down"}
 */
export function terminalPlacement({ alt = false, preference = "" } = {}) {
  if (alt || preference === "down") {
    return "down";
  }
  return "tab";
}

/**
 * Matches an existing terminal whose argv equals the requested argv in the active space.
 *
 * @param {any[]} terminals
 * @param {string[]} argv
 * @param {string} [spaceId]
 * @returns {any | null}
 */
export function findReusableTerminal(terminals, argv, spaceId) {
  if (!Array.isArray(terminals) || !Array.isArray(argv) || argv.length === 0) {
    return null;
  }

  for (const t of terminals) {
    if (!t) continue;
    if (spaceId && t.space && t.space !== spaceId && t.spaceId !== spaceId) {
      continue;
    }

    const tArgv = Array.isArray(t.argv) ? t.argv : (Array.isArray(t.command) ? t.command : null);
    if (tArgv) {
      if (tArgv.length === argv.length && tArgv.every((arg, i) => arg === argv[i])) {
        return t;
      }
    }
  }

  return null;
}

/**
 * Builds the exact CLI argv for lifecycle actions across projects, services, and containers (DM-50..83).
 * Covers all 26 lifecycle actions in DESIGN.md §4.5.
 *
 * @param {string | { id?: string }} item
 * @param {any} target
 * @returns {string[]}
 */
export function buildActionArgs(item, target) {
  const actionId = typeof item === "string" ? item : (item?.id || "");
  const t = target || {};
  const kind = t.kind || t.type || (t.service ? "service" : t.project ? "project" : t.id ? "container" : "");

  // Project Actions (10)
  if (actionId === "project.up" || (actionId === "up" && kind === "project")) {
    return buildComposeArgs(t, ["up", "-d"]);
  }
  if (actionId === "project.up_build" || (actionId === "up-build" && kind === "project")) {
    return buildComposeArgs(t, ["up", "-d", "--build"]);
  }
  if (actionId === "project.start" || (actionId === "start" && kind === "project")) {
    return buildComposeArgs(t, ["start"]);
  }
  if (actionId === "project.stop" || (actionId === "stop" && kind === "project")) {
    return buildComposeArgs(t, ["stop"]);
  }
  if (actionId === "project.restart" || (actionId === "restart" && kind === "project")) {
    return buildComposeArgs(t, ["restart"]);
  }
  if (actionId === "project.pull" || (actionId === "pull" && kind === "project")) {
    return buildComposeArgs(t, ["pull"]);
  }
  if (actionId === "project.build" || (actionId === "build" && kind === "project")) {
    return buildComposeArgs(t, ["build"]);
  }
  if (actionId === "project.logs" || (actionId === "logs" && kind === "project")) {
    const composeArgs = buildComposeArgs(t, []);
    return ["docker", ...composeArgs, "logs", "-f", "--tail", "500"];
  }
  if (actionId === "project.down" || (actionId === "down" && kind === "project")) {
    return buildProjectDownArgs(t, { removeVolumes: false });
  }
  if (
    actionId === "project.down_volumes" ||
    actionId === "down -v" ||
    (actionId === "down-volume" && kind === "project")
  ) {
    return buildProjectDownVolumesArgs(t);
  }

  // Service Actions (9)
  const serviceName = t.service || t.name || "";
  if (actionId === "service.start" || (actionId === "start" && kind === "service")) {
    return buildComposeArgs(t, ["start", serviceName]);
  }
  if (actionId === "service.stop" || (actionId === "stop" && kind === "service")) {
    return buildComposeArgs(t, ["stop", serviceName]);
  }
  if (actionId === "service.restart" || (actionId === "restart" && kind === "service")) {
    return buildComposeArgs(t, ["restart", serviceName]);
  }
  if (actionId === "service.up" || (actionId === "up" && kind === "service")) {
    return buildComposeArgs(t, ["up", "-d", serviceName]);
  }
  if (actionId === "service.rebuild" || (actionId === "rebuild" && kind === "service")) {
    return buildServiceRebuildArgs(t, serviceName);
  }
  if (actionId === "service.recreate" || (actionId === "recreate" && kind === "service")) {
    return buildServiceRecreateArgs(t, serviceName);
  }
  if (actionId === "service.logs" || (actionId === "logs" && kind === "service")) {
    return buildServiceLogsArgs(t, serviceName, { tail: 500 });
  }
  if (actionId === "service.shell" || (actionId === "shell" && kind === "service")) {
    const contId = t.containerId || t.id || t.containers?.[0]?.id || "";
    return buildContainerShellArgs(contId, "auto");
  }
  if (
    actionId === "service.remove" ||
    actionId === "service.rm" ||
    (actionId === "rm" && kind === "service")
  ) {
    return buildServiceRmArgs(t, serviceName);
  }

  // Container Actions (9)
  const containerId = t.id || t.containerId || t.shortId || "";
  const isRunning = Boolean(
    t.isRunning || t.running || t.state?.running || t.state === "running"
  );

  if (actionId === "container.start" || (actionId === "start" && kind === "container")) {
    return ["start", containerId];
  }
  if (actionId === "container.stop" || (actionId === "stop" && kind === "container")) {
    return ["stop", containerId];
  }
  if (actionId === "container.restart" || (actionId === "restart" && kind === "container")) {
    return ["restart", containerId];
  }
  if (actionId === "container.pause" || (actionId === "pause" && kind === "container")) {
    return ["pause", containerId];
  }
  if (actionId === "container.unpause" || (actionId === "unpause" && kind === "container")) {
    return ["unpause", containerId];
  }
  if (actionId === "container.kill" || (actionId === "kill" && kind === "container")) {
    return ["kill", containerId];
  }
  if (
    actionId === "container.remove" ||
    actionId === "container.rm" ||
    (actionId === "rm" && kind === "container")
  ) {
    return isRunning ? ["rm", "-f", containerId] : ["rm", containerId];
  }
  if (actionId === "container.logs" || (actionId === "logs" && kind === "container")) {
    return buildContainerLogsArgs(containerId, { tail: 500 });
  }
  if (actionId === "container.shell" || (actionId === "shell" && kind === "container")) {
    return buildContainerShellArgs(containerId, "auto");
  }

  throw new Error(`Unknown action: ${actionId} for target kind: ${kind}`);
}

/**
 * Builds the exact ordered list of context menu items for a target resource (DM-50..78).
 *
 * Each item has `{ id, label, enabled, reason, ...(danger ? { danger: true } : {}) }`.
 * Destructive items are flagged `danger: true` and placed last.
 * Disabled items carry a human reason string (`compose file not found`, `container is not running`, `no published ports`).
 *
 * @param {any} target
 * @param {any} [state]
 * @returns {Array<{ id: string, label: string, enabled: boolean, reason: string | null, danger?: boolean }>}
 */
export function buildContextMenuItems(target, state = {}) {
  const t = target || {};
  const kind =
    t.kind ||
    t.type ||
    (t.service ? "service" : t.project ? "project" : t.id ? "container" : "project");

  const hasFiles = hasUsableConfigFiles(t);
  const isRunning = Boolean(
    t.isRunning ||
      t.running ||
      t.state?.running ||
      t.state === "running" ||
      (typeof t.status === "string" && t.status.toLowerCase().startsWith("up"))
  );
  const isPaused = Boolean(
    t.isPaused ||
      t.paused ||
      t.state?.paused ||
      t.state === "paused" ||
      (typeof t.status === "string" && t.status.toLowerCase().includes("paused"))
  );
  const portMappings = formatPortMappings(
    t.ports || t.publishedPorts || t.data?.ports || []
  );
  const hasPublishedPorts = portMappings.some((p) => p.published);

  if (kind === "project") {
    const nonDestructive = [
      {
        id: "project.up",
        label: "Up",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "project.up_build",
        label: "Up (build)",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "project.start",
        label: "Start",
        enabled: true,
        reason: null,
      },
      {
        id: "project.stop",
        label: "Stop",
        enabled: true,
        reason: null,
      },
      {
        id: "project.restart",
        label: "Restart",
        enabled: true,
        reason: null,
      },
      {
        id: "project.pull",
        label: "Pull images",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "project.build",
        label: "Build",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "project.logs",
        label: "Logs",
        enabled: true,
        reason: null,
      },
      {
        id: "project.open_file",
        label: "Open compose file",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "project.copy_name",
        label: "Copy project name",
        enabled: true,
        reason: null,
      },
    ];

    const destructive = [
      {
        id: "project.down",
        label: "Down",
        enabled: true,
        reason: null,
        danger: true,
      },
      {
        id: "project.down_volumes",
        label: "Down + remove volumes",
        enabled: true,
        reason: null,
        danger: true,
      },
    ];

    return [...nonDestructive, ...destructive];
  }

  if (kind === "service") {
    const nonDestructive = [
      {
        id: "service.start",
        label: "Start",
        enabled: !isRunning,
        reason: isRunning ? "container is already running" : null,
      },
      {
        id: "service.stop",
        label: "Stop",
        enabled: isRunning,
        reason: isRunning ? null : "container is not running",
      },
      {
        id: "service.restart",
        label: "Restart",
        enabled: true,
        reason: null,
      },
      {
        id: "service.up",
        label: "Up",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "service.rebuild",
        label: "Rebuild",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "service.recreate",
        label: "Recreate",
        enabled: hasFiles,
        reason: hasFiles ? null : "compose file not found",
      },
      {
        id: "service.logs",
        label: "Logs",
        enabled: true,
        reason: null,
      },
      {
        id: "service.shell",
        label: "Shell",
        enabled: isRunning,
        reason: isRunning ? null : "container is not running",
      },
      {
        id: "service.inspect",
        label: "Inspect",
        enabled: true,
        reason: null,
      },
      {
        id: "service.open_port",
        label: "Open in browser",
        enabled: hasPublishedPorts,
        reason: hasPublishedPorts ? null : "no published ports",
      },
      {
        id: "service.copy_name",
        label: "Copy service name",
        enabled: true,
        reason: null,
      },
    ];

    const destructive = [
      {
        id: "service.remove",
        label: "Remove",
        enabled: true,
        reason: null,
        danger: true,
      },
    ];

    return [...nonDestructive, ...destructive];
  }

  if (kind === "container") {
    const nonDestructive = [
      {
        id: "container.start",
        label: "Start",
        enabled: !isRunning,
        reason: isRunning ? "container is already running" : null,
      },
      {
        id: "container.stop",
        label: "Stop",
        enabled: isRunning,
        reason: isRunning ? null : "container is not running",
      },
      {
        id: "container.restart",
        label: "Restart",
        enabled: true,
        reason: null,
      },
      {
        id: "container.pause",
        label: "Pause",
        enabled: isRunning && !isPaused,
        reason: !isRunning
          ? "container is not running"
          : isPaused
          ? "container is already paused"
          : null,
      },
      {
        id: "container.unpause",
        label: "Unpause",
        enabled: isPaused,
        reason: isPaused ? null : "container is not paused",
      },
      {
        id: "container.logs",
        label: "Logs",
        enabled: true,
        reason: null,
      },
      {
        id: "container.shell",
        label: "Shell",
        enabled: isRunning,
        reason: isRunning ? null : "container is not running",
      },
      {
        id: "container.inspect",
        label: "Inspect",
        enabled: true,
        reason: null,
      },
      {
        id: "container.open_port",
        label: "Open in browser",
        enabled: hasPublishedPorts,
        reason: hasPublishedPorts ? null : "no published ports",
      },
      {
        id: "container.copy_id",
        label: "Copy ID",
        enabled: true,
        reason: null,
      },
      {
        id: "container.copy_name",
        label: "Copy name",
        enabled: true,
        reason: null,
      },
    ];

    const destructive = [
      {
        id: "container.kill",
        label: "Kill",
        enabled: isRunning,
        reason: isRunning ? null : "container is not running",
        danger: true,
      },
      {
        id: "container.remove",
        label: "Remove",
        enabled: true,
        reason: null,
        danger: true,
      },
    ];

    return [...nonDestructive, ...destructive];
  }

  if (kind === "dockerfile") {
    const hasBuiltAndRun = Boolean(target.hasBuiltAndRun || state.hasBuiltAndRun);
    const hasFile = Boolean(target.path || target.file);
    return [
      {
        id: "dockerfile.build",
        label: "Build image…",
        enabled: true,
        reason: null,
      },
      {
        id: "dockerfile.build_run",
        label: "Build & run…",
        enabled: true,
        reason: null,
      },
      {
        id: "dockerfile.rebuild_replace",
        label: "Rebuild & replace",
        enabled: hasBuiltAndRun,
        reason: hasBuiltAndRun ? null : "no previous build & run",
      },
      {
        id: "dockerfile.open_file",
        label: "Open Dockerfile",
        enabled: hasFile,
        reason: hasFile ? null : "dockerfile not found",
      },
    ];
  }

  return [];
}

/**
 * Builds deterministic props for opening an inspector tab (DM-44).
 *
 * @param {any} target
 * @param {{ folder?: string | null, on?: string | null }} [options]
 * @returns {{ mod: string, props: { folder: string | null, on: string | null, inspect: { kind: string, id: string, project: string | null, service: string | null } } }}
 */
export function buildInspectTabProps(target, options = {}) {
  const t = target || {};
  const kind =
    t.kind ||
    t.type ||
    (t.service ? "service" : t.project ? "project" : t.id ? "container" : "container");
  const id = t.id || t.containerId || t.name || "";
  const project = t.project || null;
  const service = t.service || null;
  const folder = options.folder ?? t.folder ?? null;
  const on = options.on ?? t.on ?? null;

  return {
    mod: "docker-manager",
    props: {
      folder,
      on,
      inspect: {
        kind,
        id,
        project,
        service,
      },
    },
  };
}

/**
 * Returns a stable name for an inspector tab (DM-44).
 *
 * @param {any} target
 * @returns {string}
 */
export function inspectTabName(target) {
  const t = target?.inspect || target || {};
  if (t.project && t.service) {
    return `Inspect: ${t.project}/${t.service}`;
  }
  if (t.name) {
    return `Inspect: ${t.name}`;
  }
  if (t.id) {
    return `Inspect: ${t.id}`;
  }
  if (t.project) {
    return `Inspect: ${t.project}`;
  }
  return `Inspect: ${t.kind || "docker"}`;
}

/**
 * Re-resolves a Compose service across recreation by (project, service),
 * returning the new container ID, or null when the service no longer exists (DM-46).
 *
 * @param {{ kind?: string, id?: string, project?: string | null, service?: string | null }} inspect
 * @param {any} containersTree
 * @returns {string | null}
 */
export function resolveInspectorTarget(inspect, containersTree) {
  if (!inspect) return null;

  // Compose service target: re-resolve by project + service
  if (inspect.project && inspect.service) {
    const projName = inspect.project;
    const sName = inspect.service;

    // Structure 1: flat array of rows or containers
    if (Array.isArray(containersTree)) {
      const matchingRow = containersTree.find(
        (r) =>
          r &&
          r.project === projName &&
          r.service === sName &&
          (r.containerId || r.id)
      );
      if (matchingRow) {
        return matchingRow.containerId || matchingRow.id || null;
      }

      const proj = containersTree.find(
        (p) => p && (p.name === projName || p.project === projName)
      );
      if (!proj) return null;
      const s = (proj.services || []).find(
        (srv) => srv && (srv.name === sName || srv.service === sName)
      );
      if (!s) return null;
      if (s.containers && s.containers.length > 0) {
        if (inspect.id) {
          const match = s.containers.find(
            (c) => c.id === inspect.id || c.name === inspect.id
          );
          if (match) return match.id || null;
        }
        return s.containers[0].id || null;
      }
      return null;
    }

    // Structure 2: object with composeProjects / projects
    if (containersTree && typeof containersTree === "object") {
      const projects = containersTree.composeProjects || containersTree.projects || [];
      const proj = projects.find(
        (p) => p && (p.name === projName || p.project === projName)
      );
      if (!proj) return null;
      const s = (proj.services || []).find(
        (srv) => srv && (srv.name === sName || srv.service === sName)
      );
      if (!s) return null;
      if (s.containers && s.containers.length > 0) {
        if (inspect.id) {
          const match = s.containers.find(
            (c) => c.id === inspect.id || c.name === inspect.id
          );
          if (match) return match.id || null;
        }
        return s.containers[0].id || null;
      }
      return null;
    }

    return null;
  }

  // Standalone container target: resolve by id
  const targetId = inspect.id;
  if (!targetId) return null;

  if (Array.isArray(containersTree)) {
    const match = containersTree.find(
      (c) => c && (c.id === targetId || c.containerId === targetId || c.name === targetId)
    );
    return match ? match.id || match.containerId || targetId : null;
  }

  if (containersTree && typeof containersTree === "object") {
    const standalone = containersTree.standalone || [];
    const match = standalone.find(
      (c) => c && (c.id === targetId || c.name === targetId)
    );
    if (match) return match.id || targetId;

    const projects = containersTree.composeProjects || containersTree.projects || [];
    for (const p of projects) {
      for (const s of p.services || []) {
        for (const c of s.containers || []) {
          if (c.id === targetId || c.name === targetId) return c.id;
        }
      }
    }
  }

  return targetId || null;
}

/**
 * Processes environment entries, sorting alphabetically by key,
 * masking values of secret keys unless revealed (DM-45).
 *
 * @param {Array<string | { key: string, value: string }> | Record<string, string>} env
 * @param {boolean | Set<string> | Array<string>} [revealed=false]
 * @returns {Array<{ key: string, value: string, secret: boolean, masked: boolean }>}
 */
export function maskEnvEntries(env, revealed = false) {
  if (!env) return [];

  const entries = [];
  if (Array.isArray(env)) {
    for (const item of env) {
      if (typeof item === "string") {
        const eq = item.indexOf("=");
        if (eq >= 0) {
          entries.push({ key: item.slice(0, eq), value: item.slice(eq + 1) });
        } else {
          entries.push({ key: item, value: "" });
        }
      } else if (item && typeof item === "object") {
        entries.push({ key: item.key || item.name || "", value: item.value || "" });
      }
    }
  } else if (typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      entries.push({ key, value: String(value ?? "") });
    }
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  return entries.map((e) => {
    const isSecret = isSecretEnvKey(e.key);
    let isRevealed = false;
    if (revealed === true) {
      isRevealed = true;
    } else if (revealed instanceof Set) {
      isRevealed = revealed.has(e.key);
    } else if (Array.isArray(revealed)) {
      isRevealed = revealed.includes(e.key);
    }

    const masked = isSecret && !isRevealed;
    return {
      key: e.key,
      value: masked ? "••••••••" : e.value,
      secret: isSecret,
      masked,
    };
  });
}

/**
 * Parses stdout from `docker stats --no-stream --format '{{json .}}'` (DM-45).
 *
 * @param {string | object} stdout
 * @returns {{
 *   container: string,
 *   id: string,
 *   name: string,
 *   cpuPerc: string,
 *   memPerc: string,
 *   memUsage: string,
 *   memLimit: string,
 *   memUsageRaw: string,
 *   netIO: string,
 *   blockIO: string,
 *   pids: number,
 *   raw: any,
 * }}
 */
export function parseDockerStats(stdout) {
  if (!stdout) {
    return {
      container: "",
      id: "",
      name: "",
      cpuPerc: "0.00%",
      memPerc: "0.00%",
      memUsage: "0B",
      memLimit: "0B",
      memUsageRaw: "0B / 0B",
      netIO: "0B / 0B",
      blockIO: "0B / 0B",
      pids: 0,
      raw: null,
    };
  }

  let obj = stdout;
  if (typeof stdout === "string") {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return parseDockerStats(null);
    }
    const firstLine = trimmed.split("\n")[0].trim();
    try {
      obj = JSON.parse(firstLine);
    } catch {
      return parseDockerStats(null);
    }
  }

  const rawUsage = obj.MemUsage || "";
  const parts = rawUsage.split("/").map((s) => s.trim());
  const memUsage = parts[0] || "0B";
  const memLimit = parts[1] || "0B";

  return {
    container: obj.Container || obj.ID || "",
    id: obj.ID || "",
    name: obj.Name || "",
    cpuPerc: obj.CPUPerc || "0.00%",
    memPerc: obj.MemPerc || "0.00%",
    memUsage,
    memLimit,
    memUsageRaw: rawUsage || "0B / 0B",
    netIO: obj.NetIO || "0B / 0B",
    blockIO: obj.BlockIO || "0B / 0B",
    pids: parseInt(obj.PIDs, 10) || 0,
    raw: obj,
  };
}

/**
 * Formats a byte number into a human-readable string (e.g. 0 B, 1.4 MB, 2.1 GB).
 *
 * @param {number | string} value
 * @returns {string}
 */
export function formatBytes(value) {
  const bytes = Number(value);
  if (!bytes || isNaN(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i <= 0) return `${bytes} B`;

  const val = bytes / Math.pow(1024, i);
  const rounded = val >= 10 || val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);
  return `${Number(rounded)} ${units[i]}`;
}

/**
 * Formats an ISO timestamp or date into relative time (e.g. 3 minutes ago).
 *
 * @param {string | number | Date} iso
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function formatRelativeTime(iso, now = Date.now()) {
  if (!iso) return "";
  const date = typeof iso === "object" && iso instanceof Date ? iso : new Date(iso);
  const time = date.getTime();
  if (isNaN(time)) return String(iso);

  const diffSec = Math.max(0, Math.floor((now - time) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec} seconds ago`;

  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;

  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

/**
 * Formats uptime from a container's StartedAt timestamp (e.g. up 2 days).
 *
 * @param {string | number | Date} startedAt
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function formatUptime(startedAt, now = Date.now()) {
  if (!startedAt) return "";
  const date = typeof startedAt === "object" && startedAt instanceof Date ? startedAt : new Date(startedAt);
  const time = date.getTime();
  if (isNaN(time)) return "";

  const diffSec = Math.max(0, Math.floor((now - time) / 1000));
  if (diffSec < 60) return `up ${diffSec} seconds`;

  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `up ${mins} ${mins === 1 ? "minute" : "minutes"}`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `up ${hours} ${hours === 1 ? "hour" : "hours"}`;

  const days = Math.floor(hours / 24);
  return `up ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Normalizes raw `docker image inspect` output (DM-100..101).
 *
 * @param {string | object | Array<any>} raw
 * @returns {{
 *   id: string,
 *   shortId: string,
 *   tags: string[],
 *   size: number,
 *   sizeFormatted: string,
 *   created: string,
 *   architecture: string,
 *   os: string,
 *   labels: Record<string, string>,
 *   env: string[],
 *   cmd: string[],
 *   entrypoint: string[],
 *   raw: any,
 * }}
 */
export function normalizeImageInspect(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  if (Array.isArray(obj)) {
    obj = obj[0] || {};
  }
  if (!obj || typeof obj !== "object") obj = {};

  const id = obj.Id || "";
  const shortId = id.replace(/^sha256:/, "").slice(0, 12);
  const tags = Array.isArray(obj.RepoTags) ? obj.RepoTags : [];
  const size = typeof obj.Size === "number" ? obj.Size : 0;
  const config = obj.Config || {};

  return {
    id,
    shortId,
    tags,
    size,
    sizeFormatted: formatBytes(size),
    created: obj.Created || "",
    architecture: obj.Architecture || "",
    os: obj.Os || "",
    labels: config.Labels || obj.Labels || {},
    env: Array.isArray(config.Env) ? config.Env : [],
    cmd: Array.isArray(config.Cmd) ? config.Cmd : [],
    entrypoint: Array.isArray(config.Entrypoint) ? config.Entrypoint : [],
    raw: obj,
  };
}

/**
 * Normalizes raw `docker volume inspect` output (DM-106).
 *
 * @param {string | object | Array<any>} raw
 * @returns {{
 *   name: string,
 *   driver: string,
 *   mountpoint: string,
 *   createdAt: string,
 *   labels: Record<string, string>,
 *   scope: string,
 *   options: Record<string, string> | null,
 *   raw: any,
 * }}
 */
export function normalizeVolumeInspect(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  if (Array.isArray(obj)) {
    obj = obj[0] || {};
  }
  if (!obj || typeof obj !== "object") obj = {};

  return {
    name: obj.Name || "",
    driver: obj.Driver || "local",
    mountpoint: obj.Mountpoint || "",
    createdAt: obj.CreatedAt || "",
    labels: obj.Labels || {},
    scope: obj.Scope || "local",
    options: obj.Options || null,
    raw: obj,
  };
}

/**
 * Normalizes raw `docker network inspect` output (DM-116).
 *
 * @param {string | object | Array<any>} raw
 * @returns {{
 *   id: string,
 *   shortId: string,
 *   name: string,
 *   driver: string,
 *   scope: string,
 *   subnet: string,
 *   gateway: string,
 *   internal: boolean,
 *   containers: Array<{ id: string, shortId: string, name: string, ip: string, macAddress: string }>,
 *   labels: Record<string, string>,
 *   raw: any,
 * }}
 */
export function normalizeNetworkInspect(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  if (Array.isArray(obj)) {
    obj = obj[0] || {};
  }
  if (!obj || typeof obj !== "object") obj = {};

  const id = obj.Id || "";
  const shortId = id.slice(0, 12);
  const ipamConfig = obj.IPAM?.Config?.[0] || {};
  const containers = [];

  if (obj.Containers && typeof obj.Containers === "object") {
    for (const [cid, cinfo] of Object.entries(obj.Containers)) {
      if (cinfo && typeof cinfo === "object") {
        const ip4 = cinfo.IPv4Address || "";
        const ip = ip4.includes("/") ? ip4.split("/")[0] : ip4;
        containers.push({
          id: cid,
          shortId: cid.slice(0, 12),
          name: cinfo.Name || "",
          ip,
          macAddress: cinfo.MacAddress || "",
        });
      }
    }
  }

  return {
    id,
    shortId,
    name: obj.Name || "",
    driver: obj.Driver || "bridge",
    scope: obj.Scope || "local",
    subnet: ipamConfig.Subnet || "",
    gateway: ipamConfig.Gateway || "",
    internal: Boolean(obj.Internal),
    containers,
    labels: obj.Labels || {},
    raw: obj,
  };
}

/**
 * Formats JSON with stable 2-space indentation that never throws on already-parsed objects (DM-45).
 *
 * @param {any} raw
 * @returns {string}
 */
export function prettyJson(raw) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

/**
 * Maps Herdr theme colors to EditorState syntax theme tokens.
 *
 * @param {Record<string, string>} [themeObj={}]
 * @returns {Record<string, string>}
 */
export function buildSyntaxTheme(themeObj = {}) {
  const t = themeObj || {};
  return {
    keyword: t.ansi5 || "#b48ead",
    string: t.ansi2 || "#a3be8c",
    comment: t.dim || "#616e88",
    function: t.ansi4 || "#81a1c1",
    type: t.ansi3 || "#ebcb8b",
    number: t.ansi1 || "#bf616a",
    constant: t.ansi6 || "#88c0d0",
  };
}


