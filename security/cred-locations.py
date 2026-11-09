#!/usr/bin/env python3
# Credential-location extractor for notes, logs and transcripts (python3 -I security/cred-locations.py <paths...>).
# Prints only where credential-shaped values sit: file, line number, type and count. Never the value, a prefix of it,
# or the surrounding line. Directories are walked recursively. Exit 0 = scanned everything; 2 = a path was unreadable
# (reported, scan continued).
import os
import re
import sys

TYPES = [
    ("anthropic-key", re.compile(r"sk-ant-[A-Za-z0-9_-]{4,}")),
    ("openai-key", re.compile(r"sk-proj-[A-Za-z0-9_-]{4,}")),
    ("openrouter-key", re.compile(r"sk-or-v1-[A-Za-z0-9]{4,}")),
    ("other-sk-key", re.compile(r"\bsk-(?!ant-|proj-|or-v1-)[A-Za-z0-9]{16,}")),
    ("github-token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("phpass-hash", re.compile(r"\$P\$[./A-Za-z0-9]{8,}")),
    ("wp-bcrypt-hash", re.compile(r"\$wp\$2[aby]\$|\$2[aby]\$\d\d\$[./A-Za-z0-9]{20,}")),
    ("argon-hash", re.compile(r"\$argon2(id|i|d)\$")),
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
]


def scan_file(path, out):
    with open(path, "rb") as f:
        for n, raw in enumerate(f, 1):
            line = raw.decode("utf-8", "replace")
            for name, rx in TYPES:
                k = len(rx.findall(line))
                if k:
                    out.append((path, n, name, k))


def main(paths):
    hits, unreadable, files = [], [], 0
    for p in paths:
        targets = []
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                targets.extend(os.path.join(root, x) for x in sorted(names))
        else:
            targets.append(p)
        for t in targets:
            try:
                scan_file(t, hits)
                files += 1
            except OSError as e:
                unreadable.append("%s (%s)" % (t, e.strerror))
    for path, n, name, k in hits:
        print("%s:%d\t%s\tx%d" % (path, n, name, k))
    by = {}
    for _, _, name, k in hits:
        by[name] = by.get(name, 0) + k
    print("# scanned %d files; %d hits; by type: %s" % (files, len(hits), ", ".join("%s=%d" % kv for kv in sorted(by.items())) or "none"))
    for u in unreadable:
        print("# UNREADABLE %s" % u, file=sys.stderr)
    return 2 if unreadable else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: cred-locations.py <file-or-dir>...")
    sys.exit(main(sys.argv[1:]))
