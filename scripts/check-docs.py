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

docs = {p.as_posix(): p.read_text() for p in sorted(pathlib.Path('.').rglob('*.md'))
        if not {'.agents', '.claude', 'node_modules'} & set(p.parts)}
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

mig = sorted(set(re.findall(r'\b(00\d\d)_[a-z_]+\.sql', sch)))
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
    if f in VERSION_OWNERS:
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

print(f"decisions D-1..D-{max(defined['D'])} · invariants I-1..I-{max(defined['I'])} · open questions O-1..O-{max(defined['O'])}")
print(f"migrations {mig[0]}..{mig[-1]}")
print(f"{len(resolved)} cross-document references resolved\n")
for k, v in problems.items():
    print(f"[!] {k} ({len(v)})")
    for i in v[:15]: print(f"      {i}")
if not problems: print("[ok] no findings.\n")

if "-v" not in sys.argv:
    sys.exit(0)

print("=== every reference, with the title of the section it lands on ===")
for f, doc, sec, title in sorted(set(resolved)):
    print(f"  {f:28} -> {doc:18} §{sec:<5} {title}")
