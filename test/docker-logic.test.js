import test from "node:test";
import assert from "node:assert/strict";
import {
  parseContainerLabels,
  validateDockerIdentifier,
  classifyDockerFile,
  isSecretEnvKey,
  normalizeContainerInspect,
  buildComposeArgs,
  hasUsableConfigFiles,
  getComposeActionAvailability,
  buildServiceRebuildArgs,
  buildServiceRecreateArgs,
  buildServiceRmArgs,
  buildProjectDownArgs,
  buildProjectDownVolumesArgs,
  buildContainerLogsArgs,
  buildServiceLogsArgs,
  buildContainerShellArgs,
  buildContainerKillArgs,
  buildVolumeBrowseArgs,
  buildVolumeBackupArgs,
  buildVolumeRestoreArgs,
  buildVolumeCloneArgs,
  buildImagePruneDanglingArgs,
  buildImagePruneUnusedArgs,
  buildSystemDfArgs,
  buildSystemDfVerboseArgs,
  buildBuilderPruneArgs,
  parseSystemDf,
  parseSystemDfVerbose,
  contextMenuPosition,
  buildContainerTree,
  isPathEqualOrInside,
  resolveDockerContext,
  flattenContainerRows,
  aggregateProjectStatus,
  matchesFilter,
  parseEngineInfo,
  engineStateFromResults,
  parseComposeConfig,
  discoverComposeGroups,
  parseComposeLs,
} from "../mods/docker-manager/docker-logic.js";

// =============================================================================
// Suite 1: parseContainerLabels (AC 1)
// =============================================================================
test("parseContainerLabels handles empty and invalid inputs", () => {
  assert.deepEqual(parseContainerLabels(""), {});
  assert.deepEqual(parseContainerLabels("   "), {});
  assert.deepEqual(parseContainerLabels(null), {});
  assert.deepEqual(parseContainerLabels(undefined), {});
  assert.deepEqual(parseContainerLabels(12345), {});
});

test("parseContainerLabels preserves commas in com.docker.compose.project.config_files", () => {
  const raw =
    "com.docker.compose.project=myapp,com.docker.compose.project.config_files=/path/to/compose.yaml,/path/to/override.yaml,com.docker.compose.service=web";
  const parsed = parseContainerLabels(raw);
  assert.equal(parsed["com.docker.compose.project"], "myapp");
  assert.equal(
    parsed["com.docker.compose.project.config_files"],
    "/path/to/compose.yaml,/path/to/override.yaml"
  );
  assert.equal(parsed["com.docker.compose.service"], "web");
});

test("parseContainerLabels preserves commas in desktop.docker.io/binds/...", () => {
  const raw =
    "desktop.docker.io/binds/0/Source=/Users/foo/dir1,/Users/foo/dir2,desktop.docker.io/binds/0/Target=/app,com.docker.compose.service=api";
  const parsed = parseContainerLabels(raw);
  assert.equal(
    parsed["desktop.docker.io/binds/0/Source"],
    "/Users/foo/dir1,/Users/foo/dir2"
  );
  assert.equal(parsed["desktop.docker.io/binds/0/Target"], "/app");
  assert.equal(parsed["com.docker.compose.service"], "api");
});

test("parseContainerLabels handles values containing equals signs", () => {
  const raw = "VAR1=FOO=BAR,VAR2=a=b=c=d,NORMAL=value";
  const parsed = parseContainerLabels(raw);
  assert.equal(parsed.VAR1, "FOO=BAR");
  assert.equal(parsed.VAR2, "a=b=c=d");
  assert.equal(parsed.NORMAL, "value");
});

test("parseContainerLabels accepts an existing object", () => {
  const obj = { "com.docker.compose.project": "demo" };
  assert.deepEqual(parseContainerLabels(obj), { "com.docker.compose.project": "demo" });
});

// =============================================================================
// Suite 2: validateDockerIdentifier (AC 7)
// =============================================================================
test("validateDockerIdentifier accepts valid Docker resource names and IDs", () => {
  assert.equal(validateDockerIdentifier("web"), true);
  assert.equal(validateDockerIdentifier("my-container.1_test"), true);
  assert.equal(validateDockerIdentifier("a1b2c3d4e5f6"), true);
  assert.equal(validateDockerIdentifier("db_postgres-12"), true);
  assert.equal(validateDockerIdentifier("a".repeat(255)), true);
});

test("validateDockerIdentifier rejects empty strings and non-strings", () => {
  assert.equal(validateDockerIdentifier(""), false);
  assert.equal(validateDockerIdentifier("   "), false);
  assert.equal(validateDockerIdentifier(null), false);
  assert.equal(validateDockerIdentifier(undefined), false);
  assert.equal(validateDockerIdentifier(42), false);
});

test("validateDockerIdentifier rejects spaces, semicolons, path traversal, slashes, and expansions", () => {
  assert.equal(validateDockerIdentifier("a b"), false);
  assert.equal(validateDockerIdentifier("a;b"), false);
  assert.equal(validateDockerIdentifier("$(id)"), false);
  assert.equal(validateDockerIdentifier("../etc"), false);
  assert.equal(validateDockerIdentifier("a/b"), false);
  assert.equal(validateDockerIdentifier("-invalid-lead"), false);
  assert.equal(validateDockerIdentifier("_invalid-lead"), false);
  assert.equal(validateDockerIdentifier("a".repeat(256)), false);
});

// =============================================================================
// Suite 3: classifyDockerFile (AC 8)
// =============================================================================
test("classifyDockerFile correctly classifies Compose files", () => {
  const c1 = classifyDockerFile("compose.yaml");
  assert.equal(c1?.type, "compose");
  assert.equal(c1?.isOverride, false);

  const c2 = classifyDockerFile("compose.yml");
  assert.equal(c2?.type, "compose");

  const c3 = classifyDockerFile("compose.dev.yaml");
  assert.equal(c3?.type, "compose");
  assert.equal(c3?.env, "dev");
  assert.equal(c3?.isOverride, false);

  const c4 = classifyDockerFile("compose.override.yaml");
  assert.equal(c4?.type, "compose");
  assert.equal(c4?.isOverride, true);

  const c5 = classifyDockerFile("docker-compose.yml");
  assert.equal(c5?.type, "compose");

  const c6 = classifyDockerFile("/project/sub/docker-compose.override.yml");
  assert.equal(c6?.type, "compose");
  assert.equal(c6?.isOverride, true);
});

