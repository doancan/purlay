#!/usr/bin/env python3
"""
Every cross-document reference in this repository must resolve, and must resolve
to the section it claims. Run in CI.

This is not speculative tooling: its first run found a reference that pointed at
a valid section with the wrong meaning, which no link checker would have caught.
`docs/OVERVIEW.md` makes the ownership rule normative; this makes it enforceable.
(D-47)
"""
import json, re, pathlib, collections, sys

# A person's own tooling lives in directories no clone has and no commit carries (`.git/info/exclude`
# names them on one machine). Reading them would fail the check here for a file CI never sees.
PERSONAL = {'.agents', '.claude', '.superpowers', '.superdesign', '.swarm'}
docs = {p.as_posix(): p.read_text() for p in sorted(pathlib.Path('.').rglob('*.md'))
        if not (PERSONAL | {'node_modules'}) & set(p.parts)}
problems = collections.defaultdict(list)

# ---- build a title index per document, covering all three heading styles ----
def titles(s):
    t = {}
    for m in re.finditer(r'^#{2,4}\s+(\d+(?:\.\d+)?)\.?\s+(.+)$', s, re.M):      # ## 7.3. Foo
        t[m.group(1)] = m.group(2).strip()
    for m in re.finditer(r'^\*\*(\d+\.\d+[a-z]?)\s*·\s*(.+?)\*\*', s, re.M):     # **4.2 · Foo**
        t[m.group(1)] = m.group(2).strip()
    for m in re.finditer(r'^###\s+(\d+\.\d+)\.\s+`?([^`\n]+)', s, re.M):
        t.setdefault(m.group(1), m.group(2).strip())
    # numbered list items inside a "## N. Title" section  ->  §N.item
    for sec in re.finditer(r'^##\s+(\d+)\.\s+.+?$(.*?)(?=^##\s|\Z)', s, re.M | re.S):
        n, body = sec.group(1), sec.group(2)
        for li in re.finditer(r'^(\d+)\.\s+\*\*(.+?)\*\*', body, re.M):
            t.setdefault(f"{n}.{li.group(1)}", li.group(2).strip().rstrip('.'))
        t.setdefault(n, '')
    for k in list(t):
        t.setdefault(k.split('.')[0], '')
    return t

TITLES = {f: titles(s) for f, s in docs.items()}
alias = {n.split('/')[-1]: n for n in docs}

# ---- every cross-document section reference, with the title it lands on -----
pat = re.compile(r'`?([A-Za-z]+\.md)`?\s+§+\s*(\d+(?:\.\d+)?)')
resolved = []
for f, s in docs.items():
    for doc, sec in pat.findall(s):
        tgt = alias.get(doc)
        if not tgt: continue
        if sec not in TITLES[tgt]:
            problems['var olmayan bölüme gönderme'].append(f"{f} -> {doc} §{sec}")
        else:
            resolved.append((f, doc, sec, TITLES[tgt][sec]))

# ---- identifier existence --------------------------------------------------
dec, sch = docs['docs/DECISIONS.md'], docs['docs/SCHEMA.md']
defined = {
 'D': {int(m) for m in re.findall(r'^### D-(\d+)\.', dec, re.M)},
 'I': {int(m) for m in re.findall(r'^\| I-(\d+) \|', sch, re.M)},
 'O': {int(m) for m in re.findall(r'\*\*O-(\d+)\s*·', dec)},
}
# Numbering is contiguous: a gap is a decision or invariant that was renumbered,
# deleted, or never written, and every citation of the missing number is a lie.
for kind in ('D', 'I'):
    known = defined[kind]
    missing = sorted(set(range(1, max(known) + 1)) - known) if known else []
    if missing:
        problems[f'{kind}-numbering has a gap'].append(', '.join(f'{kind}-{n}' for n in missing))

for f, s in docs.items():
    for kind, known in defined.items():
        for n in {int(m) for m in re.findall(rf'\b{kind}-(\d+)\b', s)}:
            if n not in known:
                problems[f'tanımsız {kind}-referansı'].append(f"{f}: {kind}-{n}")

# ---- links, migrations, SSOT, tool names -----------------------------------
for f, s in docs.items():
    base = pathlib.Path(f).parent
    for text, tgt in re.findall(r'\[([^\]]+)\]\(([^)#\s]+)\)', s):
        if not tgt.startswith(('http', 'mailto')) and not (base / tgt).exists():
            problems['kırık link'].append(f"{f}: [{text}]({tgt})")

