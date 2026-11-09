#!/usr/bin/env python3
"""
Every cross-document reference in this repository must resolve, and must resolve
to the section it claims. Run in CI.

This is not speculative tooling: its first run found a reference that pointed at
a valid section with the wrong meaning, which no link checker would have caught.
`docs/OVERVIEW.md` makes the ownership rule normative; this makes it enforceable.
(D-47)
"""
import json, os, re, pathlib, collections, sys

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

# A link to a heading (`doc.md#the-heading`, or `#the-heading` in the same document) must name a heading that is there: the file
# check above stops at the `#`, so a heading renamed or moved to another file left every link to it pointing at the top of the page.
# The name is the one GitHub makes of the heading's text.
def slug(heading):
    heading = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', heading.replace('`', ''))
    return re.sub(r'[^\w\- ]', '', heading.strip().lower()).replace(' ', '-')

def headings_of(text):
    text = re.sub(r'^(```|~~~).*?^\1', '', text, flags=re.M | re.S)
    seen, found = collections.Counter(), set()
    for h in re.findall(r'^#{1,6}\s+(.+?)\s*#*\s*$', text, re.M):
        name = slug(h)
        found.add(name if seen[name] == 0 else f'{name}-{seen[name]}')
        seen[name] += 1
    return found

HEADINGS = {f: headings_of(s) for f, s in docs.items()}
checked_links = []
for f, s in docs.items():
    prose = re.sub(r'^(```|~~~).*?^\1', '', s, flags=re.M | re.S)
    prose = re.sub(r'`[^`\n]*`', '', prose)
    for text, tgt in re.findall(r'\[([^\]]*)\]\(([^)\s]+)\)', prose):
        if tgt.startswith(('http', 'mailto')) or '#' not in tgt:
            continue
        path, _, fragment = tgt.partition('#')
        target = f if path == '' else os.path.normpath(pathlib.PurePosixPath(f).parent / path)
        checked_links.append(tgt)
        if target in HEADINGS and fragment not in HEADINGS[target]:
            problems['a link names a heading that is not there'].append(f"{f}: [{text}]({tgt})")

# The migrations that exist are the files, not what a document says about them —
# reading the list from SCHEMA.md compared the document to itself.
applied = sorted(p.name for p in pathlib.Path('packages/db/migrations').glob('*.sql'))
# A module's own set lives in a directory of its own and is named `<module>/<file>` (D-250, D-86): the core's
# numbers are not its numbers, so a reference without the module's name is the core's.
module_applied = sorted(
    f"{d.name}/{p.name}"
    for d in pathlib.Path('packages/db/migrations').iterdir() if d.is_dir()
    for p in d.glob('*.sql')
)
planned = sorted(set(re.findall(r'(?<![\w/-])(00\d\d_[a-z_]+\.sql)', sch)))
for name in module_applied:
    if not re.search(rf'^{re.escape(name)}\b', sch, re.M):
        problems['module migration missing from SCHEMA.md §12'].append(name)
for name in sorted(set(re.findall(r'(?<![\w/-])([a-z][a-z0-9-]*/00\d\d_[a-z_]+\.sql)', sch))):
    if name not in module_applied:
        problems['SCHEMA.md names a module migration that is not a file'].append(name)
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

def is_changelog(f):
    return f.startswith("docs/changelog/")

# A figure of seven digits or more, written out (a size in bytes, a count of milliseconds), is a copy wherever it appears twice:
# it lives in one document and the others say the thing in words. The documents that record what was true on their dates
# are exempt, as they are from the version check below. A number the code owns is held against it by `stated-numbers.test.ts`
# (a sentence) or written into the document by `bun run docs:sync` (a table), not by listing it here (`CONTRIBUTING.md` §6.1).
figure_re = re.compile(r'(?<![\w.,/-])\d{7,}(?!\w)')
figure_homes = collections.defaultdict(set)
for f, s in docs.items():
    if f == 'docs/DECISIONS.md' or is_changelog(f) or f.startswith(('docs/spikes/', 'docs/superpowers/')):
        continue
    for figure in figure_re.findall(s):
        figure_homes[figure].add(f)
for figure, homes in sorted(figure_homes.items()):
    if len(homes) > 1:
        problems['a figure is stated in more than one document'].append(f"{figure}: {sorted(homes)}")

