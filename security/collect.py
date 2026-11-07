# Runs on a remote host (python3 -I - < collect.py) and prints one JSON inventory.
# Must stay Python 3.6 compatible: personal-server is AlmaLinux 8.
import json
import os
import re
import shutil
import subprocess

inv = {"errors": []}


def sh(cmd, timeout=120):
    p = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError("%s -> %d: %s" % (cmd, p.returncode, p.stderr.strip()[:300]))
    return p.stdout


def step(name, fn):
    try:
        fn()
    except Exception as e:
        inv["errors"].append("%s: %s" % (name, e))


def os_info():
    rel = {}
    for line in open("/etc/os-release"):
        if "=" in line:
            k, v = line.rstrip("\n").split("=", 1)
            rel[k] = v.strip('"')
    inv["os"] = {"id": rel.get("ID"), "version_id": rel.get("VERSION_ID"),
                 "pretty": rel.get("PRETTY_NAME"), "kernel": sh("uname -r").strip()}
    inv["reboot_required"] = os.path.exists("/var/run/reboot-required")


def debian_pkgs():
    # Third-party repos (nodesource, docker) reuse package names Debian also ships; OSV's
    # Debian advisories would match them falsely, so keep only packages apt says came from Debian.
    suites = {}
    for line in sh("apt list --installed 2>/dev/null").splitlines():
        m = re.match(r"^([^/]+)/(\S+)\s", line)
        if m:
            suites[m.group(1)] = m.group(2)
    src, foreign = {}, []
    for line in sh("dpkg-query -W -f '${Package}\\t${source:Package}\\t${source:Version}\\t${db:Status-Status}\\n'").splitlines():
        pkg, spkg, sver, status = line.split("\t")
        if status != "installed":
            continue
        parts = [p for p in suites.get(pkg, "").split(",") if p and p != "now"]
        if parts and not any(re.search(r"bookworm|stable|oldstable|trixie", p) for p in parts):
            suite = ",".join(parts)
            foreign.append("%s %s (%s)" % (pkg, sver, suite))
            continue
        src[spkg] = sver
    inv["os_pkgs"] = {"ecosystem": "Debian:" + inv["os"]["version_id"].split(".")[0],
                      "pkgs": sorted(src.items()), "foreign": foreign}


def rpm_pkgs():
    pkgs = {}
    for line in sh("rpm -qa --qf '%{NAME}\\t%{EPOCH}\\t%{VERSION}-%{RELEASE}\\n'").splitlines():
        name, epoch, vr = line.split("\t")
        pkgs[name] = vr if epoch in ("(none)", "0") else "%s:%s" % (epoch, vr)
    major = inv["os"]["version_id"].split(".")[0]
    eco = {"almalinux": "AlmaLinux", "rocky": "Rocky Linux"}.get(inv["os"]["id"], inv["os"]["id"])
    inv["os_pkgs"] = {"ecosystem": "%s:%s" % (eco, major), "pkgs": sorted(pkgs.items()), "foreign": []}
    streams = []
    for line in sh("dnf -C -q module list --enabled").splitlines():
        m = re.match(r"^(\w[\w-]*)\s+([^\s\[]+)\s+(?:\[\w\])*\[e\]", line)
        if m:
            streams.append("%s:%s" % m.groups())
    inv["module_streams"] = sorted(set(streams))


