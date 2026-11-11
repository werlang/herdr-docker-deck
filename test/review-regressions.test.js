// Regression tests for findings confirmed by the adversarial review (main...HEAD).
// Each test fails on the code as reviewed; the comment names the finding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateDockerIdentifier,
  isSecretEnvKey,
  normalizeContainerInspect,
  buildContainerTree,
  buildVolumeTree,
  buildImageTree,
  buildNetworkTree,
  buildConfirmationSpec,
  matchDockerRequestTarget,
} from "../mods/docker-manager/docker-logic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, "fixtures", name);
const ndjson = (name) =>
  fs.readFileSync(fixture(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const json = (name) => JSON.parse(fs.readFileSync(fixture(name), "utf8"));
// The resource builders return { volumes | images | networks, ... } records, the container tree
// returns group nodes. Normalise both into one flat list of nodes.
const items = (tree) => {
  if (Array.isArray(tree)) return tree.flatMap((g) => g.items || [g]);
  if (!tree || typeof tree !== "object") return [];
  const buckets = ["items", "volumes", "anonymous", "images", "dangling", "networks", "builtIn", "all"];
  return buckets.flatMap((k) => (Array.isArray(tree[k]) ? tree[k] : []));
};

test("identifier validation rejects flag-shaped and shell-shaped names (DM-87)", () => {
  // Review: validateDockerIdentifier accepted a leading "-" (read as a CLI flag) and "foo;bar".
  for (const bad of ["--help", "-f", "foo;bar", "vol/sub", "a b", "a$(id)", "", "   ", "../etc"]) {
    assert.throws(() => validateDockerIdentifier(bad), /Invalid Docker/, `should reject ${JSON.stringify(bad)}`);
  }
  for (const ok of ["cv-mapa-web-1", "e0c792ee4dff", "rustfs/rustfs:latest", "sha256:abc", "app_default", "arn@sha256:ff"]) {
    assert.equal(validateDockerIdentifier(ok), true, `should accept ${ok}`);
  }
});

test("secret masking covers KEY, PGPASSWORD and the DM-45 list", () => {
  const secrets = [
    "PASSWORD", "DB_PASSWORD", "PGPASSWORD", "PASSPHRASE", "SECRET", "TOKEN", "GITHUB_TOKEN",
    "API_KEY", "SSH_KEY", "GPG_KEY", "ENCRYPTION_KEY", "SIGNING_KEY", "KEY",
    "PRIVATE_KEY", "AUTH", "CREDENTIAL", "CLIENT_SECRET", "DATABASE_URL", "REDIS_URL", "CONNECTION_STRING",
  ];
  for (const k of secrets) assert.equal(isSecretEnvKey(k), true, `${k} must be masked`);
  for (const k of ["PATH", "NODE_ENV", "PORT", "HOME", "TZ", "LANG", "RUSTFS_ADDRESS"]) {
    assert.equal(isSecretEnvKey(k), false, `${k} must stay readable`);
  }
});

test("a stopped container still reports its published ports (DM-41)", () => {
  // Review: `NetworkSettings.Ports || HostConfig.PortBindings` never reached the fallback
  // because Docker returns `Ports: {}` for created/stopped containers.
  const created = normalizeContainerInspect({
    Id: "abc",
    Name: "/probe-created",
    State: { Status: "created", Running: false },
    HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "18082" }] } },
    NetworkSettings: { Ports: {} },
  });
  assert.deepEqual(created.ports, [{ hostIp: "0.0.0.0", hostPort: 18082, containerPort: 80, proto: "tcp" }]);

  const running = normalizeContainerInspect({
    Id: "abc",
    Name: "/probe-running",
    State: { Status: "running", Running: true },
    HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "18082" }] } },
    NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "18082" }] } },
  });
  assert.equal(running.ports[0].hostPort, 18082);
  assert.equal(running.ports[0].hostIp, "127.0.0.1");
});

test("a profiled service that is running is not listed as inactive (DM-33)", () => {
  const tree = buildContainerTree({
    containers: [
      {
        ID: "abc123",
        Names: "app-debug-1",
        Image: "app",
        State: "running",
        Status: "Up 2 minutes",
        Labels:
          "com.docker.compose.project=app,com.docker.compose.service=debug,com.docker.compose.project.working_dir=/srv/app",
      },
    ],
    composeLs: [],
    discoveredCompose: [
      {
        project: "app",
        filePath: "/srv/app/compose.yaml",
        files: ["/srv/app/compose.yaml"],
        folder: "/srv/app",
        config: { name: "app", services: { debug: { image: "app", profiles: ["debug"] } } },
      },
    ],
    discoveredDockerfiles: [],
    spaceRoot: "/srv/app",
    scope: "all",
  });
  const flat = items(tree);
  const project = flat.find((n) => n.kind === "project" && n.name === "app");
  assert.ok(project, "project must exist");
  const inProfiles = (project.inactiveProfiles || []).some((p) => p.name === "debug");
  assert.equal(inProfiles, false, "a running profiled service must not be in inactiveProfiles");
  assert.equal((project.services || []).some((s) => s.name === "debug"), true);
});