# The migrations that exist are the files, not what a document says about them —
# reading the list from SCHEMA.md compared the document to itself.
applied = sorted(p.name for p in pathlib.Path('packages/db/migrations').glob('*.sql'))
planned = sorted(set(re.findall(r'\b(00\d\d_[a-z_]+\.sql)', sch)))
for name in applied:
    # Listed as an entry of §12's list — a line of its own — not merely mentioned
    # somewhere in prose, which would pass for a file the list forgot.
    if not re.search(rf'^{re.escape(name)}\b', sch, re.M):
        problems['migration missing from SCHEMA.md §12'].append(name)
for name in planned:
    number = name[:4]
    real = [a for a in applied if a.startswith(number + '_')]
    if real and real[0] != name:
        problems['SCHEMA.md names a migration that is not the file'].append(f"{name} -> {real[0]}")
mig = sorted({n[:4] for n in applied} | {n[:4] for n in planned})
for f, s in docs.items():
    for m in re.findall(r'migrations?\s+`?(00\d\d)`?', s):
        if m not in mig:
            problems['bilinmeyen migration'].append(f"{f}: {m}")

for needle, owner in {'26214400': 'docs/SCHEMA.md', '5368709120': 'docs/SCHEMA.md'}.items():
    homes = [f for f, s in docs.items() if needle in s]
    if homes != [owner]:
        problems['SSOT ihlali'].append(f"{needle}: {homes}")

for f, s in docs.items():
    for i, line in enumerate(s.split('\n'), 1):
        if re.search(r'\b(CLAUDE|Claude|Copilot|Windsurf)\b', line):
            problems['araç referansı'].append(f"{f}:{i}: {line.strip()[:70]}")

# ---- 9. single-owner facts: a version lives in exactly one place ------------
# ARCHITECTURE.md §2 is the stack table and DECISIONS.md D-20 records why. Every
# other document names the technology without a version, so there is nothing to
# fall out of date. This is the check that would have caught four stale
# "PostgreSQL 16" references an upgrade left behind.
# ARCHITECTURE.md used to be an owner. It is not one any more: a version is a
# fact and its home is the manifest that installs it, so §2 names choices and
# never numbers (D-56). DECISIONS.md keeps the exemption because it records dated
# history — "the documents said PostgreSQL 16" has to stay sayable.
VERSION_OWNERS = {"docs/DECISIONS.md", "docs/changelog/changes.md"}
# A spike record exists to say which versions were actually resolved on a
# given day. Naming them is its entire job, so the whole directory is an
# owner — the same reasoning as the changelog. (D-57)
VERSION_OWNER_PREFIXES = ("docs/spikes/",)
TECHNOLOGIES = ["PostgreSQL", "Bun", "React", "Vite", "Tailwind", "Kysely",
                "TypeBox", "ElysiaJS", "Elysia", "TypeScript", "ESLint", "Prettier",
                "Zustand", "Turborepo"]
version_re = re.compile(r"\b(" + "|".join(TECHNOLOGIES) + r")\s+v?(\d+(?:\.\d+)*)")
# A section whose whole purpose is recording what changed may name both versions.
HISTORICAL = re.compile(r"^#+.*(Corrections against earlier drafts|Cut from the previous)",
                        re.M | re.I)

def historical_spans(body: str) -> list[tuple[int, int]]:
    spans = []
    for m in HISTORICAL.finditer(body):
        nxt = re.compile(r"^#{1,3} ", re.M).search(body, m.end())
        spans.append((m.start(), nxt.start() if nxt else len(body)))
    return spans

for f, body in docs.items():
    if f in VERSION_OWNERS or f.startswith(VERSION_OWNER_PREFIXES):
        continue
    skip = historical_spans(body)
    for m in version_re.finditer(body):
        if any(a <= m.start() < b for a, b in skip):
            continue
        line = body[:m.start()].count("\n") + 1
        problems["version stated outside its owner"].append(
            f"{f}:{line}: {m.group(0)} — a version lives in the manifest that installs it, not in a document; name the technology only (D-56)")

# ---- 10. counts claimed in prose match the counts that exist ----------------
count_re = re.compile(r"(\d+)\s+decisions\b")
real = len(defined["D"])
for f, body in docs.items():
    if f == "docs/changelog/changes.md":
        continue  # historical entries record what was true on their date
    for m in count_re.finditer(body):
        if int(m.group(1)) != real:
            line = body[:m.start()].count("\n") + 1
            problems["decision count is wrong"].append(
                f"{f}:{line}: claims {m.group(1)}, there are {real}")