def pm2_daemons():
    """Every running pm2 God Daemon, whoever owns it: (user, pm2_home, node binary, pm2 script)."""
    out = []
    for line in sh("ps -eo pid=,user:64=,args=").splitlines():
        m = re.match(r"\s*(\d+)\s+(\S+)\s+PM2 v[\d.]+: God Daemon \((.+)\)$", line)
        if not m:
            continue
        pid, user, home = m.groups()
        # After a node upgrade under a running daemon the link reads "/usr/bin/node (deleted)"; the path holds the new binary.
        node = os.readlink("/proc/%s/exe" % pid)
        if node.endswith(" (deleted)"):
            node = node[:-len(" (deleted)")]
        script = None
        try:
            unit = sh("systemctl cat pm2-%s 2>/dev/null" % user)
            u = re.search(r"^ExecStart=(\S*pm2)\s", unit, re.M)
            script = u and u.group(1)
        except Exception:
            pass
        script = script or shutil.which("pm2")
        if not script:
            raise RuntimeError("pm2 daemon for %s at %s but no pm2 CLI found" % (user, home))
        out.append((user, home, node, os.path.realpath(script)))
    return out


def listeners():
    """TCP ports listening on a non-loopback address, with the owning process."""
    out = set()
    for line in sh("ss -Hltnp").splitlines():
        f = line.split()
        addr, port = f[3].rsplit(":", 1)
        if addr.startswith("127.") or addr in ("[::1]", "::1"):
            continue
        m = re.search(r'users:\(\("([^"]+)"', line)
        out.add((int(port), m.group(1) if m else ""))
    inv["listeners"] = sorted(out)
    addrs = []
    for line in sh("ip -o addr show scope global").splitlines():
        a = line.split()[3].split("/")[0]
        if not re.match(r"^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])", a):
            addrs.append(a)
    inv["public_addrs"] = addrs


def stale_processes():
    """Processes still running code that has been replaced on disk: patched, but not yet in effect."""
    stale = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            exe = os.readlink("/proc/%s/exe" % pid)
            with open("/proc/%s/maps" % pid) as f:
                libs = {l.split(None, 5)[5].strip() for l in f if l.rstrip().endswith("(deleted)") and ".so" in l}
            with open("/proc/%s/comm" % pid) as f:
                comm = f.read().strip()
        except (OSError, IndexError):
            continue  # process exited or kernel thread
        gone = sorted(([exe] if exe.endswith("(deleted)") else []) + [l for l in libs if not l.startswith("/memfd:")])
        if gone:
            stale.setdefault(comm, set()).update(gone)
    inv["stale"] = sorted([c, sorted(g)] for c, g in stale.items())


def pm2_apps():
    apps = []
    for user, home, node, script in pm2_daemons():
        out = sh("sudo -u %s env PM2_HOME=%s PATH=%s:/usr/bin:/bin %s %s jlist"
                 % (user, home, os.path.dirname(node), node, script))
        start = out.find("[")
        for p in json.loads(out[start:]):
            env = p.get("pm2_env", {})
            # The live process's binary is the truth: pm2 reports "none" for bun shebang scripts and a bare "node" whose PATH differs per user.
            interp = env.get("exec_interpreter")
            if p.get("pid"):
                try:
                    interp = os.readlink("/proc/%s/exe" % p["pid"]).replace(" (deleted)", "")
                except OSError:
                    pass  # exited between jlist and here; keep pm2's own value
            elif interp == "node":
                interp = node
            apps.append({"name": p.get("name"), "user": user, "cwd": env.get("pm_cwd"),
                         "interpreter": interp, "status": env.get("status")})
    inv["pm2"] = apps


def node_runtimes():
    paths = set()
    for cand in ["/usr/bin/node", "/usr/local/bin/node"]:
        if os.path.exists(cand):
            paths.add(os.path.realpath(cand))
    nvm = "/root/.nvm/versions/node"
    if os.path.isdir(nvm):
        for v in os.listdir(nvm):
            b = os.path.join(nvm, v, "bin/node")
            if os.path.exists(b):
                paths.add(os.path.realpath(b))
    for app in inv.get("pm2", []):
        i = app.get("interpreter")
        if i and not i.startswith("/"):
            i = shutil.which(i, path=os.environ.get("PATH", "") + ":/root/.bun/bin:/usr/local/bin")
        if i and os.path.exists(i):
            app["interpreter"] = os.path.realpath(i)
            paths.add(app["interpreter"])
    out = []
    for b in sorted(paths):
        ver = sh("%s -v" % b).strip().lstrip("v")
        owner = None
        try:
            owner = sh("dpkg -S %s 2>/dev/null || rpm -qf %s" % (b, b)).strip()
        except Exception:
            pass
        out.append({"path": b, "runtime": "bun" if os.path.basename(b) == "bun" else "node", "version": ver, "package_owner": owner,
                    "used_by": [a["name"] for a in inv.get("pm2", []) if a.get("interpreter") == b]})
    inv["node"] = out


