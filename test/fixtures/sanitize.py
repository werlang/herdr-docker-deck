#!/usr/bin/env python3
"""Sanitize docker fixtures before committing them: no secrets, no host identity."""
import json, re, pathlib

base = pathlib.Path(__file__).resolve().parent

# inspect: keep keys, redact every value
p = base / "inspect-container.json"
data = json.loads(p.read_text())
for entry in data:
    cfg = entry.get("Config") or {}
    if cfg.get("Env"):
        cfg["Env"] = [e.split("=", 1)[0] + "=REDACTED" for e in cfg["Env"]]
    entry["Id"] = "0" * 64
    entry["Hostname"] = "host"
    entry["Name"] = "/fixture-container"
    entry["Image"] = "sha256:" + "1" * 64
    entry["LogPath"] = "/var/lib/docker/containers/fixture/fixture-json.log"
    if entry.get("NetworkSettings"):
        for net in entry["NetworkSettings"].get("Networks", {}).values():
            net["IPAddress"] = "172.18.0.2"
            net["Gateway"] = "172.18.0.1"
            net["MacAddress"] = "02:42:ac:12:00:02"
            net["NetworkID"] = "2" * 64
            net["Aliases"] = ["fixture-container"]
p.write_text(json.dumps(data, indent=2) + "\n")

# info: keep the numbers the mod renders, drop identity
p = base / "info.json"
info = json.loads(p.read_text())
keep_identity = {"ID": "00000000-0000-0000-0000-000000000000", "Name": "host", "Hostname": "host"}
for k in ("Name", "ID", "Hostname"):
    if k in info:
        info[k] = keep_identity.get(k, "host")
for k in ("DockerRootDir", "SecurityOptions", "RegistryConfig", "Plugins", "Debug", "NFd", "NGoroutines"):
    info.pop(k, None)
if isinstance(info.get("ServerVersion"), str):
    info["ServerVersion"] = "29.5.3"
p.write_text(json.dumps(info, indent=2) + "\n")

# verbose df: keep the five largest rows per group
p = base / "system-df-v.json"
df = json.loads(p.read_text())
def top(rows, n=5):
    def size(v):
        raw = str(v.get("Size", "0") or "0").strip()
        m = re.match(r"^([0-9.]+)\s*([kMGT]?B?)$", raw)
        if not m:
            return 0.0
        mult = {"": 1, "B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}[m.group(2)] if m.group(2) in {"", "B", "kB", "KB", "MB", "GB", "TB"} else 1
        return float(m.group(1)) * mult
    return sorted(rows or [], key=size, reverse=True)[:n]
trimmed = {k: (top(v) if isinstance(v, list) else v) for k, v in df.items()}
p.write_text(json.dumps(trimmed, indent=2) + "\n")

# ndjson fixtures: drop absolute host paths from labels/names
for name in ("containers.ndjson", "images.ndjson", "volumes.ndjson", "networks.ndjson"):
    p = base / name
    out = []
    for line in p.read_text().splitlines():
        line = re.sub(r"/home/[a-z0-9._-]+", "/srv/app", line)
        line = re.sub(r"/root/[a-z0-9._-]+", "/srv/app", line)
        out.append(line)
    p.write_text("\n".join(out) + "\n")

print("sanitized", ", ".join(sorted(f.name for f in base.glob("*"))))
