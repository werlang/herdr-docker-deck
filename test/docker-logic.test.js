import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateDockerIdentifier,
  classifyDockerFile,
  isSecretEnvKey,
  parseContainerLabels,
  isPathInside,
  resolveDockerContext,
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
  buildVolumeInspectArgs,
  buildVolumeBrowseArgs,
  buildVolumeBackupArgs,
  buildVolumeRestoreArgs,
  buildVolumeCloneArgs,
  buildVolumePruneArgs,
  buildImageHistoryArgs,
  buildImagePruneArgs,
  buildImageRmArgs,
  buildNetworkInspectArgs,
  buildNetworkPruneArgs,
  buildNetworkRmArgs,
  buildSystemDfArgs,
  buildBuilderPruneArgs,
  normalizeContainerInspect,
  buildContainerTree,
  getProjectMenuItems,
  getServiceMenuItems,
  getContainerMenuItems,
  buildConfirmationSpec,
  findExistingActionTerminal,
  clampMenuPosition,
  resolveDockerMenuPosition,
  groupDiscoveredComposeFiles,
  parseComposeConfigJson,
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
} from "../mods/docker-manager/docker-logic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

// Load fixtures
const containersRaw = fs
  .readFileSync(path.join(fixturesDir, "containers.ndjson"), "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const composeLs = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "compose-ls.json"), "utf8")
);

const inspectContainer = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "inspect-container.json"), "utf8")
);

