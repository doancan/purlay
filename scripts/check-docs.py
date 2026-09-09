#!/usr/bin/env python3
"""
Every cross-document reference in this repository must resolve, and must resolve
to the section it claims. Run in CI.

This is not speculative tooling: its first run found a reference that pointed at
a valid section with the wrong meaning, which no link checker would have caught.
`docs/OVERVIEW.md` makes the ownership rule normative; this makes it enforceable.
(D-47)
"""
import re, pathlib, collections, sys

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

print(f"karar D-1..D-{max(defined['D'])} · invariant I-1..I-{max(defined['I'])} · açık soru O-1..O-{max(defined['O'])}")
print(f"migration: {mig[0]}..{mig[-1]}")
print(f"çözümlenen çapraz gönderme: {len(resolved)}\n")
for k, v in problems.items():
    print(f"[!] {k} ({len(v)})")
    for i in v[:15]: print(f"      {i}")
if not problems: print("[ok] no findings.\n")

if "-v" not in sys.argv:
    sys.exit(0)

print("=== every reference, with the title of the section it lands on ===")
for f, doc, sec, title in sorted(set(resolved)):
    print(f"  {f:28} -> {doc:18} §{sec:<5} {title}")