def read_pkg(d):
    try:
        with open(os.path.join(d, "package.json")) as f:
            j = json.load(f)
        return j.get("name"), j.get("version")
    except Exception:
        return None, None


def walk_node_modules(nm, found, depth=0):
    if depth > 12 or not os.path.isdir(nm):
        return
    for e in os.listdir(nm):
        if e.startswith("."):
            continue
        p = os.path.join(nm, e)
        subs = [os.path.join(p, s) for s in os.listdir(p)] if e.startswith("@") and os.path.isdir(p) else [p]
        for d in subs:
            name, ver = read_pkg(d)
            if name and ver:
                found.add((name, ver))
            walk_node_modules(os.path.join(d, "node_modules"), found, depth + 1)


def npm_apps():
    dirs = {}
    for a in inv.get("pm2", []):
        cwd = a.get("cwd")
        if not cwd:
            continue
        # pm2 cwd may be a subdir (e.g. backend/); walk up to the nearest node_modules root.
        d = cwd
        while d not in ("/", "") and not os.path.isdir(os.path.join(d, "node_modules")):
            d = os.path.dirname(d)
        if d not in ("/", ""):
            dirs[d] = a["name"]
    for g in ("/usr/lib/node_modules", "/usr/local/lib/node_modules"):
        if os.path.isdir(g):
            dirs[g + "/.."] = "global npm"
    apps = []
    for d, name in sorted(dirs.items()):
        found = set()
        nm = os.path.join(d, "node_modules") if not d.endswith("/..") else d[:-3]
        walk_node_modules(nm, found)
        apps.append({"app": name, "dir": os.path.normpath(d), "pkgs": sorted(found)})
    inv["npm"] = apps


def wordpress():
    sites = []
    out = sh("find /var/www -maxdepth 3 -name wp-config.php 2>/dev/null || true")
    for cfg in sorted(out.split()):
        path = os.path.dirname(cfg)
        wp = "sudo -u www-data wp --path=%s --skip-plugins --skip-themes " % path
        site = {"path": path}
        try:
            site["url"] = sh(wp + "option get siteurl").strip()
            site["core"] = sh(wp + "core version").strip()
            site["plugins"] = [[p["name"], p["version"], p["status"]] for p in json.loads(sh(wp + "plugin list --format=json"))]
            site["themes"] = [[t["name"], t["version"], t["status"]] for t in json.loads(sh(wp + "theme list --format=json"))]
        except Exception as e:
            inv["errors"].append("wordpress %s: %s" % (path, e))
        sites.append(site)
    inv["wordpress"] = sites


def containers():
    try:
        out = sh("docker ps --format '{{.Names}}\\t{{.Image}}' 2>/dev/null")
    except Exception:
        inv["containers"] = []
        return
    inv["containers"] = [l.split("\t") for l in out.splitlines() if l]


step("os", os_info)
if os.path.exists("/usr/bin/dpkg-query"):
    step("debian packages", debian_pkgs)
elif os.path.exists("/usr/bin/rpm"):
    step("rpm packages", rpm_pkgs)
else:
    inv["errors"].append("os packages: no dpkg or rpm")
step("pm2", pm2_apps)
step("node", node_runtimes)
step("npm", npm_apps)
step("wordpress", wordpress)
step("containers", containers)
step("stale processes", stale_processes)
step("listeners", listeners)
print(json.dumps(inv))