# A path a document names in backticks exists. A file that was renamed or deleted leaves a sentence that sends a reader
# nowhere (the audit found `ingress/http/messages.ts` and `issues-budget.integration.test.ts` named long after they moved).
# History keeps what was true on its date, and the module guide's `acme` is an example, so both are left out; the few
# paths below are named on purpose as what is not there (a build output, a rejected directory, the file a decision removed).
PATH_HISTORY_PREFIXES = ('docs/changelog/', 'docs/spikes/', 'docs/superpowers/', '.')
PATH_ABSENT_ON_PURPOSE = {'.github/dependabot.yml', 'apps/macos', 'apps/desktop', 'apps/web/dist'}
path_re = re.compile(r'`((?:apps|packages|scripts|docs|docker)/[A-Za-z0-9_./@-]+?)(?::\d+)?`')
for f, s in docs.items():
    if f.startswith(PATH_HISTORY_PREFIXES) or f == 'docs/MODULE-GUIDE.md':
        continue
    for named in sorted({m.rstrip('/.') for m in path_re.findall(s)} - PATH_ABSENT_ON_PURPOSE):
        if '*' not in named and not pathlib.Path(named).exists():
            problems['a document names a path that does not exist'].append(f"{f}: {named}")

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
VERSION_OWNERS = {"docs/DECISIONS.md"}
# A spike record exists to say which versions were actually resolved on a
# given day. Naming them is its entire job, so the whole directory is an
# owner — the same reasoning as the changelog. (D-57)
VERSION_OWNER_PREFIXES = ("docs/spikes/", "docs/changelog/")
# Every file under docs/changelog/ is history — the changelog, the release notes of each version and what
# was written before the first release — and is judged as history by the checks below that say so.
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
    if is_changelog(f):
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
                if f != "docs/DECISIONS.md" and not is_changelog(f))
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
           for f in sorted(docs) if not is_changelog(f)}

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

# ---- the decision record keeps its own promises -------------------------------
# A decision that says `amends D-x` changes what D-x says, and D-x carries a note that points back (D-255): without it a reader
# of D-x believes a sentence that stopped being true. The module platform's decisions (D-250 on) also say what reversing them
# costs, as the legend of the record promises, and none is filed under the open questions, which they are not.
_records = {int(n): body for n, body in re.findall(r'^### D-(\d+)\. (.*?)(?=^### |^## |\Z)', dec, re.M | re.S)}
for _n, _body in _records.items():
    _header = _body.split('\n', 1)[0]
    if 'amends' in _header:
        _tail = re.split(r' — ', _header[_header.index('amends'):])[0].split(';')[0]
        for _x in re.findall(r'D-(\d+)', _tail):
            if int(_x) in _records and not re.search(rf'\bD-{_n}\b', _records[int(_x)]):
                problems['a decision amends another that does not name it'].append(f"D-{_n} amends D-{_x}, which has no note pointing back")
    if _n >= 250 and '**Cost of reversing' not in _body:
        problems['a decision has no cost of reversing'].append(f"D-{_n}")
_open = re.search(r'^## Part D .*?(?=^## )', dec, re.M | re.S)
if _open:
    for _n in re.findall(r'^### D-(\d+)\.', _open.group(0), re.M):
        problems['a decision is filed under the open questions'].append(f"D-{_n}")

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

# ---- retired claims: sentences that were true once and are not now ----------
# A document that keeps saying what the code stopped doing is the defect the module review found five of (D-255):
# the cluster that "refuses to serve", a public handshake that "lists" modules, hooks "held only while it runs".
# Each pattern is a sentence somebody wrote and the code contradicted; the check keeps it from coming back. A decision
# is a dated record, so the sentences D-250 and D-254 decided are left standing there with a note that amends them
# (D-255), and `DECISIONS.md` is exempt from the patterns that quote them. The changelog is history and is exempt from all.
RETIRED_CLAIMS = [
    (r'refuses to serve', {'docs/DECISIONS.md'},
     'a node with another module set is told, never stopped (D-255 §1)'),
    (r'share no (?:bus )?channel', {'docs/DECISIONS.md'},
     'nodes of different sets share the one bus channel (D-255 §1)'),
    (r'held only while it runs', set(),
     'a module'"'"'s data hooks are held whether or not it runs (D-254 §4)'),
    (r'`GET /api/client` lists?\b', {'docs/DECISIONS.md'},
     'the public handshake names no module; `GET /api/me` lists them (D-255 §5)'),
    (r'`MODULES\.md` §9 steps', set(),
     'the steps are in `MODULES.md` §10; §9 is the checklist'),
    (r'never mounted', set(),
     'a module that is not run has its routes registered and closed by path (D-255 §2)'),
    (r'\bfirst 77 files\b', {'docs/DECISIONS.md'},
     'it is the 77 files that existed when this was decided'),
    (r'`dataInCore: true`|with\s+`dataInCore`|sets `dataInCore`', set(),
     'the `dataInCore` flag was removed: every bundled module'"'"'s data hooks are held (D-255 §3)'),
    (r'may remove this flag', set(),
     'the compose simplification merged: there is no `dataInCore` flag'),
    (r'no oracle\b[^.\n]*exact for paths|adds nothing to what a closed route', {'docs/DECISIONS.md'},
     'a closed route hides body and code, not status: an anonymous caller sees 401 or 404 (MODULES.md §3, D-255 §5)'),
    (r'not built until the step named', {'docs/DECISIONS.md'},
     'the steps of D-283 §1 are built; what is not built is the table at the end of MODULES.md §10 (D-295)'),
    (r'Nothing holds either', set(),
     'the README'"'"'s decision count is held by `check:docs`; the changelog entry is the only one a reviewer reads (MODULES.md §9 item 7)'),
    (r'isolation by budget is intent|no process takes it|nothing outside its tests imports it', set(),
     'the module budget is wired for issues, and `budget:latency` holds chat against starvation (D-255 §9)'),
]
for _f, _body in docs.items():
    if is_changelog(_f):
        continue
    for _pattern, _exempt, _why in RETIRED_CLAIMS:
        if _f in _exempt:
            continue
        for _m in re.finditer(_pattern, _body):
            _line = _body.count('\n', 0, _m.start()) + 1
            problems['a retired claim is back'].append(f"{_f}:{_line}: {_m.group(0)!r} — {_why}")