const imagesRaw = fs
  .readFileSync(path.join(fixturesDir, "images.ndjson"), "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const volumesRaw = fs
  .readFileSync(path.join(fixturesDir, "volumes.ndjson"), "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const networksRaw = fs
  .readFileSync(path.join(fixturesDir, "networks.ndjson"), "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const systemDfRaw = fs.readFileSync(path.join(fixturesDir, "system-df.ndjson"), "utf8");
const systemDfVRaw = fs.readFileSync(path.join(fixturesDir, "system-df-v.json"), "utf8");
const infoRaw = JSON.parse(fs.readFileSync(path.join(fixturesDir, "info.json"), "utf8"));

// ============================================================================
// 1. Labels and Identity
// ============================================================================

test("parseContainerLabels: returns empty object for falsy or empty inputs", () => {
  assert.deepEqual(parseContainerLabels(""), {});
  assert.deepEqual(parseContainerLabels(null), {});
  assert.deepEqual(parseContainerLabels(undefined), {});
  assert.deepEqual(parseContainerLabels("   "), {});
});

test("parseContainerLabels: parses standard key-value pairs", () => {
  const result = parseContainerLabels("com.example.vendor=ACME,version=1.0.0");
  assert.equal(result["com.example.vendor"], "ACME");
  assert.equal(result["version"], "1.0.0");
});

test("parseContainerLabels: preserves commas inside config_files", () => {
  const raw =
    "com.docker.compose.project.config_files=/home/app/compose.yaml,/home/app/compose.override.yaml,com.docker.compose.project=webapp";
  const parsed = parseContainerLabels(raw);
  assert.equal(
    parsed["com.docker.compose.project.config_files"],
    "/home/app/compose.yaml,/home/app/compose.override.yaml"
  );
  assert.equal(parsed["com.docker.compose.project"], "webapp");
});

test("parseContainerLabels: correctly handles '=' inside values", () => {
  const raw = "database.url=postgres://user:pass@host/db?sslmode=disable,env=prod";
  const parsed = parseContainerLabels(raw);
  assert.equal(parsed["database.url"], "postgres://user:pass@host/db?sslmode=disable");
  assert.equal(parsed["env"], "prod");
});

test("parseContainerLabels: parses labels from fixture container", () => {
  const row = containersRaw.find((c) => (c.Labels || "").includes("com.docker.compose.project="));
  assert.ok(row, "the fixture must contain at least one Compose container");
  const labels = parseContainerLabels(row.Labels);
  assert.ok(labels["com.docker.compose.project"]);
  assert.ok(labels["com.docker.compose.service"]);
  // multi-file config labels stay intact (commas inside the value are not separators)
  const multi = containersRaw.find((c) => (c.Labels || "").includes("config_files=") && (c.Labels || "").includes(","));
  if (multi) {
    const parsed = parseContainerLabels(multi.Labels);
    const files = parsed["com.docker.compose.project.config_files"] || "";
    assert.ok(files.length > 0);
  }
});

test("validateDockerIdentifier: accepts valid docker identifiers", () => {
  assert.equal(validateDockerIdentifier("cv-mapa"), true);
  assert.equal(validateDockerIdentifier("node_aec-1"), true);
  assert.equal(validateDockerIdentifier("my.volume.name"), true);
  assert.equal(validateDockerIdentifier("sha256:1234abcd"), true);
});

test("validateDockerIdentifier: throws on invalid or unsafe identifiers", () => {
  assert.throws(() => validateDockerIdentifier(""), /non-empty string/);
  assert.throws(() => validateDockerIdentifier("test; rm -rf /"), /forbidden/);
  assert.throws(() => validateDockerIdentifier("container name with spaces"), /forbidden/);
  assert.throws(() => validateDockerIdentifier("foo$(whoami)"), /forbidden/);
  assert.throws(() => validateDockerIdentifier(null), /non-empty string/);
});

test("classifyDockerFile: identifies compose, dockerfile, and unknown files", () => {
  assert.equal(classifyDockerFile("compose.yaml"), "compose");
  assert.equal(classifyDockerFile("/path/to/docker-compose.yml"), "compose");
  assert.equal(classifyDockerFile("compose.override.yaml"), "compose");
  assert.equal(classifyDockerFile("Dockerfile"), "dockerfile");
  assert.equal(classifyDockerFile("Dockerfile.prod"), "dockerfile");
  assert.equal(classifyDockerFile("frontend.dockerfile"), "dockerfile");
  assert.equal(classifyDockerFile("package.json"), null);
  assert.equal(classifyDockerFile(""), null);
});

test("isSecretEnvKey: identifies secret vs non-secret environment keys", () => {
  assert.equal(isSecretEnvKey("PASSWORD"), true);
  assert.equal(isSecretEnvKey("DB_PASSWORD"), true);
  assert.equal(isSecretEnvKey("API_KEY"), true);
  assert.equal(isSecretEnvKey("PRIVATE_KEY"), true);
  assert.equal(isSecretEnvKey("JWT_SECRET"), true);
  assert.equal(isSecretEnvKey("AUTH_TOKEN"), true);
  assert.equal(isSecretEnvKey("DATABASE_URL"), true);
  assert.equal(isSecretEnvKey("CREDENTIALS"), true);

  assert.equal(isSecretEnvKey("PORT"), false);
  assert.equal(isSecretEnvKey("NODE_ENV"), false);
  assert.equal(isSecretEnvKey("HOST"), false);
  assert.equal(isSecretEnvKey("DEBUG"), false);
  assert.equal(isSecretEnvKey(""), false);
});

test("isPathInside: correctly checks path containment", () => {
  assert.equal(isPathInside("/home/user", "/home/user/project"), true);
  assert.equal(isPathInside("/home/user", "/home/user"), true);
  assert.equal(isPathInside("/home/user/", "/home/user/project/file.txt"), true);
  assert.equal(isPathInside("/home/user", "/home/user2"), false);
  assert.equal(isPathInside("/var/log", "/home/user"), false);
  assert.equal(isPathInside("", "/home/user"), false);
});

// ============================================================================
// 2. Tree Construction (buildContainerTree)
// ============================================================================

test("buildContainerTree: correctly groups projects from containers.ndjson and compose-ls.json", () => {
  const groups = buildContainerTree({
    containers: containersRaw,
    composeLs,
  });

  const projGroup = groups.find((g) => g.id === "projects");
  assert.ok(projGroup, "Compose Projects group should exist");

  const byName = new Map(projGroup.items.map((p) => [p.name, p]));

  // Assert expected counts from brief:
  // cv-mapa 3/3, home 1/1, kuma 1/1, node-aec 5/7, qstoes 2/2, tuya 1/2, whatsbot 3/3
  assert.equal(byName.get("cv-mapa")?.runningCount, 3);
  assert.equal(byName.get("cv-mapa")?.totalCount, 3);

  assert.equal(byName.get("home")?.runningCount, 1);
  assert.equal(byName.get("home")?.totalCount, 1);

  assert.equal(byName.get("kuma")?.runningCount, 1);
  assert.equal(byName.get("kuma")?.totalCount, 1);

  assert.equal(byName.get("node-aec")?.runningCount, 5);
  assert.equal(byName.get("node-aec")?.totalCount, 7);

  assert.equal(byName.get("qstoes")?.runningCount, 2);
  assert.equal(byName.get("qstoes")?.totalCount, 2);

  assert.equal(byName.get("tuya")?.runningCount, 1);
  assert.equal(byName.get("tuya")?.totalCount, 2);

  assert.equal(byName.get("whatsbot")?.runningCount, 3);
  assert.equal(byName.get("whatsbot")?.totalCount, 3);
});

test("buildContainerTree: handles not-created services for discovered projects", () => {
  const discoveredCompose = [
    {
      project: "uncreated-proj",
      filePath: "/work/uncreated-proj/compose.yaml",
      folder: "/work/uncreated-proj",
      config: {
        services: {
          web: { image: "nginx:alpine", ports: ["80:80"] },
          db: { image: "postgres:16" },
        },
      },
    },
  ];

  const groups = buildContainerTree({
    containers: [],
    composeLs: [],
    discoveredCompose,
  });

  const projGroup = groups.find((g) => g.id === "projects");
  assert.ok(projGroup);
  const proj = projGroup.items.find((p) => p.name === "uncreated-proj");
  assert.ok(proj);
  assert.equal(proj.notCreated, true);
  assert.equal(proj.services.length, 2);
  assert.equal(proj.services[0].notCreated, true);
  assert.equal(proj.services[1].notCreated, true);
});

test("buildContainerTree: handles inactive-profile services", () => {
  const discoveredCompose = [
    {
      project: "profiles-proj",
      filePath: "/work/profiles-proj/compose.yaml",
      activeProfiles: ["frontend"],
      config: {
        services: {
          app: { image: "node:alpine", profiles: ["frontend"] },
          admin: { image: "adminer", profiles: ["tools"] },
        },
      },
    },
  ];

  const groups = buildContainerTree({
    containers: [],
    composeLs: [],
    discoveredCompose,
  });

  const proj = groups.find((g) => g.id === "projects")?.items.find((p) => p.name === "profiles-proj");
  assert.ok(proj);
  assert.equal(proj.services.length, 1);
  assert.equal(proj.services[0].name, "app");
  assert.equal(proj.inactiveProfiles.length, 1);
  assert.equal(proj.inactiveProfiles[0].name, "admin");
});

test("buildContainerTree: detects mixedSources when containers report different working dirs", () => {
  const mockContainers = [
    {
      ID: "c1",
      Names: "/c1",
      Labels: "com.docker.compose.project=mixed,com.docker.compose.project.working_dir=/dir/one",
      State: "running",
    },
    {
      ID: "c2",
      Names: "/c2",
      Labels: "com.docker.compose.project=mixed,com.docker.compose.project.working_dir=/dir/two",
      State: "running",
    },
  ];

  const groups = buildContainerTree({ containers: mockContainers });
  const proj = groups.find((g) => g.id === "projects")?.items.find((p) => p.name === "mixed");
  assert.ok(proj);
  assert.equal(proj.mixedSources, true);
});

test("buildContainerTree: scope 'space' filters out projects outside spaceRoot", () => {
  const groupsAll = buildContainerTree({
    containers: containersRaw,
    composeLs,
    scope: "all",
  });
  const allProjs = groupsAll.find((g) => g.id === "projects")?.items || [];
  assert.equal(allProjs.length, 7);

  const groupsSpace = buildContainerTree({
    containers: containersRaw,
    composeLs,
    scope: "space",
    spaceRoot: "/srv/kuma",
  });
  const spaceProjs = groupsSpace.find((g) => g.id === "projects")?.items || [];
  assert.equal(spaceProjs.length, 1);
  assert.equal(spaceProjs[0].name, "kuma");
});

test("buildContainerTree: text filter matches container name, image, or project", () => {
  const groups = buildContainerTree({
    containers: containersRaw,
    composeLs,
    filter: "kuma",
  });
  const projs = groups.find((g) => g.id === "projects")?.items || [];
  assert.equal(projs.length, 1);
  assert.equal(projs[0].name, "kuma");
});

test("buildContainerTree: isolates standalone and dockerfile containers", () => {
  const mockContainers = [
    {
      ID: "sa1",
      Names: "/standalone-ctr",
      Image: "redis:alpine",
      State: "running",
      Labels: "",
    },
    {
      ID: "df1",
      Names: "/df-ctr",
      Image: "custom:latest",
      State: "running",
      Labels: "herdr.docker-manager.source=/path/to/Dockerfile",
    },
  ];

  const groups = buildContainerTree({
    containers: mockContainers,
    discoveredDockerfiles: [{ filePath: "/path/to/Dockerfile", relativePath: "Dockerfile" }],
  });

  const saGroup = groups.find((g) => g.id === "standalone");
  assert.ok(saGroup);
  assert.equal(saGroup.items.length, 1);
  assert.equal(saGroup.items[0].name, "standalone-ctr");

  const dfGroup = groups.find((g) => g.id === "dockerfiles");
  assert.ok(dfGroup);
  assert.equal(dfGroup.items.length, 1);
  assert.equal(dfGroup.items[0].containers.length, 1);
});

// ============================================================================
// 3. Argv Builders - Compose
// ============================================================================

test("buildComposeArgs: builds base compose command with project and files", () => {
  const target = {
    project: "myproj",
    workingDir: "/app",
    configFiles: ["/app/compose.yaml", "/app/compose.override.yaml"],
  };
  const args = buildComposeArgs(target, ["ps"]);
  assert.deepEqual(args, [
    "compose",
    "-p",
    "myproj",
    "--project-directory",
    "/app",
    "-f",
    "/app/compose.yaml",
    "-f",
    "/app/compose.override.yaml",
    "ps",
  ]);
});

test("buildComposeUpArgs: builds compose up -d args", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeUpArgs(target), ["compose", "-p", "myproj", "up", "-d"]);
  assert.deepEqual(buildComposeUpArgs(target, { build: true, service: "web" }), [
    "compose",
    "-p",
    "myproj",
    "up",
    "-d",
    "--build",
    "web",
  ]);
});

test("buildComposeDownArgs: builds compose down args", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeDownArgs(target), ["compose", "-p", "myproj", "down"]);
  assert.deepEqual(buildComposeDownArgs(target, { volumes: true }), [
    "compose",
    "-p",
    "myproj",
    "down",
    "-v",
  ]);
});