test("classifyDockerFile correctly classifies Dockerfile variants", () => {
  const d1 = classifyDockerFile("Dockerfile");
  assert.equal(d1?.type, "dockerfile");

  const d2 = classifyDockerFile("Dockerfile.dev");
  assert.equal(d2?.type, "dockerfile");
  assert.equal(d2?.variant, "dev");

  const d3 = classifyDockerFile("app.Dockerfile");
  assert.equal(d3?.type, "dockerfile");
  assert.equal(d3?.variant, "app");

  const d4 = classifyDockerFile("Containerfile");
  assert.equal(d4?.type, "dockerfile");

  const d5 = classifyDockerFile("/workspace/deploy/api.Containerfile");
  assert.equal(d5?.type, "dockerfile");
  assert.equal(d5?.variant, "api");
});

test("classifyDockerFile rejects unrelated files", () => {
  assert.equal(classifyDockerFile("values.yaml"), null);
  assert.equal(classifyDockerFile("README.md"), null);
  assert.equal(classifyDockerFile("package.json"), null);
  assert.equal(classifyDockerFile(""), null);
  assert.equal(classifyDockerFile(null), null);
});

// =============================================================================
// Suite 4: isSecretEnvKey (AC 6)
// =============================================================================
test("isSecretEnvKey masks sensitive environment variable names", () => {
  const secrets = [
    "PASSWORD",
    "DB_PASSWORD",
    "MY_SECRET",
    "SECRET",
    "GITHUB_TOKEN",
    "TOKEN",
    "API_KEY",
    "OPENAI_API_KEY",
    "PRIVATE_KEY",
    "SSH_PRIVATE_KEY",
    "AUTH",
    "AUTH_HEADER",
    "CREDENTIAL",
    "CLIENT_SECRET",
    "DATABASE_URL",
    "REDIS_URL",
    "CONNECTION_STRING",
  ];
  for (const k of secrets) {
    assert.equal(isSecretEnvKey(k), true, `Expected ${k} to be recognized as secret`);
  }
});

test("isSecretEnvKey leaves standard non-secret environment variables unmasked", () => {
  const nonSecrets = ["PATH", "NODE_ENV", "PORT", "HOME", "USER", "LANG", "TZ", "HOST"];
  for (const k of nonSecrets) {
    assert.equal(isSecretEnvKey(k), false, `Expected ${k} to NOT be recognized as secret`);
  }
});

// =============================================================================
// Suite 5: normalizeContainerInspect (AC 5)
// =============================================================================
test("normalizeContainerInspect extracts ports, mounts, networks, health log, restart policy, and exit code", () => {
  const rawInspect = {
    Id: "abc1234567890abcdef1234567890",
    Name: "/web-service-1",
    Created: "2026-11-10T12:00:00Z",
    Config: {
      Image: "nginx:alpine",
      Env: ["PATH=/usr/bin", "DB_PASSWORD=supersecret", "PORT=80"],
      Labels: {
        "com.docker.compose.project": "myproject",
        "com.docker.compose.service": "web",
        "com.docker.compose.project.config_files": "/app/compose.yaml",
        "com.docker.compose.depends_on": "db:service_healthy",
      },
      Entrypoint: ["/entrypoint.sh"],
      Cmd: ["nginx", "-g", "daemon off;"],
      WorkingDir: "/var/www/html",
    },
    State: {
      Status: "running",
      Running: true,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      ExitCode: 0,
      Error: "",
      StartedAt: "2026-11-10T12:00:05Z",
      FinishedAt: "0001-01-01T00:00:00Z",
      Health: {
        Status: "healthy",
        FailingStreak: 0,
        Log: [
          { Start: "2026-11-10T12:01:00Z", Output: "HTTP/1.1 200 OK\n" },
          { Start: "2026-11-10T12:02:00Z", Output: "Health check passed successfully" },
        ],
      },
    },
    HostConfig: {
      RestartPolicy: {
        Name: "on-failure",
        MaximumRetryCount: 5,
      },
    },
    NetworkSettings: {
      Ports: {
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
        "443/tcp": null,
      },
      Networks: {
        myproject_default: {
          IPAddress: "172.20.0.2",
          Gateway: "172.20.0.1",
          MacAddress: "02:42:ac:14:00:02",
          Aliases: ["web", "abc123456789"],
          NetworkID: "net-uuid-123",
        },
      },
    },
    Mounts: [
      {
        Type: "volume",
        Name: "web_data",
        Source: "/var/lib/docker/volumes/web_data/_data",
        Destination: "/var/www/html",
        Driver: "local",
        RW: true,
      },
      {
        Type: "bind",
        Source: "/home/user/app/nginx.conf",
        Destination: "/etc/nginx/nginx.conf",
        RW: false,
      },
    ],
  };

  const norm = normalizeContainerInspect(rawInspect);

  assert.equal(norm.id, "abc1234567890abcdef1234567890");
  assert.equal(norm.shortId, "abc123456789");
  assert.equal(norm.name, "web-service-1");
  assert.equal(norm.project, "myproject");
  assert.equal(norm.service, "web");
  assert.deepEqual(norm.composeFiles, ["/app/compose.yaml"]);
  assert.deepEqual(norm.dependsOn, ["db:service_healthy"]);

  // State
  assert.equal(norm.state.status, "running");
  assert.equal(norm.state.running, true);
  assert.equal(norm.state.exitCode, 0);

  // Health
  assert.equal(norm.health?.status, "healthy");
  assert.equal(norm.health?.failingStreak, 0);
  assert.equal(norm.health?.lastLog, "Health check passed successfully");

  // Restart Policy
  assert.equal(norm.restartPolicy.name, "on-failure");
  assert.equal(norm.restartPolicy.maximumRetryCount, 5);

  // Ports
  assert.equal(norm.ports.length, 2);
  const p80 = norm.ports.find((p) => p.containerPort === "80");
  assert.equal(p80?.hostPort, "8080");
  assert.equal(p80?.hostIp, "0.0.0.0");
  assert.equal(p80?.proto, "tcp");

  const p443 = norm.ports.find((p) => p.containerPort === "443");
  assert.equal(p443?.hostPort, null);
  assert.equal(p443?.proto, "tcp");

  // Mounts
  assert.equal(norm.mounts.length, 2);
  const volMount = norm.mounts.find((m) => m.type === "volume");
  assert.equal(volMount?.name, "web_data");
  assert.equal(volMount?.destination, "/var/www/html");
  assert.equal(volMount?.rw, true);

  const bindMount = norm.mounts.find((m) => m.type === "bind");
  assert.equal(bindMount?.source, "/home/user/app/nginx.conf");
  assert.equal(bindMount?.rw, false);

  // Networks
  assert.equal(norm.networks.length, 1);
  assert.equal(norm.networks[0].name, "myproject_default");
  assert.equal(norm.networks[0].ipAddress, "172.20.0.2");
  assert.deepEqual(norm.networks[0].aliases, ["web", "abc123456789"]);

  // Environment Secret Masking
  const envMap = Object.fromEntries(norm.env.map((e) => [e.key, e]));
  assert.equal(envMap.PATH.secret, false);
  assert.equal(envMap.PORT.secret, false);
  assert.equal(envMap.DB_PASSWORD.secret, true);
});

