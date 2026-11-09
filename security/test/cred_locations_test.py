# python3 -I security/test/cred_locations_test.py — the extractor reports locations/types/counts and never a value.
import os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
d = tempfile.mkdtemp(); f = os.path.join(d, "notes.md")
secrets = ["sk-ant-api03-ABCDEFGHIJKLMN", "sk-proj-ZZZZYYYYXXXX", "$P$Babcdefghijklmn", "sk-or-v1-fffff"]
open(f, "w").write("plain\nkeys %s and %s\nhash %s\ntruncated %s…\n" % tuple(secrets))
p = subprocess.run([sys.executable, "-I", os.path.join(HERE, "..", "cred-locations.py"), f, os.path.join(d, "missing")],
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
out = p.stdout + p.stderr
fails = []
def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name); cond or fails.append(name)
for s in secrets:
    check("never prints any part of %s…" % s[:6], s[6:10] not in out)
check("all four locations found", all(("notes.md:%d" % n) in out for n in (2, 3, 4)))
check("types named", all(t in out for t in ("anthropic-key", "openai-key", "phpass-hash", "openrouter-key")))
check("unreadable path is reported and exits 2", p.returncode == 2 and "UNREADABLE" in p.stderr)
sys.exit(1 if fails else 0)