test("buildComposeStartArgs: builds compose start args", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeStartArgs(target), ["compose", "-p", "myproj", "start"]);
  assert.deepEqual(buildComposeStartArgs(target, "web"), ["compose", "-p", "myproj", "start", "web"]);
});

test("buildComposeStopArgs: builds compose stop args", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeStopArgs(target), ["compose", "-p", "myproj", "stop"]);
  assert.deepEqual(buildComposeStopArgs(target, "api"), ["compose", "-p", "myproj", "stop", "api"]);
});

test("buildComposeRestartArgs: builds compose restart args", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeRestartArgs(target), ["compose", "-p", "myproj", "restart"]);
  assert.deepEqual(buildComposeRestartArgs(target, "db"), ["compose", "-p", "myproj", "restart", "db"]);
});

test("buildComposePullArgs: builds compose pull args", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposePullArgs(target), ["compose", "-p", "myproj", "pull"]);
  assert.deepEqual(buildComposePullArgs(target, "worker"), [
    "compose",
    "-p",
    "myproj",
    "pull",
    "worker",
  ]);
});

test("buildComposeBuildArgs: builds compose build args", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeBuildArgs(target), ["compose", "-p", "myproj", "build"]);
  assert.deepEqual(buildComposeBuildArgs(target, "web"), ["compose", "-p", "myproj", "build", "web"]);
});

test("buildComposeRebuildArgs: builds force rebuild argv", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeRebuildArgs(target, "web"), [
    "compose",
    "-p",
    "myproj",
    "up",
    "-d",
    "--build",
    "--force-recreate",
    "--no-deps",
    "web",
  ]);
});