test("normalizeContainerInspect handles JSON string and array input", () => {
  const jsonStr = JSON.stringify({
    Id: "1234567890ab",
    Name: "/test-container",
    State: { Status: "exited", ExitCode: 137 },
  });
  const normStr = normalizeContainerInspect(jsonStr);
  assert.equal(normStr.id, "1234567890ab");
  assert.equal(normStr.name, "test-container");
  assert.equal(normStr.state.exitCode, 137);

  const normArr = normalizeContainerInspect([JSON.parse(jsonStr)]);
  assert.equal(normArr.id, "1234567890ab");
});

// =============================================================================
// Suite 6: buildComposeArgs & Action Availability (AC 3)
// =============================================================================
test("buildComposeArgs emits full args when config files exist", () => {
  const target = {
    project: "myproj",
    workingDir: "/home/user/app",
    configFiles: ["/home/user/app/compose.yaml", "/home/user/app/compose.override.yaml"],
  };
  const args = buildComposeArgs(target, ["up", "-d"]);
  assert.deepEqual(args, [
    "compose",
    "-p",
    "myproj",
    "--project-directory",
    "/home/user/app",
    "-f",
    "/home/user/app/compose.yaml",
    "-f",
    "/home/user/app/compose.override.yaml",
    "up",
    "-d",
  ]);
  assert.equal(args.disabled, false);
  assert.equal(args.reason, null);
  assert.equal(hasUsableConfigFiles(target), true);
});

test("buildComposeArgs falls back to -p <project> when config files are missing", () => {
  const target = {
    project: "orphaned",
    configFiles: [],
  };
  const args = buildComposeArgs(target, ["start"]);
  assert.deepEqual(args, ["compose", "-p", "orphaned", "start"]);
  assert.equal(args.disabled, false);
  assert.equal(hasUsableConfigFiles(target), false);
});

test("buildComposeArgs disables up, build, pull when config files are missing", () => {
  const target = {
    project: "orphaned",
    configFiles: [],
  };

  const upArgs = buildComposeArgs(target, ["up", "-d"]);
  assert.equal(upArgs.disabled, true);
  assert.equal(upArgs.reason, "compose file not found");

  const buildArgs = buildComposeArgs(target, ["build"]);
  assert.equal(buildArgs.disabled, true);
  assert.equal(buildArgs.reason, "compose file not found");

  const pullArgs = buildComposeArgs(target, ["pull"]);
  assert.equal(pullArgs.disabled, true);
  assert.equal(pullArgs.reason, "compose file not found");

  assert.deepEqual(getComposeActionAvailability(target, "up"), {
    disabled: true,
    reason: "compose file not found",
  });
  assert.deepEqual(getComposeActionAvailability(target, "restart"), {
    disabled: false,
    reason: null,
  });
});

// =============================================================================
// Suite 7: Exact Argv Builders (AC 4)
// =============================================================================
const sampleTarget = {
  project: "demo",
  workingDir: "/app",
  configFiles: ["/app/compose.yaml"],
};

test("buildServiceRebuildArgs builds exact rebuild argv", () => {
  assert.deepEqual(buildServiceRebuildArgs(sampleTarget, "web"), [
    "compose",
    "-p",
    "demo",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "up",
    "-d",
    "--build",
    "--force-recreate",
    "--no-deps",
    "web",
  ]);
});

test("buildServiceRecreateArgs builds exact recreate argv", () => {
  assert.deepEqual(buildServiceRecreateArgs(sampleTarget, "api"), [
    "compose",
    "-p",
    "demo",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "up",
    "-d",
    "--force-recreate",
    "--no-deps",
    "api",
  ]);
});

test("buildServiceRmArgs builds exact service rm argv", () => {
  assert.deepEqual(buildServiceRmArgs(sampleTarget, "worker"), [
    "compose",
    "-p",
    "demo",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "rm",
    "-s",
    "-f",
    "worker",
  ]);
});

test("buildProjectDownArgs builds exact project down argv", () => {
  assert.deepEqual(buildProjectDownArgs(sampleTarget), [
    "compose",
    "-p",
    "demo",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "down",
  ]);
});