# ---- citations in source code resolve too ------------------------------------
# A comment that cites `MODULES.md §11` or D-254 is a pointer a reader follows. The documents' own references are
# checked above; the ones in source were not, and a renumbering left them pointing at nothing or at another thing.
_SOURCE_SUFFIXES = {'.ts', '.tsx', '.mjs'}
_SOURCE_SKIP = {'.git', 'node_modules', '.tsbuild', 'dist', 'coverage'} | PERSONAL
_source_cite = re.compile(r'`?([A-Za-z]+\.md)`?\s+§+\s*(\d+(?:\.\d+)?)')
_sources = 0
for _p in sorted(pathlib.Path('.').rglob('*')):
    if _p.suffix not in _SOURCE_SUFFIXES or _SOURCE_SKIP & set(_p.parts) or not _p.is_file():
        continue
    try:
        _text = _p.read_text()
    except UnicodeDecodeError:
        continue
    _sources += 1
    for _doc, _sec in _source_cite.findall(_text):
        _target = alias.get(_doc)
        if _target and _sec not in TITLES[_target]:
            problems['source cites a section that does not exist'].append(f"{_p.as_posix()} -> {_doc} §{_sec}")
    for _n in sorted({int(m) for m in re.findall(r'\bD-(\d+)\b', _text)}):
        if _n not in defined['D']:
            problems['source cites a decision that does not exist'].append(f"{_p.as_posix()}: D-{_n}")
# A scan that read nothing found nothing for the wrong reason (CONTRIBUTING §6.4).
if _sources < 100:
    problems['the source citation scan read almost nothing'].append(f"{_sources} files")

# ---- every module the build carries is named where an operator and a reader look ---
# `module-listing.test.ts` holds MODULES.md §11 to the manifests; ARCHITECTURE.md's folder tree and CONFIG.md's `MODULES`
# row are the other two places a module is listed, and a module added to `bundledModules` without them is a document
# that does not know it exists.
_composition = pathlib.Path('apps/api/src/composition.ts').read_text()
_bundle = re.search(r'bundledModules(?:: readonly BundledModule\[\])? = \[([^\]]*)\]', _composition)
_bundled_ids = [re.sub(r'(?<!^)(?=[A-Z])', '-', n.strip()[:-len('Module')]).lower()
                for n in (_bundle.group(1).split(',') if _bundle else []) if n.strip().endswith('Module')]
if not _bundled_ids:
    problems['the bundled modules could not be read from composition.ts'].append('bundledModules')
_config_row = next((l for l in docs['docs/CONFIG.md'].split('\n') if l.startswith('| `MODULES` |')), '')
for _id in _bundled_ids:
    if not re.search(rf'[├└]── {re.escape(_id)}/', docs['docs/ARCHITECTURE.md']):
        problems['a bundled module is missing from ARCHITECTURE.md'].append(f"{_id}: no `{_id}/` in the features tree")
    if f'`{_id}`' not in _config_row:
        problems['a bundled module is missing from CONFIG.md'].append(f"{_id}: not named in the `MODULES` row")

print(f"decisions D-1..D-{max(defined['D'])} · invariants I-1..I-{max(defined['I'])} · open questions O-1..O-{max(defined['O'])}")
print(f"migrations {mig[0]}..{mig[-1]}")
print(f"{len(resolved)} cross-document references resolved, {len(checked_links)} links to a heading")
print()
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
