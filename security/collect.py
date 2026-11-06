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


def pm2_apps():
    apps = []
    for pm2 in ("pm2",):
        try:
            out = sh("%s jlist" % pm2)
        except Exception:
            continue
        start = out.find("[")
        for p in json.loads(out[start:]):
            env = p.get("pm2_env", {})
            apps.append({"name": p.get("name"), "cwd": env.get("pm_cwd"),
                         "interpreter": env.get("exec_interpreter"), "status": env.get("status")})
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
print(json.dumps(inv))