test("buildProjectDownVolumesArgs builds exact project down -v argv", () => {
  assert.deepEqual(buildProjectDownVolumesArgs(sampleTarget), [
    "compose",
    "-p",
    "demo",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "down",
    "-v",
  ]);
  assert.deepEqual(buildProjectDownArgs(sampleTarget, { removeVolumes: true }), [
    "compose",
    "-p",
    "demo",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "down",
    "-v",
  ]);
});

test("buildContainerLogsArgs and buildServiceLogsArgs build exact log argv", () => {
  assert.deepEqual(buildContainerLogsArgs("c_123", { tail: 200 }), [
    "docker",
    "logs",
    "-f",
    "--tail",
    "200",
    "c_123",
  ]);

  assert.deepEqual(buildServiceLogsArgs(sampleTarget, "web", { tail: 100 }), [
    "docker",
    "compose",
    "-p",
    "demo",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "logs",
    "-f",
    "--tail",
    "100",
    "web",
  ]);
});

test("buildContainerShellArgs builds exact shell argv for auto, bash, and sh", () => {
  assert.deepEqual(buildContainerShellArgs("c_123"), [
    "docker",
    "exec",
    "-it",
    "c_123",
    "sh",
    "-c",
    "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
  ]);
  assert.deepEqual(buildContainerShellArgs("c_123", "bash"), [
    "docker",
    "exec",
    "-it",
    "c_123",
    "bash",
  ]);
  assert.deepEqual(buildContainerShellArgs("c_123", "sh"), [
    "docker",
    "exec",
    "-it",
    "c_123",
    "sh",
  ]);
});

test("buildContainerKillArgs builds exact container kill argv", () => {
  assert.deepEqual(buildContainerKillArgs("c_123"), ["kill", "c_123"]);
});

test("buildVolumeBrowseArgs builds exact volume browse argv", () => {
  assert.deepEqual(buildVolumeBrowseArgs("pgdata"), [
    "docker",
    "run",
    "--rm",
    "-it",
    "-v",
    "pgdata:/data:ro",
    "-w",
    "/data",
    "alpine:3",
    "sh",
  ]);
});

test("buildVolumeBackupArgs builds exact volume backup argv", () => {
  assert.deepEqual(
    buildVolumeBackupArgs("pgdata", "/home/user/backups", "pgdata-20261111.tar.gz"),
    [
      "run",
      "--rm",
      "-v",
      "pgdata:/data:ro",
      "-v",
      "/home/user/backups:/backup",
      "alpine:3",
      "tar",
      "czf",
      "/backup/pgdata-20261111.tar.gz",
      "-C",
      "/data",
      ".",
    ]
  );
});

test("buildVolumeRestoreArgs builds exact volume restore argv", () => {
  assert.deepEqual(
    buildVolumeRestoreArgs("pgdata", "/home/user/backups", "pgdata-20261111.tar.gz"),
    [
      "run",
      "--rm",
      "-v",
      "pgdata:/data",
      "-v",
      "/home/user/backups:/backup:ro",
      "alpine:3",
      "sh",
      "-c",
      'rm -rf /data/* /data/..?* /data/.[!.]* && tar xzf "/backup/pgdata-20261111.tar.gz" -C /data',
    ]
  );
});

test("buildVolumeCloneArgs builds exact volume clone argv pair", () => {
  const clone = buildVolumeCloneArgs("volA", "volB");
  assert.deepEqual(clone.createArgs, ["volume", "create", "volB"]);
  assert.deepEqual(clone.copyArgs, [
    "run",
    "--rm",
    "-v",
    "volA:/from:ro",
    "-v",
    "volB:/to",
    "alpine:3",
    "sh",
    "-c",
    "cp -a /from/. /to/",
  ]);
});

test("buildImagePruneDanglingArgs and buildImagePruneUnusedArgs build exact image prune argv", () => {
  assert.deepEqual(buildImagePruneDanglingArgs(), ["image", "prune", "-f"]);
  assert.deepEqual(buildImagePruneUnusedArgs(), ["image", "prune", "-a", "-f"]);
});

test("buildSystemDfArgs and buildSystemDfVerboseArgs build exact disk usage argv", () => {
  assert.deepEqual(buildSystemDfArgs(), ["system", "df", "--format", "{{json .}}"]);
  assert.deepEqual(buildSystemDfVerboseArgs(), ["system", "df", "-v", "--format", "json"]);
});

test("buildBuilderPruneArgs builds builder prune argv with and without filter until=168h", () => {
  assert.deepEqual(buildBuilderPruneArgs(), ["builder", "prune", "-f"]);
  assert.deepEqual(buildBuilderPruneArgs({ olderThan7d: true }), [
    "builder",
    "prune",
    "-f",
    "--filter",
    "until=168h",
  ]);
});

// =============================================================================
// Suite 8: parseSystemDf & parseSystemDfVerbose (AC 9)
// =============================================================================
test("parseSystemDf parses 4-line NDJSON output", () => {
  const ndjson = [
    '{"Type":"Images","TotalCount":15,"Active":5,"Size":"3.2GB","Reclaimable":"1.1GB (34%)"}',
    '{"Type":"Containers","TotalCount":8,"Active":2,"Size":"450MB","Reclaimable":"300MB (66%)"}',
    '{"Type":"Local Volumes","TotalCount":4,"Active":3,"Size":"1.5GB","Reclaimable":"500MB (33%)"}',
    '{"Type":"Build Cache","TotalCount":42,"Active":0,"Size":"5.8GB","Reclaimable":"5.8GB (100%)"}',
  ].join("\n");

  const df = parseSystemDf(ndjson);
  assert.equal(df.images.totalCount, 15);
  assert.equal(df.images.active, 5);
  assert.equal(df.images.size, "3.2GB");
  assert.equal(df.containers.totalCount, 8);
  assert.equal(df.volumes.totalCount, 4);
  assert.equal(df.buildCache.totalCount, 42);
  assert.equal(df.items.length, 4);
});