test("buildComposeRecreateArgs: builds force recreate argv", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeRecreateArgs(target, "web"), [
    "compose",
    "-p",
    "myproj",
    "up",
    "-d",
    "--force-recreate",
    "--no-deps",
    "web",
  ]);
});

test("buildComposeRmArgs: builds rm argv", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeRmArgs(target, "web"), [
    "compose",
    "-p",
    "myproj",
    "rm",
    "-s",
    "-f",
    "web",
  ]);
});

test("buildComposeLogsArgs: builds compose logs argv with tail", () => {
  const target = { project: "myproj" };
  assert.deepEqual(buildComposeLogsArgs(target, null, 200), [
    "docker",
    "compose",
    "-p",
    "myproj",
    "logs",
    "-f",
    "--tail",
    "200",
  ]);
  assert.deepEqual(buildComposeLogsArgs(target, "api", 500), [
    "docker",
    "compose",
    "-p",
    "myproj",
    "logs",
    "-f",
    "--tail",
    "500",
    "api",
  ]);
});

// ============================================================================
// 4. Argv Builders - Container & Dockerfile
// ============================================================================

test("buildContainerLogsArgs: builds docker logs argv", () => {
  assert.deepEqual(buildContainerLogsArgs("ctr123", 100), [
    "docker",
    "logs",
    "-f",
    "--tail",
    "100",
    "ctr123",
  ]);
});

test("buildContainerShellArgs: auto fallback, bash, and sh", () => {
  assert.deepEqual(buildContainerShellArgs("ctr123", "bash"), [
    "docker",
    "exec",
    "-it",
    "ctr123",
    "bash",
  ]);
  assert.deepEqual(buildContainerShellArgs("ctr123", "sh"), [
    "docker",
    "exec",
    "-it",
    "ctr123",
    "sh",
  ]);
  const autoArgs = buildContainerShellArgs("ctr123", "auto");
  assert.equal(autoArgs[0], "docker");
  assert.equal(autoArgs[1], "exec");
  assert.equal(autoArgs[autoArgs.length - 1], "command -v bash >/dev/null 2>&1 && exec bash || exec sh");
});

test("buildContainerActionArgs: supports lifecycle actions and rejects invalid actions", () => {
  assert.deepEqual(buildContainerActionArgs("start", "c1"), ["docker", "start", "c1"]);
  assert.deepEqual(buildContainerActionArgs("stop", "c1"), ["docker", "stop", "c1"]);
  assert.deepEqual(buildContainerActionArgs("restart", "c1"), ["docker", "restart", "c1"]);
  assert.deepEqual(buildContainerActionArgs("pause", "c1"), ["docker", "pause", "c1"]);
  assert.deepEqual(buildContainerActionArgs("unpause", "c1"), ["docker", "unpause", "c1"]);
  assert.deepEqual(buildContainerActionArgs("kill", "c1"), ["docker", "kill", "c1"]);
  assert.throws(() => buildContainerActionArgs("invalid", "c1"), /Invalid/);
});

test("buildContainerRmArgs: standard vs force removal", () => {
  assert.deepEqual(buildContainerRmArgs("c1"), ["docker", "rm", "c1"]);
  assert.deepEqual(buildContainerRmArgs("c1", { force: true }), ["docker", "rm", "-f", "c1"]);
});

test("parseDockerfileExpose: extracts valid exposed ports", () => {
  const dockerfile = `
FROM node:20-alpine
WORKDIR /app
EXPOSE 3000 8080/tcp
EXPOSE 9000
# EXPOSE 9999
CMD ["node", "server.js"]
`;
  const ports = parseDockerfileExpose(dockerfile);
  assert.deepEqual(ports, ["3000", "8080", "9000"]);
});

test("buildDockerfileBuildArgs: builds build argv with context and build args", () => {
  const args = buildDockerfileBuildArgs({
    filePath: "/work/src/Dockerfile",
    tag: "myapp:dev",
    buildArgs: { NODE_ENV: "production", PORT: "3000" },
  });
  assert.deepEqual(args, [
    "build",
    "-t",
    "myapp:dev",
    "-f",
    "/work/src/Dockerfile",
    "--build-arg",
    "NODE_ENV=production",
    "--build-arg",
    "PORT=3000",
    "/work/src",
  ]);
});

test("buildDockerfileRunArgs: includes herdr source label, ports, and env file", () => {
  const args = buildDockerfileRunArgs({
    filePath: "/work/Dockerfile",
    tag: "myapp:dev",
    containerName: "my-running-app",
    ports: ["3000:3000", "8080:8080"],
    envFile: "/work/.env",
    detached: true,
  });

  assert.deepEqual(args, [
    "run",
    "-d",
    "--name",
    "my-running-app",
    "--label",
    "herdr.docker-manager.source=/work/Dockerfile",
    "-p",
    "3000:3000",
    "-p",
    "8080:8080",
    "--env-file",
    "/work/.env",
    "myapp:dev",
  ]);

  const rmArgs = buildDockerfileRunArgs({
    filePath: "/work/Dockerfile",
    tag: "myapp:dev",
    containerName: "my-app",
    detached: false,
  });
  assert.ok(rmArgs.includes("--rm"));
});

// ============================================================================
// 5. Argv Builders - Volume, Image, Network, System
// ============================================================================

test("buildVolumeInspectArgs: returns volume inspect argv", () => {
  assert.deepEqual(buildVolumeInspectArgs("my-vol"), [
    "volume",
    "inspect",
    "--format",
    "{{json .}}",
    "my-vol",
  ]);
});