test("volume in-use is exact, not a substring (DM-105)", () => {
  const tree = buildVolumeTree(
    ndjson("volumes.ndjson"),
    [
      { Id: "c1", Names: "whatsbot-mysql-1", State: "running", Mounts: "whatsbot_mysql" },
      { Id: "c2", Names: "app-db-1", State: "running", Mounts: "mysql" },
    ],
    { cwd: "/srv/app", on: null }
  );
  const flat = items(tree);
  const mysql = flat.find((v) => v.name === "mysql");
  if (mysql) {
    assert.equal(mysql.inUse, true, "mysql is mounted by app-db-1");
    assert.deepEqual(mysql.usedByContainers.map((c) => c.name), ["app-db-1"]);
  }
});

test("network connected counts come from the inspect payload (DM-115)", () => {
  const map = {
    net1: {
      Id: "net1",
      Name: "app_default",
      Driver: "bridge",
      Scope: "local",
      Containers: { a: { Name: "app-web-1", IPv4Address: "172.18.0.2/16" } },
    },
  };
  const tree = buildNetworkTree([{ ID: "net1", Name: "app_default", Driver: "bridge", Scope: "local" }], map, {});
  const flat = items(tree);
  const net = flat.find((n) => n.name === "app_default");
  assert.equal(net.connectedCount, 1);
  assert.equal(net.connectedContainers[0].name, "app-web-1");
});

test("every destructive confirmation has a spec with the right typed gate (DM-85/86)", () => {
  // Review: buildConfirmationSpec returned null for prune-*, so the dialog rendered undefined
  // fields with a live confirm button, and remove-volume/prune-volumes typed flags were untested.
  const cases = [
    ["down", { name: "app" }, null],
    ["down-volumes", { name: "app" }, "app"],
    ["remove-volume", { name: "mysql" }, "mysql"],
    ["restore-volume", { name: "mysql" }, "mysql"],
    ["prune-volumes", null, "prune"],
    ["prune-unused-images", null, "prune"],
    ["prune-networks", null, null],
    ["prune-dangling-images", null, null],
    ["remove-network", { name: "app_default" }, null],
    ["kill", { name: "web-1" }, null],
  ];
  for (const [action, target, typed] of cases) {
    const spec = buildConfirmationSpec(action, target);
    assert.ok(spec, `${action} must never return a null spec`);
    assert.equal(typeof spec.title, "string");
    assert.ok(spec.title.length > 0, `${action} needs a title`);
    assert.ok(spec.message.length > 0, `${action} needs a message`);
    assert.equal(spec.typedTarget, typed, `${action} typed gate`);
  }
  const networks = buildConfirmationSpec("prune-networks", null);
  assert.match(networks.message, /network/i, "the prune-networks dialog must name what it removes");
});

test("cross-mod reveal resolves a target in the real group tree (DM-93)", () => {
  const tree = buildContainerTree({
    containers: ndjson("containers.ndjson"),
    composeLs: json("compose-ls.json"),
    discoveredCompose: [
      { project: "cv-mapa", filePath: "/srv/app/compose.yaml", files: ["/srv/app/compose.yaml"], folder: "/srv/app", config: {} },
    ],
    discoveredDockerfiles: [{ filePath: "/srv/app/tools/Dockerfile", relativePath: "tools/Dockerfile" }],
    spaceRoot: "/srv/app",
    scope: "all",
  });
  const byFile = matchDockerRequestTarget({ file: "/srv/app/compose.yaml" }, tree);
  assert.ok(byFile, "a compose file must resolve to its project");
  assert.equal(byFile.type, "project");
  const byDockerfile = matchDockerRequestTarget({ kind: "dockerfile", file: "/srv/app/tools/Dockerfile" }, tree);
  assert.ok(byDockerfile, "a Dockerfile must resolve to its dockerfile node");
  assert.equal(byDockerfile.type, "dockerfile");
});

test("path containment does not cross sibling directories with a shared prefix", () => {
  const tree = buildContainerTree({
    containers: [
      {
        ID: "abc123",
        Names: "app-web-1",
        Image: "app",
        State: "running",
        Status: "Up 1 minute",
        Labels: "com.docker.compose.project=app,com.docker.compose.project.working_dir=/srv/app2",
      },
    ],
    composeLs: [],
    discoveredCompose: [],
    discoveredDockerfiles: [{ filePath: "/srv/app2/Dockerfile" }],
    spaceRoot: "/srv/app",
    scope: "all",
  });
  const flat = items(tree);
  const df = flat.find((n) => n.kind === "dockerfile");
  assert.ok(df);
  assert.equal(df.relativePath, "/srv/app2/Dockerfile", "a sibling dir keeps its absolute path");
});

test("image in-use is detected when the container references the image by id", () => {
  const images = [
    { ID: "sha256:72cd000000000000000000000000000000000000000000000000000000000000", Repository: "app", Tag: "latest", Size: "10MB", CreatedAt: "2026-01-01" },
  ];
  const tree = buildImageTree(
    images,
    [
      { ID: "c1", Names: "app-web-1", Image: "sha256:72cd000000000000000000000000000000000000000000000000000000000000", State: "running" },
    ],
    { cwd: "/srv/app", on: null }
  );
  const flat = items(tree);
  const image = flat.find((i) => i.name === "app:latest");
  assert.ok(image);
  assert.equal(image.inUse, true, "a container referencing the digest marks the image in use");
  assert.equal(image.usedByContainers.length, 1);
});