test("parseSystemDf parses single-object JSON input", () => {
  const jsonSingle = JSON.stringify({
    Images: { TotalCount: 10, Active: 4, Size: "2.1GB", Reclaimable: "500MB" },
    Containers: { TotalCount: 2, Active: 1, Size: "50MB", Reclaimable: "10MB" },
    Volumes: { TotalCount: 3, Active: 2, Size: "1GB", Reclaimable: "200MB" },
    BuildCache: { TotalCount: 5, Active: 0, Size: "1.2GB", Reclaimable: "1.2GB" },
  });

  const df = parseSystemDf(jsonSingle);
  assert.equal(df.images.totalCount, 10);
  assert.equal(df.containers.totalCount, 2);
  assert.equal(df.volumes.totalCount, 3);
  assert.equal(df.buildCache.totalCount, 5);
});

test("parseSystemDfVerbose parses single-object and NDJSON input", () => {
  const verboseJson = JSON.stringify({
    Images: [{ ID: "sha256:1", Repository: "node", Tag: "22-alpine", Size: "150MB" }],
    Containers: [{ ContainerID: "c1", Names: "web", Image: "node:22-alpine" }],
    Volumes: [{ VolumeName: "data", Links: 1, Size: "20MB" }],
    BuildCache: [{ ID: "bc1", Size: "100MB" }],
  });

  const vdf = parseSystemDfVerbose(verboseJson);
  assert.equal(vdf.images.length, 1);
  assert.equal(vdf.images[0].Repository, "node");
  assert.equal(vdf.containers.length, 1);
  assert.equal(vdf.volumes.length, 1);
  assert.equal(vdf.buildCache.length, 1);

  // NDJSON
  const ndjson = [
    JSON.stringify({ Images: [{ ID: "sha256:2", Repository: "alpine" }] }),
    JSON.stringify({ Containers: [{ ContainerID: "c2" }] }),
  ].join("\n");
  const vdfNdjson = parseSystemDfVerbose(ndjson);
  assert.equal(vdfNdjson.images.length, 1);
  assert.equal(vdfNdjson.containers.length, 1);
});

// =============================================================================
// Suite 9: contextMenuPosition (AC 10)
// =============================================================================
test("contextMenuPosition clamps inside bounds and flips when near edges", () => {
  const bounds = { width: 500, height: 400 };

  // Center click - no flipping needed
  const posNormal = contextMenuPosition({
    x: 100,
    y: 100,
    menuWidth: 150,
    menuHeight: 180,
    bounds,
  });
  assert.equal(posNormal.x, 100);
  assert.equal(posNormal.y, 100);

  // Near right edge - flips to left of anchor (450 + 150 = 600 > 490 -> 450 - 150 = 300)
  const posRight = contextMenuPosition({
    x: 450,
    y: 100,
    menuWidth: 150,
    menuHeight: 180,
    bounds,
  });
  assert.equal(posRight.x, 300);
  assert.equal(posRight.y, 100);

  // Near bottom edge - flips upwards (350 + 180 = 530 > 390 -> 350 - 180 = 170)
  const posBottom = contextMenuPosition({
    x: 100,
    y: 350,
    menuWidth: 150,
    menuHeight: 180,
    bounds,
  });
  assert.equal(posBottom.x, 100);
  assert.equal(posBottom.y, 170);

  // Near bottom-right edge - flips both horizontally and vertically
  const posBoth = contextMenuPosition({
    x: 460,
    y: 360,
    menuWidth: 150,
    menuHeight: 180,
    bounds,
  });
  assert.equal(posBoth.x, 310);
  assert.equal(posBoth.y, 180);

  // Positional arguments signature
  const posPositional = contextMenuPosition(460, 360, 150, 180, bounds);
  assert.equal(posPositional.x, 310);
  assert.equal(posPositional.y, 180);
});

// =============================================================================
// Suite 10: buildContainerTree (AC 2)
// =============================================================================
test("buildContainerTree groups project -> service -> containers", () => {
  const containers = [
    {
      ID: "c1",
      Names: "/myproject-web-1",
      State: "running",
      Status: "Up 2 hours",
      Labels: {
        "com.docker.compose.project": "myproject",
        "com.docker.compose.service": "web",
        "com.docker.compose.container-number": "1",
        "com.docker.compose.project.working_dir": "/home/user/app",
        "com.docker.compose.project.config_files": "/home/user/app/compose.yaml",
      },
    },
    {
      ID: "c2",
      Names: "/myproject-web-2",
      State: "running",
      Status: "Up 2 hours",
      Labels: {
        "com.docker.compose.project": "myproject",
        "com.docker.compose.service": "web",
        "com.docker.compose.container-number": "2",
        "com.docker.compose.project.working_dir": "/home/user/app",
        "com.docker.compose.project.config_files": "/home/user/app/compose.yaml",
      },
    },
  ];

  const tree = buildContainerTree({ containers });
  assert.equal(tree.projects.length, 1);
  const proj = tree.projects[0];
  assert.equal(proj.name, "myproject");
  assert.equal(proj.services.length, 1);
  const svc = proj.services[0];
  assert.equal(svc.name, "web");
  assert.equal(svc.containers.length, 2);
  assert.equal(svc.containers[0].id, "c1");
  assert.equal(svc.containers[1].id, "c2");
});

test("buildContainerTree synthesizes not-created services from docker compose config", () => {
  const containers = [
    {
      ID: "c1",
      Names: "/myproject-web-1",
      State: "running",
      Labels: {
        "com.docker.compose.project": "myproject",
        "com.docker.compose.service": "web",
      },
    },
  ];

  const discoveredCompose = [
    {
      project: "myproject",
      workingDir: "/home/user/app",
      config: {
        services: {
          web: { image: "nginx" },
          db: { image: "postgres:16" }, // 0 containers
        },
      },
    },
  ];

  const tree = buildContainerTree({ containers, discoveredCompose });
  const proj = tree.projects[0];
  assert.equal(proj.services.length, 2);

  const webSvc = proj.services.find((s) => s.name === "web");
  assert.equal(webSvc?.created !== false, true);
  assert.equal(webSvc?.containers.length, 1);

  const dbSvc = proj.services.find((s) => s.name === "db");
  assert.equal(dbSvc?.status, "not-created");
  assert.equal(dbSvc?.created, false);
  assert.equal(dbSvc?.containers.length, 0);
});