test("buildVolumeBrowseArgs: returns read-only alpine shell argv", () => {
  assert.deepEqual(buildVolumeBrowseArgs("my-vol"), [
    "docker",
    "run",
    "--rm",
    "-it",
    "-v",
    "my-vol:/data:ro",
    "-w",
    "/data",
    "alpine:3",
    "sh",
  ]);
});

test("buildVolumeBackupArgs: returns tar backup command", () => {
  const args = buildVolumeBackupArgs("data-vol", "/home/backups", "data.tar.gz");
  assert.deepEqual(args, [
    "run",
    "--rm",
    "-v",
    "data-vol:/data:ro",
    "-v",
    "/home/backups:/backup",
    "alpine:3",
    "tar",
    "czf",
    "/backup/data.tar.gz",
    "-C",
    "/data",
    ".",
  ]);
});

test("buildVolumeRestoreArgs: returns restore command with safe cleanup", () => {
  const args = buildVolumeRestoreArgs("data-vol", "/home/backups", "data.tar.gz");
  assert.equal(args[0], "run");
  assert.ok(args.includes("data-vol:/data"));
  assert.ok(args.includes("/home/backups:/backup:ro"));
  assert.ok(args[args.length - 1].includes('tar xzf "/backup/data.tar.gz" -C /data'));
});

test("buildVolumeCloneArgs: returns createArgs and copyArgs", () => {
  const plan = buildVolumeCloneArgs("vol-src", "vol-dst");
  assert.deepEqual(plan.createArgs, ["volume", "create", "vol-dst"]);
  assert.deepEqual(plan.copyArgs, [
    "run",
    "--rm",
    "-v",
    "vol-src:/from:ro",
    "-v",
    "vol-dst:/to",
    "alpine:3",
    "sh",
    "-c",
    "cp -a /from/. /to/",
  ]);
});

test("buildVolumePruneArgs: supports standard and --all prune", () => {
  assert.deepEqual(buildVolumePruneArgs(false), ["volume", "prune", "-f"]);
  assert.deepEqual(buildVolumePruneArgs(true), ["volume", "prune", "-f", "--all"]);
});

test("buildImageHistoryArgs: returns image history argv", () => {
  assert.deepEqual(buildImageHistoryArgs("img123"), [
    "image",
    "history",
    "--no-trunc",
    "--format",
    "{{json .}}",
    "img123",
  ]);
});

test("buildImagePruneArgs: supports standard (dangling) and all unused images", () => {
  assert.deepEqual(buildImagePruneArgs(), ["image", "prune", "-f"]);
  assert.deepEqual(buildImagePruneArgs({ all: true }), ["image", "prune", "-f", "-a"]);
});

test("buildImageRmArgs: standard vs force removal", () => {
  assert.deepEqual(buildImageRmArgs("img123"), ["image", "rm", "img123"]);
  assert.deepEqual(buildImageRmArgs("img123", { force: true }), ["image", "rm", "-f", "img123"]);
});

test("buildNetworkInspectArgs: returns network inspect argv", () => {
  assert.deepEqual(buildNetworkInspectArgs("net123"), [
    "network",
    "inspect",
    "--format",
    "{{json .}}",
    "net123",
  ]);
});

test("buildNetworkPruneArgs: returns network prune argv", () => {
  assert.deepEqual(buildNetworkPruneArgs(), ["network", "prune", "-f"]);
});

test("buildNetworkRmArgs: returns network rm argv", () => {
  assert.deepEqual(buildNetworkRmArgs("net123"), ["network", "rm", "net123"]);
});

test("buildSystemDfArgs: standard vs verbose", () => {
  assert.deepEqual(buildSystemDfArgs(), ["system", "df", "--format", "{{json .}}"]);
  assert.deepEqual(buildSystemDfArgs({ verbose: true }), ["system", "df", "-v", "--format", "json"]);
});

test("buildBuilderPruneArgs: standard vs olderThan7d filter", () => {
  assert.deepEqual(buildBuilderPruneArgs(), ["builder", "prune", "-f"]);
  assert.deepEqual(buildBuilderPruneArgs({ olderThan7d: true }), [
    "builder",
    "prune",
    "-f",
    "--filter",
    "until=168h",
  ]);
});

// ============================================================================
// 6. Menus and Confirmation
// ============================================================================

test("getProjectMenuItems: disabled/enabled states reflect project status", () => {
  const runningProj = {
    name: "web",
    runningCount: 2,
    totalCount: 2,
    configFiles: ["/compose.yaml"],
    workingDirs: ["/"],
  };
  const items = getProjectMenuItems(runningProj);
  const startItem = items.find((i) => i.id === "start");
  const stopItem = items.find((i) => i.id === "stop");
  assert.equal(startItem?.enabled, false); // already running
  assert.equal(stopItem?.enabled, true);

  const stoppedProj = {
    name: "web",
    runningCount: 0,
    totalCount: 2,
    configFiles: ["/compose.yaml"],
    workingDirs: ["/"],
  };
  const stoppedItems = getProjectMenuItems(stoppedProj);
  assert.equal(stoppedItems.find((i) => i.id === "start")?.enabled, true);
  assert.equal(stoppedItems.find((i) => i.id === "stop")?.enabled, false);
});

