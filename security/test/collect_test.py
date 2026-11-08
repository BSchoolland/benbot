# python3 -I security/test/collect_test.py — collector failure handling. Runs collect.py's steps against fake
# binaries on PATH so a broken tool must show up as a named error, never as an empty inventory.
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECT = os.path.join(HERE, "..", "collect.py")
failures = []


def check(name, cond, detail=""):
    print("%s %s%s" % ("ok  " if cond else "FAIL", name, "" if cond else ": " + detail))
    if not cond:
        failures.append(name)


def fakebin(scripts):
    d = tempfile.mkdtemp()
    for name, body in scripts.items():
        p = os.path.join(d, name)
        with open(p, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    return d


def load(path_prefix):
    os.environ["PATH"] = path_prefix + ":" + os.environ["PATH"]
    spec = importlib.util.spec_from_file_location("collect", COLLECT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


orig_path = os.environ["PATH"]

# 1. ss broken: listeners step records the error and leaves no listener list behind.
m = load(fakebin({"ss": "echo 'ss: netlink failure' >&2; exit 2"}))
m.step("listeners", m.listeners)
check("broken ss is a named listeners error", any(e.startswith("listeners:") and "netlink" in e for e in m.inv["errors"]), str(m.inv["errors"]))
check("broken ss leaves no listeners key (not an empty list)", "listeners" not in m.inv, str(m.inv.get("listeners")))
os.environ["PATH"] = orig_path

# 2. docker installed but daemon down: containers step errors instead of reporting zero containers.
m = load(fakebin({"docker": "echo 'Cannot connect to the Docker daemon' >&2; exit 1"}))
m.step("containers", m.containers)
check("dead docker daemon is a named containers error", any(e.startswith("containers:") for e in m.inv["errors"]), str(m.inv["errors"]))
check("dead docker daemon leaves no containers key", "containers" not in m.inv, str(m.inv.get("containers")))
os.environ["PATH"] = orig_path

# 3. docker absent: that is a fact, not an error.
m = load(fakebin({}))
os.environ["PATH"] = fakebin({}) + ":/usr/bin/nonexistent"
m.step("containers", m.containers)
check("no docker binary means containers == []", m.inv.get("containers") == [] and not m.inv["errors"], "%s %s" % (m.inv.get("containers"), m.inv["errors"]))
os.environ["PATH"] = orig_path

# 4. dnf failing on an RPM host: module streams error out rather than reading as "no streams enabled".
rpm_fake = """case "$*" in
  *kernel*) printf '(none)\\t4.18.0-553.el8_10' ;;
  *) printf 'redis\\t(none)\\t5.0.3-5.module_el8.4.0+2583+b9845322\\nkernel\\t(none)\\t4.18.0-999.el8_10\\n' ;;
esac"""
m = load(fakebin({"rpm": rpm_fake, "dnf": "echo 'Cache-only enabled but no cache' >&2; exit 1", "uname": "echo 4.18.0-553.el8_10.x86_64"}))
m.inv["os"] = {"id": "almalinux", "version_id": "8.10"}
m.step("rpm packages", m.rpm_pkgs)
check("dnf failure is a named rpm packages error", any(e.startswith("rpm packages:") and "dnf" in e for e in m.inv["errors"]), str(m.inv["errors"]))
check("dnf failure leaves module_streams unset (matcher then keeps fixes)", "module_streams" not in m.inv, str(m.inv.get("module_streams")))
check("rpm: the running kernel's version replaces the newest installed one", dict(m.inv["os_pkgs"]["pkgs"]).get("kernel") == "4.18.0-553.el8_10", str(m.inv.get("os_pkgs")))
os.environ["PATH"] = orig_path

# 5. A malformed package.json is counted, not silently dropped; a missing one is just not a package.
d = tempfile.mkdtemp()
os.makedirs(os.path.join(d, "node_modules", "good")); os.makedirs(os.path.join(d, "node_modules", "bad")); os.makedirs(os.path.join(d, "node_modules", ".bin"))
json.dump({"name": "good", "version": "1.0.0"}, open(os.path.join(d, "node_modules", "good", "package.json"), "w"))
open(os.path.join(d, "node_modules", "bad", "package.json"), "w").write("{not json")
m = load(fakebin({}))
found = set()
m.walk_node_modules(os.path.join(d, "node_modules"), found)
check("good package found", ("good", "1.0.0") in found, str(found))
check("malformed package.json recorded", len(m.BAD_PKG_JSON) == 1 and "bad/package.json" in m.BAD_PKG_JSON[0], str(m.BAD_PKG_JSON))
os.environ["PATH"] = orig_path

# 6. Debian kernel: the running signed image maps to source "linux"; an unresolvable running kernel is an error.
dq = """case "$*" in
  *source:Package*) printf 'linux-image-6.1.0-54-cloud-amd64\\tlinux-signed-amd64\\t6.1.190+1\\tinstalled\\nbash\\tbash\\t5.2.15-2+b7\\tinstalled\\n' ;;
  *linux-image-6.1.0-54-cloud-amd64*) printf '%s' "$KVER" ;;
esac"""
fb = fakebin({"apt": "printf 'linux-image-6.1.0-54-cloud-amd64/stable-security,now 6.1.190-1 amd64 [installed]\\nbash/stable,now 5.2.15-2+b7 amd64\\n'", "dpkg-query": dq, "uname": "echo 6.1.0-54-cloud-amd64"})
os.environ["KVER"] = "6.1.190-1"
m = load(fb); m.inv["os"] = {"id": "debian", "version_id": "12"}
m.step("debian packages", m.debian_pkgs)
pk = dict(m.inv.get("os_pkgs", {}).get("pkgs", []))
check("signed kernel image matched as source linux at the running version", pk.get("linux") == "6.1.190-1", str(pk))
os.environ["PATH"] = orig_path
os.environ["KVER"] = ""
m = load(fb); m.inv["os"] = {"id": "debian", "version_id": "12"}
m.step("debian packages", m.debian_pkgs)
check("unresolvable running kernel is a named error", any(e.startswith("debian packages:") and "running kernel" in e for e in m.inv["errors"]), str(m.inv["errors"]))
check("unresolvable running kernel leaves no os_pkgs", "os_pkgs" not in m.inv)
os.environ["PATH"] = orig_path

# 7. The whole collector still prints valid JSON with an errors list when a tool is broken.
env = dict(os.environ, PATH=fakebin({"ss": "exit 2"}) + ":" + orig_path)
out = subprocess.run([sys.executable, "-I", COLLECT], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, universal_newlines=True, timeout=600)
inv = json.loads(out.stdout)
check("end-to-end: broken ss shows in errors", any(e.startswith("listeners:") for e in inv["errors"]), str(inv["errors"])[:300])

sys.exit(1 if failures else 0)