test("buildContainerTree separates inactive-profile services", () => {
  const discoveredCompose = [
    {
      project: "profile-proj",
      config: {
        services: {
          app: { image: "node:22" },
          migrator: { image: "node:22", profiles: ["tools"] }, // Inactive profile
        },
      },
    },
  ];

  const tree = buildContainerTree({
    discoveredCompose,
    activeProfiles: [], // "tools" profile is inactive
  });

  const proj = tree.projects[0];
  assert.equal(proj.services.length, 1);
  assert.equal(proj.services[0].name, "app");

  assert.equal(proj.inactiveProfiles.length, 1);
  assert.equal(proj.inactiveProfiles[0].name, "migrator");
  assert.deepEqual(proj.inactiveProfiles[0].profiles, ["tools"]);
});

test("buildContainerTree sets mixedSources when working_dir differs across project containers", () => {
  const containers = [
    {
      ID: "c1",
      Labels: {
        "com.docker.compose.project": "shared-name",
        "com.docker.compose.service": "web",
        "com.docker.compose.project.working_dir": "/checkout-a",
      },
    },
    {
      ID: "c2",
      Labels: {
        "com.docker.compose.project": "shared-name",
        "com.docker.compose.service": "worker",
        "com.docker.compose.project.working_dir": "/checkout-b",
      },
    },
  ];

  const tree = buildContainerTree({ containers });
  assert.equal(tree.projects[0].mixedSources, true);

  const singleTree = buildContainerTree({
    containers: [containers[0]],
  });
  assert.equal(singleTree.projects[0].mixedSources, false);
});

test("buildContainerTree groups containers carrying herdr.docker-manager.source under Dockerfiles", () => {
  const containers = [
    {
      ID: "df_cont_1",
      Names: "/dev-box",
      State: "running",
      Labels: {
        "herdr.docker-manager.source": "/home/user/app/Dockerfile.dev",
      },
    },
  ];

  const discoveredDockerfiles = ["/home/user/app/Dockerfile.dev"];

  const tree = buildContainerTree({ containers, discoveredDockerfiles });
  assert.equal(tree.dockerfiles.length, 1);
  assert.equal(tree.dockerfiles[0].path, "/home/user/app/Dockerfile.dev");
  assert.equal(tree.dockerfiles[0].containers.length, 1);
  assert.equal(tree.dockerfiles[0].containers[0].id, "df_cont_1");
  assert.equal(tree.standalone.length, 0);
});

test("buildContainerTree filters scope: 'space' vs scope: 'all' and hides standalone in space scope", () => {
  const spaceRoot = "/home/user/workspace";

  const containers = [
    // Project in space
    {
      ID: "c_in_space",
      Labels: {
        "com.docker.compose.project": "in-space-proj",
        "com.docker.compose.service": "web",
        "com.docker.compose.project.working_dir": "/home/user/workspace/app",
      },
    },
    // Project outside space
    {
      ID: "c_outside",
      Labels: {
        "com.docker.compose.project": "outside-proj",
        "com.docker.compose.service": "api",
        "com.docker.compose.project.working_dir": "/opt/other",
      },
    },
    // Standalone container
    {
      ID: "c_standalone",
      Names: "/redis-cache",
      Labels: {},
    },
  ];

  // Scope: 'all'
  const treeAll = buildContainerTree({
    containers,
    spaceRoot,
    scope: "all",
  });
  assert.equal(treeAll.projects.length, 2);
  assert.equal(treeAll.projects[0].name, "in-space-proj");
  assert.equal(treeAll.projects[0].inSpace, true);
  assert.equal(treeAll.projects[1].name, "outside-proj");
  assert.equal(treeAll.projects[1].inSpace, false);
  assert.equal(treeAll.standalone.length, 1);

  // Scope: 'space'
  const treeSpace = buildContainerTree({
    containers,
    spaceRoot,
    scope: "space",
  });
  assert.equal(treeSpace.projects.length, 1);
  assert.equal(treeSpace.projects[0].name, "in-space-proj");
  assert.equal(treeSpace.standalone.length, 0);
});

// =============================================================================
// Suite 11: Utilities
// =============================================================================
test("isPathEqualOrInside checks nested directory containment accurately", () => {
  assert.equal(isPathEqualOrInside("/a/b/c", "/a/b"), true);
  assert.equal(isPathEqualOrInside("/a/b", "/a/b"), true);
  assert.equal(isPathEqualOrInside("/a/b/", "/a/b"), true);
  assert.equal(isPathEqualOrInside("/a/bc", "/a/b"), false);
  assert.equal(isPathEqualOrInside("/other", "/a/b"), false);
});

test("resolveDockerContext resolves explicit and active space locations", () => {
  const ctxExplicit = resolveDockerContext({
    props: { folder: "/custom/dir", on: "remote-server" },
  });
  assert.deepEqual(ctxExplicit, { root: "/custom/dir", machine: "remote-server" });

  const ctxSpace = resolveDockerContext({
    props: {},
    spaces: () => [{ id: "sp1", active: true, folder: "/space/root", machine: null }],
  });
  assert.deepEqual(ctxSpace, { root: "/space/root", machine: null });
});