# ---- 11. every decision is cited by something other than the record itself --
# A decision nothing points at was either never propagated or is dead.
for n in sorted(defined["D"]):
    # The changelog mentions every decision by construction, so it cannot count
    # as propagation — that would make this check pass for a decision nothing acts on.
    cited = any(re.search(rf"\bD-{n}\b", body) for f, body in docs.items()
                if f not in {"docs/DECISIONS.md", "docs/changelog/changes.md"})
    if not cited:
        problems["decision never cited outside DECISIONS.md"].append(f"D-{n}")

# ---- 12. section numbering is locked to its meaning -------------------------
# A reference names a number. When the text at that number changes, every
# reference to it becomes quietly wrong while still resolving — which is a check
# reporting success for the wrong reason, the failure this guards against
# everywhere else. So the numbers and their titles are committed, and a change
# has to be acknowledged rather than noticed later.
LOCK = pathlib.Path("docs/sections.lock.json")
current = {f: {n: t for n, t in sorted(TITLES[f].items()) if t}
           for f in sorted(docs) if f != "docs/changelog/changes.md"}

if "--write-sections" in sys.argv:
    LOCK.write_text(json.dumps(current, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {LOCK} — {sum(len(v) for v in current.values())} sections")
    sys.exit(0)

if not LOCK.exists():
    problems["section lock is missing"].append(
        "run: python3 scripts/check-docs.py --write-sections")
else:
    locked = json.loads(LOCK.read_text())
    for f, sections in current.items():
        was = locked.get(f, {})
        for number, title in sections.items():
            before = was.get(number)
            if before is not None and before != title:
                pointing = sorted({src for src, doc, sec, _ in resolved
                                   if alias.get(doc) == f and sec == number})
                where = f" — referenced by {', '.join(pointing)}" if pointing else ""
                problems["a section number changed meaning"].append(
                    f"{f} §{number}: was {before!r}, now {title!r}{where}")
        for number, title in was.items():
            if number not in sections:
                problems["a section number disappeared"].append(f"{f} §{number} ({title})")

# ---- a merge left markers behind, or the decisions are out of order -----------
# #268 reached main with an unresolved conflict in two documents, and every gate
# was green: nothing in this repository read for the markers, and the numbering
# check counts decisions without looking at where they sit. Both are cheap to see.
_skip = {'.git', 'node_modules', '.tsbuild', 'dist', 'coverage'} | PERSONAL
_binary = {'.png', '.jpg', '.gif', '.ico', '.woff', '.woff2', '.lock'}
_marker = re.compile(r'^(<{7}|>{7})( |$)|^={7}$', re.M)
_scanned = 0
for _p in sorted(pathlib.Path('.').rglob('*')):
    if _skip & set(_p.parts) or not _p.is_file() or _p.suffix in _binary:
        continue
    try:
        _text = _p.read_text()
    except UnicodeDecodeError:
        continue
    _scanned += 1
    for _m in _marker.finditer(_text):
        problems['unresolved merge conflict marker'].append(f"{_p.as_posix()}:{_text.count(chr(10), 0, _m.start()) + 1}")
        break
# A scan that read nothing found nothing for the wrong reason (CONTRIBUTING §6.4).
if _scanned < 50:
    problems['the marker scan read almost nothing'].append(f"{_scanned} files")

_order = [int(n) for n in re.findall(r'^### D-(\d+)\. ', docs.get('docs/DECISIONS.md', ''), re.M)]
for _a, _b in zip(_order, _order[1:]):
    if _b < _a:
        problems['decisions are out of order'].append(f"D-{_b} comes after D-{_a}")

print(f"decisions D-1..D-{max(defined['D'])} · invariants I-1..I-{max(defined['I'])} · open questions O-1..O-{max(defined['O'])}")
print(f"migrations {mig[0]}..{mig[-1]}")
print(f"{len(resolved)} cross-document references resolved\n")
for k, v in problems.items():
    print(f"[!] {k} ({len(v)})")
    for i in v[:15]: print(f"      {i}")
if not problems: print("[ok] no findings.\n")

# The exit status is the check. Printing problems and exiting 0 is how this
# script guarded nothing for its whole life before #193.
status = 1 if problems else 0
if "-v" not in sys.argv:
    sys.exit(status)

print("=== every reference, with the title of the section it lands on ===")
for f, doc, sec, title in sorted(set(resolved)):
    print(f"  {f:28} -> {doc:18} §{sec:<5} {title}")
sys.exit(status)