test("getServiceMenuItems: includes port actions and reflects service state", () => {
  const service = {
    name: "api",
    runningCount: 1,
    totalCount: 1,
    containers: [
      {
        id: "c1",
        ports: "0.0.0.0:8080->80/tcp",
      },
    ],
  };
  const project = { name: "myproj", configFiles: ["/compose.yaml"] };
  const items = getServiceMenuItems(service, project);

  const portItem = items.find((i) => i.id === "open-port:8080");
  assert.ok(portItem);
  assert.equal(portItem.enabled, true);

  const rebuildItem = items.find((i) => i.id === "rebuild");
  assert.equal(rebuildItem?.enabled, true);
});

test("getContainerMenuItems: returns lifecycle items for container", () => {
  const running = { id: "c1", shortId: "c1", running: true, state: "running" };
  const rItems = getContainerMenuItems(running);
  assert.equal(rItems.find((i) => i.id === "start")?.enabled, false);
  assert.equal(rItems.find((i) => i.id === "stop")?.enabled, true);

  const stopped = { id: "c2", shortId: "c2", running: false, state: "exited" };
  const sItems = getContainerMenuItems(stopped);
  assert.equal(sItems.find((i) => i.id === "start")?.enabled, true);
  assert.equal(sItems.find((i) => i.id === "stop")?.enabled, false);
});

test("getImageMenuItems: reflects dangling vs in-use state", () => {
  const inUse = { id: "img1", dangling: false, usedByRunningContainer: true };
  const inUseItems = getImageMenuItems(inUse);
  assert.equal(inUseItems.find((i) => i.id === "remove-image")?.enabled, false);

  const unused = { id: "img2", dangling: true, usedByRunningContainer: false };
  const unusedItems = getImageMenuItems(unused);
  assert.equal(unusedItems.find((i) => i.id === "remove-image")?.enabled, true);
});

test("getVolumeMenuItems: reflects in-use state", () => {
  const inUse = { name: "vol1", inUse: true, usedByRunningContainer: true };
  const inUseItems = getVolumeMenuItems(inUse);
  assert.equal(inUseItems.find((i) => i.id === "remove-volume")?.enabled, false);

  const unused = { name: "vol2", inUse: false, usedByRunningContainer: false };
  const unusedItems = getVolumeMenuItems(unused);
  assert.equal(unusedItems.find((i) => i.id === "remove-volume")?.enabled, true);
});

test("getNetworkMenuItems: built-in networks cannot be removed", () => {
  const bridgeNet = { name: "bridge", id: "n1", builtIn: true, connectedCount: 0 };
  const bridgeItems = getNetworkMenuItems(bridgeNet);
  assert.equal(bridgeItems.find((i) => i.id === "remove-network")?.enabled, false);

  const customNet = { name: "custom", id: "n2", builtIn: false, connectedCount: 0 };
  const customItems = getNetworkMenuItems(customNet);
  assert.equal(customItems.find((i) => i.id === "remove-network")?.enabled, true);
});

test("getDockerfileMenuItems: rebuild requires prior run config", () => {
  const withoutRun = getDockerfileMenuItems({ filePath: "/Dockerfile" }, null);
  assert.equal(withoutRun.find((i) => i.id === "rebuild-replace")?.enabled, false);

  const withRun = getDockerfileMenuItems({ filePath: "/Dockerfile" }, { tag: "test:latest" });
  assert.equal(withRun.find((i) => i.id === "rebuild-replace")?.enabled, true);
});

test("buildConfirmationSpec: distinguishes typed vs plain confirmation", () => {
  const plainSpec = buildConfirmationSpec("down", { name: "myproj" });
  assert.equal(plainSpec.typedTarget, null);
  assert.equal(plainSpec.destructive, true);

  const typedSpec = buildConfirmationSpec("down-volumes", { name: "myproj" });
  assert.equal(typedSpec.typedTarget, "myproj");
  assert.equal(typedSpec.destructive, true);
});

test("buildGranularPrunePlan: generates correct prune commands and typed confirm flags", () => {
  const planSafe = buildGranularPrunePlan({ containers: true, buildCache: true });
  assert.equal(planSafe.requiresTypedConfirm, false);
  assert.equal(planSafe.commands.length, 2);

  const planRisky = buildGranularPrunePlan({ volumes: true, unusedImages: true });
  assert.equal(planRisky.requiresTypedConfirm, true);
  assert.equal(planRisky.highWarning, true);
});

// ============================================================================
// 7. Inspection Normalization
// ============================================================================

test("normalizeContainerInspect: normalizes inspect-container.json fixture correctly", () => {
  const raw = inspectContainer[0];
  const norm = normalizeContainerInspect(raw);

  assert.equal(norm.name, "fixture-container");
  assert.equal(norm.id, raw.Id);
  assert.equal(norm.shortId, raw.Id.slice(0, 12));
  assert.equal(norm.state.status, "running");
  assert.equal(norm.health.status, "healthy");
  assert.equal(norm.restartPolicy.name, "unless-stopped");
  assert.equal(norm.workingDir, "/");
  assert.deepEqual(norm.composeFiles, ["/srv/cv-mapa/compose.yaml"]);
  assert.ok(Array.isArray(norm.mounts));
  assert.ok(Array.isArray(norm.networks));
  assert.ok(Array.isArray(norm.ports));
});