// =============================================================================
// Suite 12: flattenContainerRows (R2 AC 2)
// =============================================================================
test("flattenContainerRows preserves stable order: in-space first, declaration order, numeric replicas, not-created rows", () => {
  const tree = {
    projects: [
      {
        name: "other-proj",
        inSpace: false,
        services: [
          { name: "web", status: "running", running: true, containers: [{ id: "c1", name: "other-web-1", containerNumber: "1" }] },
        ],
      },
      {
        name: "space-proj",
        inSpace: true,
        services: [
          // "worker" has declaredOrder: 0, "api" has declaredOrder: 1, "db" has no declaredOrder (alpha fallback)
          {
            name: "worker",
            declaredOrder: 0,
            status: "running",
            running: true,
            containers: [{ id: "w1", name: "worker-1", containerNumber: "1" }],
          },
          {
            name: "api",
            declaredOrder: 1,
            status: "running",
            running: true,
            // Multi-container replicas out of numeric order: 10, 2, 1
            containers: [
              { id: "a10", name: "api-10", containerNumber: "10" },
              { id: "a2", name: "api-2", containerNumber: "2" },
              { id: "a1", name: "api-1", containerNumber: "1" },
            ],
          },
          {
            name: "db",
            status: "not-created",
            created: false,
            declared: true,
            running: false,
            containers: [],
          },
        ],
      },
    ],
    dockerfiles: [],
    standalone: [],
  };

  // Expand space-proj explicitly
  const rows = flattenContainerRows(tree, { "space-proj": true, "other-proj": false });

  // 1. Projects order: in-space first ("space-proj"), then "other-proj"
  assert.equal(rows[0].type, "project");
  assert.equal(rows[0].name, "space-proj");

  // 2. Services under space-proj:
  // worker (declaredOrder: 0)
  assert.equal(rows[1].type, "service");
  assert.equal(rows[1].name, "worker");
  // api (declaredOrder: 1)
  assert.equal(rows[2].type, "service");
  assert.equal(rows[2].name, "api");
  assert.equal(rows[2].hasReplicas, true);

  // 3. Replicas under api sorted numerically: 1, 2, 10
  assert.equal(rows[3].type, "container");
  assert.equal(rows[3].name, "api-1");
  assert.equal(rows[4].type, "container");
  assert.equal(rows[4].name, "api-2");
  assert.equal(rows[5].type, "container");
  assert.equal(rows[5].name, "api-10");

  // 4. Not-created service included with status: "not-created"
  assert.equal(rows[6].type, "service");
  assert.equal(rows[6].name, "db");
  assert.equal(rows[6].status, "not-created");
  assert.equal(rows[6].created, false);

  // 5. Next project is other-proj, collapsed (no service rows)
  assert.equal(rows[7].type, "project");
  assert.equal(rows[7].name, "other-proj");
  assert.equal(rows.length, 8);
});

// =============================================================================
// Suite 13: aggregateProjectStatus (R2 AC 2)
// =============================================================================
test("aggregateProjectStatus returns ok when all services are running", () => {
  const services = [
    { name: "web", running: true, status: "Up 2 hours", containers: [{ isRunning: true }] },
    { name: "db", running: true, status: "Up 2 hours", containers: [{ isRunning: true }] },
  ];
  assert.equal(aggregateProjectStatus(services), "ok");
});

test("aggregateProjectStatus returns warning when mixed running and stopped/not-created", () => {
  const mixed = [
    { name: "web", running: true, status: "Up 2 hours", containers: [{ isRunning: true }] },
    { name: "worker", running: false, status: "Exited (0) 10m ago", containers: [{ isRunning: false }] },
  ];
  assert.equal(aggregateProjectStatus(mixed), "warning");

  const withNotCreated = [
    { name: "web", running: true, status: "Up 2 hours", containers: [{ isRunning: true }] },
    { name: "cache", running: false, status: "not-created", containers: [] },
  ];
  assert.equal(aggregateProjectStatus(withNotCreated), "warning");
});

test("aggregateProjectStatus returns muted when none are running or empty", () => {
  assert.equal(aggregateProjectStatus([]), "muted");
  const none = [
    { name: "web", running: false, status: "Exited (0)", containers: [{ isRunning: false }] },
    { name: "db", running: false, status: "not-created", containers: [] },
  ];
  assert.equal(aggregateProjectStatus(none), "muted");
});

test("aggregateProjectStatus returns error when any is unhealthy, restarting, or dead", () => {
  const unhealthy = [
    { name: "web", running: true, status: "Up 2 hours (healthy)", containers: [{ isRunning: true, status: "Up 2h (healthy)" }] },
    { name: "api", running: true, status: "Up 2 hours (unhealthy)", containers: [{ isRunning: true, status: "Up 2h (unhealthy)", health: { status: "unhealthy" } }] },
  ];
  assert.equal(aggregateProjectStatus(unhealthy), "error");

  const restarting = [
    { name: "web", running: true, status: "Up 2 hours", containers: [{ isRunning: true }] },
    { name: "app", running: false, state: "restarting", status: "Restarting (1) 5 seconds ago", containers: [{ isRunning: false, state: "restarting" }] },
  ];
  assert.equal(aggregateProjectStatus(restarting), "error");

  const dead = [
    { name: "web", running: true, status: "Up 2 hours", containers: [{ isRunning: true }] },
    { name: "legacy", running: false, state: "dead", status: "Dead", containers: [{ isRunning: false, state: "dead" }] },
  ];
  assert.equal(aggregateProjectStatus(dead), "error");
});

// =============================================================================
// Suite 14: matchesFilter (R2 AC 2)
// =============================================================================
test("matchesFilter matches name, image, service, project, and published port case-insensitively", () => {
  const row = {
    name: "cv-mapa-web-1",
    image: "cv-mapa-web:latest",
    service: "web",
    project: "cv-mapa",
    ports: "0.0.0.0:8000->8000/tcp",
  };

  // Empty query matches everything
  assert.equal(matchesFilter(row, ""), true);
  assert.equal(matchesFilter(row, "   "), true);
  assert.equal(matchesFilter(row, null), true);

  // Name match
  assert.equal(matchesFilter(row, "cv-mapa-web-1"), true);
  assert.equal(matchesFilter(row, "WEB-1"), true);

  // Image match
  assert.equal(matchesFilter(row, "cv-mapa-web"), true);
  assert.equal(matchesFilter(row, "LATEST"), true);

  // Service match
  assert.equal(matchesFilter(row, "web"), true);
  assert.equal(matchesFilter(row, "WEB"), true);

  // Project match
  assert.equal(matchesFilter(row, "cv-mapa"), true);
  assert.equal(matchesFilter(row, "CV-MAPA"), true);

  // Port match
  assert.equal(matchesFilter(row, "8000"), true);

  // Non-matching query
  assert.equal(matchesFilter(row, "redis"), false);
  assert.equal(matchesFilter(row, "9000"), false);
});

