#!/usr/bin/env python3
"""Capture and sanitize the docker fixtures committed under test/fixtures/.

Why: the unit tests must run against payloads a real daemon produced, but this repository is
public, so no host identity and no secret may survive the capture.

    python3 test/fixtures/sanitize.py --capture     # re-capture from the local docker, then sanitize
    python3 test/fixtures/sanitize.py               # sanitize what is already here

Sanitizing is idempotent and ends with an assertion pass: if any home path, user name or
docker-hub namespace is still present, the script fails instead of leaving it in the repo.
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent
CAPTURES = {
    "containers.ndjson": ["container", "ls", "-a", "--no-trunc", "--format", "{{json .}}"],
    "compose-ls.json": ["compose", "ls", "--all", "--format", "json"],
    "images.ndjson": ["image", "ls", "-a", "--no-trunc", "--format", "{{json .}}"],
    "volumes.ndjson": ["volume", "ls", "--format", "{{json .}}"],
    "networks.ndjson": ["network", "ls", "--no-trunc", "--format", "{{json .}}"],
    "system-df.ndjson": ["system", "df", "--format", "{{json .}}"],
    "system-df-v.json": ["system", "df", "-v", "--format", "json"],
    "info.json": ["info", "--format", "{{json .}}"],
    "inspect-container.json": ["inspect", "cv-mapa-rustfs-1"],
}

# Everything that identifies the host, the person or their private projects. Each project keeps
# its own placeholder (/srv/<project>) so the fixtures still prove per-project grouping and the
# "this space" badge; collapsing every path into /srv/app destroyed the property under test.
PATH_MAPS = [
    (re.compile(r"/home/([A-Za-z0-9._-]+)"), r"/srv/\1"),
    (re.compile(r"/Users/([A-Za-z0-9._-]+)"), r"/srv/\1"),
    (re.compile(r"/root(?=/|$)"), "/srv/root"),
    # a personal Docker Hub namespace is identity too
    (re.compile(r"pswerlang/"), "example/"),
]


def capture():
    for name, argv in CAPTURES.items():
        out = subprocess.run(["docker", *argv], capture_output=True, text=True)
        if out.returncode != 0:
            print(f"capture failed for {name}: {out.stderr.strip()}", file=sys.stderr)
            continue
        (BASE / name).write_text(out.stdout)


def scrub_text(text: str) -> str:
    for pattern, repl in PATH_MAPS:
        text = pattern.sub(repl, text)
    return text


def scrub_json(node):
    if isinstance(node, dict):
        return {k: scrub_json(v) for k, v in node.items()}
    if isinstance(node, list):
        return [scrub_json(v) for v in node]
    if isinstance(node, str):
        return scrub_text(node)
    return node


def sanitize():
    for name in ("containers.ndjson", "images.ndjson", "volumes.ndjson", "networks.ndjson", "system-df.ndjson"):
        p = BASE / name
        if p.exists():
            p.write_text(scrub_text(p.read_text()))

    for name in ("compose-ls.json", "inspect-container.json", "info.json", "system-df-v.json"):
        p = BASE / name
        if not p.exists():
            continue
        data = scrub_json(json.loads(p.read_text()))

        if name == "inspect-container.json":
            entries = data if isinstance(data, list) else [data]
            for entry in entries:
                cfg = entry.get("Config") or {}
                if cfg.get("Env"):
                    # Keep the keys (the masking test needs them), drop every value.
                    cfg["Env"] = [str(e).split("=", 1)[0] + "=REDACTED" for e in cfg["Env"]]
                entry["Id"] = "0" * 64
                entry["Image"] = "sha256:" + "1" * 64
                entry["Hostname"] = "host"
                entry["Name"] = "/fixture-container"
                entry["LogPath"] = "/var/lib/docker/containers/fixture/fixture-json.log"
            data = entries if isinstance(data, list) else entries[0]

        if name == "info.json":
            data["ID"] = "00000000-0000-0000-0000-000000000000"
            data["Name"] = "host"
            data["Hostname"] = "host"
            data["ServerVersion"] = "29.5.3"
            for key in ("DockerRootDir", "SecurityOptions", "RegistryConfig", "Plugins", "Debug", "NFd", "NGoroutines"):
                data.pop(key, None)

        if name == "system-df-v.json":
            def size(value):
                raw = str(value.get("Size", "0") or "0").strip()
                m = re.match(r"^([0-9.]+)\s*([kMGT]?B?)$", raw)
                if not m:
                    return 0.0
                scale = {"": 1, "B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
                return float(m.group(1)) * scale.get(m.group(2), 1)

            data = {
                k: (sorted(v, key=size, reverse=True)[:5] if isinstance(v, list) else v)
                for k, v in data.items()
            }

        p.write_text(json.dumps(data, indent=2) + "\n")


def assert_clean():
    problems = []
    for p in sorted(BASE.glob("*")):
        if p.suffix not in {".json", ".ndjson"}:
            continue
        text = p.read_text()
        for needle in ("/home/", "/Users/", "pswerlang", "werlang/", "/root/"):
            if needle in text:
                problems.append(f"{p.name}: still contains {needle!r}")
        if p.name == "inspect-container.json" and "REDACTED" not in text:
            problems.append("inspect-container.json: environment values were not redacted")
    if problems:
        print("sanitize: refusing to leave identity in the fixtures:", file=sys.stderr)
        for line in problems:
            print(" -", line, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if "--capture" in sys.argv:
        capture()
    sanitize()
    assert_clean()
    print("fixtures sanitized and verified:", ", ".join(sorted(p.name for p in BASE.glob("*"))))