test("normalizeContainerInspect: masks secret environment variables", () => {
  const raw = {
    Id: "1234567890ab",
    Name: "/test",
    Config: {
      Env: [
        "NODE_ENV=production",
        "DATABASE_URL=postgres://user:secret@localhost:5432/db",
        "API_SECRET_KEY=abcdef123456",
        "PORT=8080",
      ],
    },
  };
  const norm = normalizeContainerInspect(raw);
  const byKey = new Map(norm.env.map((e) => [e.key, e]));
  assert.equal(byKey.get("NODE_ENV")?.secret, false);
  assert.equal(byKey.get("DATABASE_URL")?.secret, true);
  assert.equal(byKey.get("API_SECRET_KEY")?.secret, true);
  assert.equal(byKey.get("PORT")?.secret, false);
});

test("normalizeImageInspect: normalizes image inspect data and history", () => {
  const raw = {
    Id: "sha256:7f8c0570b555845cb06fa835a2d0eb274bfbfd107a61d1e4e2079bb48de16bc4",
    RepoTags: ["node:22-alpine"],
    RepoDigests: ["node@sha256:..."],
    Created: "2026-11-01T00:00:00Z",
    Size: 150000000,
    Architecture: "amd64",
    Os: "linux",
    Config: {
      Cmd: ["node"],
      Env: ["NODE_VERSION=22.23.4"],
      ExposedPorts: { "3000/tcp": {} },
    },
  };
  const norm = normalizeImageInspect(raw);
  assert.equal(norm.id, raw.Id);
  assert.equal(norm.shortId, "7f8c0570b555");
  assert.deepEqual(norm.repoTags, ["node:22-alpine"]);
  assert.equal(norm.architecture, "amd64");
  assert.equal(norm.os, "linux");
  assert.deepEqual(norm.config.exposedPorts, ["3000/tcp"]);

  const fixtureNorm = normalizeImageInspect(imagesRaw[0]);
  assert.ok(fixtureNorm.id || fixtureNorm.shortId);
});

test("normalizeVolumeInspect: normalizes volume inspect data", () => {
  const raw = volumesRaw[0];
  const norm = normalizeVolumeInspect(raw);
  assert.ok(norm.name);
  assert.ok(norm.driver);
  assert.ok(norm.mountpoint);
});

test("normalizeNetworkInspect: normalizes network inspect data", () => {
  const raw = {
    Id: "network1234567890abcdef",
    Name: "custom-net",
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    Attachable: true,
    Containers: {
      "c1-long-id": {
        Name: "/my-container",
        IPv4Address: "172.20.0.2/16",
      },
    },
    IPAM: {
      Driver: "default",
      Config: [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }],
    },
  };
  const norm = normalizeNetworkInspect(raw);
  assert.equal(norm.id, raw.Id);
  assert.equal(norm.shortId, "network12345");
  assert.equal(norm.name, "custom-net");
  assert.equal(norm.driver, "bridge");
  assert.equal(norm.internal, false);
  assert.equal(norm.containers.length, 1);
  assert.equal(norm.containers[0].name, "my-container");

  const fixtureNorm = normalizeNetworkInspect(networksRaw[0]);
  assert.ok(fixtureNorm.name);
});

// ============================================================================
// 8. Parsing Helpers and Utilities
// ============================================================================

test("parseComposeConfigJson: extracts project services and ports", () => {
  const stdout = JSON.stringify({
    name: "mockapp",
    services: {
      web: {
        image: "nginx:latest",
        ports: [{ published: "80", target: 80 }],
        depends_on: ["db"],
      },
      db: {
        image: "postgres:15",
      },
    },
  });

  const parsed = parseComposeConfigJson(stdout);
  assert.equal(parsed.projectName, "mockapp");
  assert.ok(parsed.services.web);
  assert.equal(parsed.services.web.image, "nginx:latest");
  assert.deepEqual(parsed.services.web.dependsOn, ["db"]);
  assert.ok(parsed.services.db);
});

test("parseSystemDf: parses system-df.ndjson fixture into typed records", () => {
  const df = parseSystemDf(systemDfRaw);
  assert.ok(df.images);
  assert.ok(df.containers);
  assert.ok(df.volumes);
  assert.ok(df.buildCache);
  assert.equal(df.images.totalCount > 0, true);
});

test("parseSystemDfVerbose: parses system-df-v.json fixture into structured records", () => {
  const dfV = parseSystemDfVerbose(systemDfVRaw);
  assert.ok(Array.isArray(dfV.topImages));
  assert.ok(Array.isArray(dfV.topVolumes));
  assert.ok(Array.isArray(dfV.topContainers));
  assert.ok(dfV.topImages.length > 0);
  assert.ok(dfV.topVolumes.length > 0);
});

test("parseDockerSizeBytes: parses B, kB, MB, GB, TB, and 0B accurately", () => {
  assert.equal(parseDockerSizeBytes("0B"), 0);
  assert.equal(parseDockerSizeBytes("0"), 0);
  assert.equal(parseDockerSizeBytes("500B"), 500);
  assert.equal(parseDockerSizeBytes("10kB"), 10000);
  assert.equal(parseDockerSizeBytes("10KiB"), 10240);
  assert.equal(parseDockerSizeBytes("2MB"), 2000000);
  assert.equal(parseDockerSizeBytes("2MiB"), 2097152);
  assert.equal(parseDockerSizeBytes("1.5GB"), 1500000000);
  assert.equal(parseDockerSizeBytes("1GiB"), 1073741824);
  assert.equal(parseDockerSizeBytes("1TB"), 1000000000000);
  assert.equal(parseDockerSizeBytes(12345), 12345);
});