// =============================================================================
// Suite 15: parseEngineInfo & engineStateFromResults (R2 AC 2)
// =============================================================================
test("parseEngineInfo parses info JSON stdout correctly", () => {
  const jsonStr = JSON.stringify({
    ID: "engine-123",
    ServerVersion: "29.5.3",
    Containers: 19,
    ContainersRunning: 16,
    ContainersPaused: 0,
    ContainersStopped: 3,
    Images: 101,
    OperatingSystem: "Linux",
    Architecture: "aarch64",
  });

  const parsed = parseEngineInfo(jsonStr);
  assert.equal(parsed.serverVersion, "29.5.3");
  assert.equal(parsed.containers, 19);
  assert.equal(parsed.containersRunning, 16);
  assert.equal(parsed.images, 101);

  assert.equal(parseEngineInfo(""), null);
  assert.equal(parseEngineInfo(null), null);
});

test("engineStateFromResults distinguishes reachable, daemon-down, and cli-missing", () => {
  // Reachable
  const reachable = engineStateFromResults({
    info: { code: 0, ServerVersion: "29.5.3" },
    versionProbe: { code: 0, stdout: JSON.stringify({ Server: { Version: "29.5.3" } }) },
  });
  assert.equal(reachable.status, "reachable");
  assert.equal(reachable.reachable, true);
  assert.equal(reachable.version, "29.5.3");

  // Daemon down
  const daemonDown = engineStateFromResults({
    info: { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" },
    versionProbe: { code: 1, stderr: "Cannot connect to the Docker daemon" },
  });
  assert.equal(daemonDown.status, "daemon-down");
  assert.equal(daemonDown.reachable, false);
  assert.equal(daemonDown.version, null);

  // CLI missing
  const cliMissing = engineStateFromResults({
    info: { code: 127, error: new Error("spawn docker ENOENT") },
    versionProbe: { code: 127, stderr: "bash: docker: command not found" },
  });
  assert.equal(cliMissing.status, "cli-missing");
  assert.equal(cliMissing.reachable, false);
  assert.equal(cliMissing.version, null);
});

// =============================================================================
// Suite 16: parseComposeConfig & discoverComposeGroups (R2 AC 2)
// =============================================================================
test("parseComposeConfig parses declared services, profiles, ports, and image/build", () => {
  const jsonStr = JSON.stringify({
    name: "test-app",
    services: {
      web: {
        image: "nginx:alpine",
        ports: [{ mode: "ingress", target: 80, published: "8080", protocol: "tcp" }],
        profiles: ["frontend"],
      },
      api: {
        build: { context: "./api", dockerfile: "Dockerfile" },
        ports: [{ mode: "ingress", target: 3000, published: "3000", protocol: "tcp" }],
        profiles: [],
      },
    },
  });

  const parsed = parseComposeConfig(jsonStr);
  assert.equal(parsed.name, "test-app");
  assert.equal(parsed.services.web.image, "nginx:alpine");
  assert.deepEqual(parsed.services.web.profiles, ["frontend"]);
  assert.equal(parsed.services.web.ports[0].published, "8080");
  assert.deepEqual(parsed.services.api.build, { context: "./api", dockerfile: "Dockerfile" });
});

test("discoverComposeGroups pairs compose.yaml with compose.override.yaml and keeps compose.dev.yaml separate", () => {
  const paths = [
    "/projects/my-app/compose.yaml",
    "/projects/my-app/compose.override.yaml",
    "/projects/my-app/compose.dev.yaml",
    "/projects/other-app/docker-compose.yml",
    "/projects/other-app/docker-compose.override.yml",
  ];

  const groups = discoverComposeGroups(paths);

  // Group 1: /projects/my-app/compose.yaml paired with compose.override.yaml
  const myAppMain = groups.find((g) => g.file === "/projects/my-app/compose.yaml");
  assert.ok(myAppMain);
  assert.deepEqual(myAppMain.files, [
    "/projects/my-app/compose.yaml",
    "/projects/my-app/compose.override.yaml",
  ]);
  assert.equal(myAppMain.override, "/projects/my-app/compose.override.yaml");

  // Group 2: /projects/my-app/compose.dev.yaml stays separate
  const myAppDev = groups.find((g) => g.file === "/projects/my-app/compose.dev.yaml");
  assert.ok(myAppDev);
  assert.deepEqual(myAppDev.files, ["/projects/my-app/compose.dev.yaml"]);
  assert.equal(myAppDev.variant, "dev");

  // Group 3: /projects/other-app/docker-compose.yml paired with docker-compose.override.yml
  const otherAppMain = groups.find((g) => g.file === "/projects/other-app/docker-compose.yml");
  assert.ok(otherAppMain);
  assert.deepEqual(otherAppMain.files, [
    "/projects/other-app/docker-compose.yml",
    "/projects/other-app/docker-compose.override.yml",
  ]);
});

// =============================================================================
// Suite 17: parseComposeLs (R2 AC 2)
// =============================================================================
test("parseComposeLs parses JSON array from docker compose ls --all --format json", () => {
  const jsonStr = JSON.stringify([
    { Name: "cv-mapa", Status: "running(3)", ConfigFiles: "/home/cv-mapa/compose.yaml" },
    { Name: "node-aec", Status: "exited(2), running(5)", ConfigFiles: "/home/node-aec/compose.yaml" },
  ]);

  const parsed = parseComposeLs(jsonStr);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "cv-mapa");
  assert.equal(parsed[0].status, "running(3)");
  assert.equal(parsed[0].configFiles, "/home/cv-mapa/compose.yaml");
  assert.equal(parsed[1].name, "node-aec");

  // Empty input returns empty array
  assert.deepEqual(parseComposeLs(""), []);
  assert.deepEqual(parseComposeLs(null), []);
});