test("resolveDockerMenuPosition: zooms and clamps inside the panel", () => {
  const zoomed = resolveDockerMenuPosition({
    localPosition: { x: 100, y: 100 },
    bounds: { x: 0, y: 0, width: 600, height: 600 },
    zoom: 2,
    menuWidth: 100,
    menuHeight: 100,
  });
  assert.equal(zoomed.x, 50);
  assert.equal(zoomed.y, 50);

  const edge = resolveDockerMenuPosition({
    localPosition: { x: 580, y: 580 },
    bounds: { x: 0, y: 0, width: 600, height: 600 },
    zoom: 1,
    menuWidth: 100,
    menuHeight: 100,
  });
  assert.ok(edge.x + 100 <= 592, `x ${edge.x} overflows the panel`);
  assert.ok(edge.y + 100 <= 592, `y ${edge.y} overflows the panel`);

  const leakedWindow = resolveDockerMenuPosition({
    event: { position: { x: 1400, y: 900 }, bounds: { x: 900, y: 100, width: 400, height: 400 } },
    zoom: 1,
    menuWidth: 100,
    menuHeight: 100,
  });
  assert.equal(leakedWindow.x, 120);
  assert.equal(leakedWindow.y, 120);
});

test("clampMenuPosition: clamps correctly to all four edges", () => {
  // Within bounds
  const posNormal = clampMenuPosition(100, 100, 200, 200, 500, 500);
  assert.equal(posNormal.x, 100);
  assert.equal(posNormal.y, 100);

  // Exceeds right edge
  const posRight = clampMenuPosition(450, 100, 200, 200, 500, 500);
  assert.ok(posRight.x + 200 <= 500);

  // Exceeds bottom edge
  const posBottom = clampMenuPosition(100, 450, 200, 200, 500, 500);
  assert.ok(posBottom.y + 200 <= 500);

  // Exceeds left/top edge (negative)
  const posTopLeft = clampMenuPosition(-20, -20, 200, 200, 500, 500);
  assert.ok(posTopLeft.x >= 8);
  assert.ok(posTopLeft.y >= 8);
});

test("findExistingActionTerminal: matches terminal in same space", () => {
  const terminals = [
    { name: "term1", title: "Docker logs: web", space: "sp1" },
    { name: "term2", title: "Docker logs: api", space: "sp2" },
  ];
  assert.equal(findExistingActionTerminal(terminals, "sp1", "Docker logs: web")?.name, "term1");
  assert.equal(findExistingActionTerminal(terminals, "sp2", "Docker logs: web"), null);
});

test("resolveServiceContainerId: resolves latest running container id", () => {
  const containers = [
    { id: "c_stopped", project: "myproj", service: "web", State: "exited" },
    { id: "c_running", project: "myproj", service: "web", State: "running" },
  ];
  const resolved = resolveServiceContainerId(containers, "myproj", "web", "fallback");
  assert.equal(resolved, "c_running");

  const fallback = resolveServiceContainerId([], "myproj", "web", "fallback");
  assert.equal(fallback, "fallback");
});

test("matchDockerRequestTarget: matches compose project or dockerfile", () => {
  const tree = [
    {
      kind: "project",
      name: "myproj",
      configFiles: ["/app/compose.yaml"],
      workingDirs: ["/app"],
      composeBasenames: "compose.yaml",
    },
    {
      kind: "dockerfile",
      filePath: "/app/Dockerfile",
      relativePath: "Dockerfile",
    },
  ];

  const composeMatch = matchDockerRequestTarget({ kind: "compose", file: "/app/compose.yaml" }, tree);
  assert.equal(composeMatch?.target?.name, "myproj");

  const dfMatch = matchDockerRequestTarget({ kind: "dockerfile", file: "/app/Dockerfile" }, tree);
  assert.equal(dfMatch?.target?.filePath, "/app/Dockerfile");
});

test("isAnonymousVolume: detects 64-character hex strings", () => {
  assert.equal(
    isAnonymousVolume("7f8c0570b555845cb06fa835a2d0eb274bfbfd107a61d1e4e2079bb48de16bc4"),
    true
  );
  assert.equal(isAnonymousVolume("my-named-volume"), false);
  assert.equal(isAnonymousVolume("short123"), false);
  assert.equal(isAnonymousVolume(""), false);
});

test("groupDiscoveredComposeFiles: groups primary and override files", () => {
  const files = [
    "/projects/app1/compose.yaml",
    "/projects/app1/compose.override.yaml",
    "/projects/app2/docker-compose.yml",
  ];
  const groups = groupDiscoveredComposeFiles(files);
  assert.equal(groups.length, 2);

  const app1 = groups.find((g) => g.folder === "/projects/app1");
  assert.ok(app1);
  assert.equal(app1.isOverride, true);
  assert.equal(app1.files.length, 2);

  const app2 = groups.find((g) => g.folder === "/projects/app2");
  assert.ok(app2);
  assert.equal(app2.isOverride, false);
  assert.equal(app2.files.length, 1);
});

test("normalizeContainerInspect: a never-finished container reports no finish time", async () => {
  const { normalizeContainerInspect } = await import("../mods/docker-manager/docker-logic.js");
  const running = normalizeContainerInspect({
    Id: "abc",
    State: { Status: "running", Running: true, StartedAt: "2026-11-09T15:03:08Z", FinishedAt: "0001-01-01T00:00:00Z" },
  });
  assert.equal(running.finishedAt, "");

  const stopped = normalizeContainerInspect({
    Id: "abc",
    State: { Status: "exited", Running: false, StartedAt: "2026-11-09T15:03:08Z", FinishedAt: "2026-11-09T16:00:00Z" },
  });
  assert.equal(stopped.finishedAt, "2026-11-09T16:00:00Z");
});
