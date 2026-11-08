#!/usr/bin/env python3
"""Multi-source job scanner. No LLM tokens needed until you read the digest.

Commands
  discover  <names.txt>        find which ATS (Greenhouse/Lever/Ashby/SmartRecruiters/Workable) each employer uses
  scan      [--city Chicago]   pull jobs from every board in employers.json, score, dedupe, update jobs_state.json
  digest    [--top N]          print top-scored NEW/open listings + bank count (compact markdown)
  verify                       re-check links of top listings (closed/redirect detection)
  enrich    [--top N]          fetch descriptions for top listings: pay, years asked, clearance/people-mgmt language, content score
  sync-tracker                 rebuild rejected.json from tracker.xlsx (needs openpyxl)
Sources: greenhouse, lever, ashby, smartrecruiters, workable, workday.
Optional keyed APIs (not enabled): ADZUNA_APP_ID/ADZUNA_APP_KEY, USAJOBS_API_KEY/USAJOBS_EMAIL.
"""
import json, re, sys, os, time, argparse, difflib, html, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
EMP = os.path.join(HERE, "employers.json")
STATE = os.path.join(HERE, "jobs_state.json")
REJ = os.path.join(HERE, "rejected.json")
TRACKER = os.path.join(HERE, "tracker.xlsx")  # optional: a spreadsheet of past applications, used by sync-tracker
PAY_FLOOR = int(os.environ.get("PAY_FLOOR", "0"))  # listings whose top pay is below this are penalised (0 = off)
UA = {"User-Agent": "Mozilla/5.0 (personal job search script)", "Accept": "application/json"}

def http(url, data=None, timeout=20):
    body = json.dumps(data).encode() if data is not None else None
    h = dict(UA)
    if body: h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.geturl(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, url, b""
    except Exception as e:
        return 0, url, str(e).encode()

def jget(url, data=None):
    s, _, b = http(url, data)
    if s != 200: return None
    try: return json.loads(b)
    except Exception: return None

# ---------- fetchers: each returns list of dict(id,title,loc,url,posted,dept,remote) ----------
def f_greenhouse(slug, **_):
    j = jget(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
    return [dict(id=f"gh:{slug}:{x['id']}", title=x["title"], loc=(x.get("location") or {}).get("name",""),
                 url=x["absolute_url"], posted=x.get("updated_at","")[:10], dept="") for x in (j or {}).get("jobs", [])]

def f_lever(slug, eu=False, **_):
    host = "api.eu.lever.co" if eu else "api.lever.co"
    j = jget(f"https://{host}/v0/postings/{slug}?mode=json")
    out = []
    for x in j or []:
        c = x.get("categories") or {}
        ts = x.get("createdAt")
        out.append(dict(id=f"lv:{slug}:{x['id']}", title=x["text"], loc=c.get("location","") or "", url=x["hostedUrl"],
                        posted=datetime.fromtimestamp(ts/1000, timezone.utc).strftime("%Y-%m-%d") if ts else "",
                        dept=c.get("team","") or "", remote=x.get("workplaceType","")))
    return out

def f_ashby(slug, **_):
    j = jget(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    return [dict(id=f"ab:{slug}:{x['id']}", title=x["title"], loc=x.get("location","") or "", url=x["jobUrl"],
                 posted=(x.get("publishedAt") or "")[:10], dept=x.get("department","") or "",
                 remote="remote" if x.get("isRemote") else "") for x in (j or {}).get("jobs", [])]

def f_smartrecruiters(slug, **_):
    out, off = [], 0
    while off < 400:
        j = jget(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset={off}")
        if not j or not j.get("content"): break
        for x in j["content"]:
            l = x.get("location") or {}
            out.append(dict(id=f"sr:{slug}:{x['id']}", title=x["name"],
                            loc=", ".join(p for p in [l.get("city"), l.get("region"), l.get("country")] if p),
                            url=f"https://jobs.smartrecruiters.com/{slug}/{x['id']}", posted=(x.get("releasedDate") or "")[:10],
                            dept=(x.get("department") or {}).get("label",""), remote="remote" if l.get("remote") else ""))
        off += 100
        if off >= j.get("totalFound", 0): break
    return out

def f_workable(slug, **_):
    j = jget(f"https://apply.workable.com/api/v3/accounts/{slug}/jobs", {"query": "", "location": [], "department": [], "worktype": [], "remote": []})
    return [dict(id=f"wk:{slug}:{x['shortcode']}", title=x["title"],
                 loc=", ".join(p for p in [(x.get("location") or {}).get("city"), (x.get("location") or {}).get("region"), (x.get("location") or {}).get("country")] if p),
                 url=f"https://apply.workable.com/{slug}/j/{x['shortcode']}/", posted=(x.get("published") or "")[:10],
                 dept=x.get("department","") if isinstance(x.get("department"), str) else "", remote="remote" if x.get("remote") else "")
            for x in (j or {}).get("results", [])]

def f_workday(slug, wd="wd5", site="External", search="", maxn=800, **_):
    # slug = tenant
    base = f"https://{slug}.{wd}.myworkdayjobs.com"
    out, off = [], 0
    while off < maxn:
        j = jget(f"{base}/wday/cxs/{slug}/{site}/jobs", {"appliedFacets": {}, "limit": 20, "offset": off, "searchText": search})
        if not j or not j.get("jobPostings"): break
        for x in j["jobPostings"]:
            out.append(dict(id=f"wd:{slug}:{x['externalPath'].split('_')[-1]}", title=x["title"], loc=x.get("locationsText",""),
                            url=f"{base}/{site}{x['externalPath']}", posted=x.get("postedOn",""), dept=""))
        off += 20
        if off >= j.get("total", 0): break
    return out

FETCH = dict(greenhouse=f_greenhouse, lever=f_lever, ashby=f_ashby, smartrecruiters=f_smartrecruiters, workable=f_workable, workday=f_workday)

# ---------- scoring ----------
POS = [(r"ai (governance|policy|safety|risk|ethics)|responsible ai|trustworth|trust (&|and) safety|algorithmic", 5),
       (r"simulat|forecast|foresight|scenario|digital twin|agent-based|modell?ing|operations research|systems (analy|model|thinking)", 4),
       (r"strateg|consult|chief of staff|generalist|special projects|founding", 3),
       (r"polic(y|ies)|public sector|government|civic|urban|city|municipal|transport|planning|housing|climate|sustainab|energy|resilien", 3),
       (r"mixed[- ]method|evaluation|public interest|public service|nonprofit|non-profit|impact assessment", 2),
       (r"research|analyst|economist|evaluation|impact|insight|quantitative|applied scien", 2),
       (r"program (associate|analyst)|associate|fellow", 1),
       (r"hybrid", 1)]
NEG = [(r"sales|account (exec|manager)|business development|recruit|talent|marketing|designer|nurse|clinical|counsel|attorney|paralegal|accountant|payroll|"
        r"software engineer|developer|devops|sre\b|site reliab|security engineer|mechanic|technician|driver|warehouse|customer (success|support)|"
        r"intern\b|internship|barista|cook|security guard|facilit|financ(e|ial) (analyst|planning)|fp&a|accounting|audit|actuar", -6),
       (r"\b(vp|vice president|svp|evp|chief (?!of staff)|head of|director|principal)\b", -3),
       (r"\(20\d\d.*graduat|new grad|university grad|campus|entry[- ]level|graduate program|\bjunior\b", -4),
       (r"forensic|ediscovery|e-discovery|litigation|intellectual property|due diligence|incident response|recovery services|billing|valuation|tax\b", -4),
       (r"team lead|people manager|supervisor|managing (consultant|director)", -3),      # people-management
       (r"(program|project|product) manager", -2),                                         # PM-heavy
       (r"data scien(ce|tist)(?!.*(polic|strateg|research|evaluat|impact|social|public))", -2)]  # pure DS disconnected from context
DEFENSE = re.compile(r"palantir|leidos|lockheed|raytheon|\brtx\b|booz allen|\bsaic\b|northrop|general dynamics|l3harris|\bbae\b|\bcaci\b|anduril|shield ai|mitre|sandia|aerospace corp|peraton|parsons", re.I)
MISSION = {}   # {"employer substring": ("note shown on the row", score penalty)}: your own values screen
EMP_NOTE = {}  # {"employer substring": "note shown on the row"}
HOME = os.environ.get("HOME_CITY_RX", r"chicago|, il\b|illinois|evanston")  # regex for the home city; set HOME_CITY_RX to change it
LOC_OK = re.compile(HOME + r"|remote|anywhere|united states|\bus\b|usa|hybrid", re.I)
CHI = re.compile(HOME, re.I)

DOMAIN_IDX = {0, 1, 3, 4}   # POS groups that signal subject matter (AI gov, simulation, policy/urban/climate, mixed-methods/evaluation)

def score(j):
    t = f"{j['title']} {j.get('dept','')}".lower()
    dom = sum(w for i, (rx, w) in enumerate(POS) if i in DOMAIN_IDX and re.search(rx, t))
    role = sum(w for i, (rx, w) in enumerate(POS) if i not in DOMAIN_IDX and re.search(rx, t))
    s = dom + (role if dom > 0 else min(role, 2))   # generic role words alone cannot carry a listing
    for rx, w in NEG:
        if re.search(rx, t): s += w
    if re.search(r"\bsenior\b|\bsr\.?\b|\blead\b|manager", t): s -= 1
    return s

def load(p, d):
    try: return json.load(open(p))
    except Exception: return d

# ---------- rejected / watch / ranking ----------
GENERIC = re.compile(r"general application|expression of interest|open application|spontaneous|rolling application|resume bank|sign-up|^\(various\)|^—$", re.I)

def norm(t): return re.sub(r"[^a-z0-9 ]", " ", (t or "").lower()).strip()

def load_rej():
    r = load(REJ, {"single_role_orgs": [], "rejected": [], "watch": []})
    return r

def org_match(emp, org):
    e, o = norm(emp), norm(org)
    return bool(e and o and (e == o or e in o or o in e))

def rejection(j, rej):
    """Returns ('hide', note) | ('flag', note) | None."""
    for org in rej.get("single_role_orgs", []):
        if org_match(j.get("employer", ""), org): return ("hide", f"org exhausted ({org})")
    for r in rej.get("rejected", []):
        if org_match(j.get("employer", ""), r["org"]):
            if GENERIC.search(r["role"] or ""): continue
            ratio = difflib.SequenceMatcher(None, norm(j["title"]), norm(r["role"])).ratio()
            R = {w[:6] for w in norm(r["role"]).split() if len(w) > 2}; T = {w[:6] for w in norm(j["title"]).split() if len(w) > 2}
            overlap = len(R & T) / len(R) if R else 0
            if ratio >= 0.72 or norm(r["role"]) in norm(j["title"]) or (len(R) >= 2 and overlap >= 0.67): return ("hide", f"same role as prior reject: {r['role']}")
    for r in rej.get("rejected", []):
        if org_match(j.get("employer", ""), r["org"]): return ("flag", f"prior reject at {r['org']} (different role OK)")
    return None

def rank(j, rej):
    sc = score(j); flags = []
    emp = j.get("employer", "")
    if DEFENSE.search(emp): sc -= 4; flags.append("defense contractor")
    for k, v in EMP_NOTE.items():
        if k in emp.lower(): flags.append(v)
    for k, (note, pen) in MISSION.items():
        if k in emp.lower(): sc += pen; flags.append(note)
    loc = f"{j.get('loc','')} {j.get('remote','')}"
    if re.search(r"remote|anywhere", loc, re.I) and not j.get("chicago"): sc -= 2; flags.append("REMOTE-ONLY")
    e = j.get("enr") or {}
    if e:
        sc += e.get("dscore", 0)
        if e.get("clearance"): sc -= 4; flags.append("clearance/defense language")
        if e.get("mgmt"): sc -= 2; flags.append("people-mgmt language")
        if e.get("years") and e["years"] >= 6: sc -= 2; flags.append(f"asks {e['years']}+ yrs")
        elif e.get("years"): flags.append(f"{e['years']} yrs")
        if e.get("pay_max"):
            if e["pay_max"] < PAY_FLOOR: sc -= 3; flags.append(f"BELOW FLOOR (max ${e['pay_max']:,})")
            else: flags.append(f"pay ${e.get('pay_min',0):,}-${e['pay_max']:,}")
    r = rejection(j, rej)
    hidden = False
    if r:
        if r[0] == "hide": hidden = True
        flags.append(r[1])
    if j.get("watch"): flags.append("WATCHLIST employer")
    return sc, flags, hidden

# ---------- description enrichment ----------
def strip(h): return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(h or "")))

_ab = {}
def fetch_desc(j):
    kind, slug, jid = j["id"].split(":", 2)
    if kind == "gh":
        d = jget(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}?pay_transparency=true") or {}
        pr = d.get("pay_input_ranges") or []
        pays = [(p.get("min_cents", 0) // 100, p.get("max_cents", 0) // 100) for p in pr]
        return strip(d.get("content", "")), pays
    if kind == "lv":
        d = jget(f"https://api.lever.co/v0/postings/{slug}/{jid}") or {}
        sr = d.get("salaryRange") or {}
        pays = [(sr["min"], sr["max"])] if sr.get("min") and sr.get("interval", "").startswith("per-year") else []
        return (d.get("descriptionPlain", "") + " " + " ".join(x.get("text", "") + " " + strip(x.get("content", "")) for x in d.get("lists", []))), pays
    if kind == "ab":
        if slug not in _ab: _ab[slug] = jget(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true") or {}
        for x in _ab[slug].get("jobs", []):
            if x["id"] == jid:
                return (x.get("descriptionPlain") or strip(x.get("descriptionHtml", "")) or ""), []
    if kind == "wd":
        m = re.match(r"https://([^.]+)\.(wd\d+)\.myworkdayjobs\.com/([^/]+)(/job/.*)", j["url"])
        if m:
            d = jget(f"https://{m[1]}.{m[2]}.myworkdayjobs.com/wday/cxs/{m[1]}/{m[3]}{m[4]}") or {}
            return strip((d.get("jobPostingInfo") or {}).get("jobDescription", "")), []
    return "", []

DPOS = [(r"mixed[- ]method|qualitative and quantitative", 2), (r"forecast|scenario|simulat|systems (thinking|analysis)|foresight", 2),
        (r"python|\bsql\b|\bR\b|statistic", 1), (r"evaluation|policy|public (sector|interest)|societ|resilien|climate|equity", 1),
        (r"concrete|mentor|feedback", 1)]

def enrich_one(j):
    try: text, pays = fetch_desc(j)
    except Exception: return
    if not text: return
    t = text.lower(); e = {}
    e["dscore"] = min(4, sum(w for rx, w in DPOS if re.search(rx, text, re.I)))
    e["clearance"] = bool(re.search(r"ts/sci|secret clearance|(active|current|must (hold|have|obtain)|ability to obtain|requires?)[^.]{0,40}clearance", t)) and not re.search(r"clearance required\s*:\s*none", t)
    e["mgmt"] = bool(re.search(r"direct reports|people management|manage a team|supervise|lead a team|manage and mentor", t))
    ys = [int(x) for x in re.findall(r"(\d{1,2})\+?\s*(?:or more )?(?:\+\s*)?years", t) if 0 < int(x) < 20]
    e["years"] = max(ys) if ys else 0
    if not pays:
        nums = [int(x.replace(",", "")) for x in re.findall(r"\$\s?(\d{2,3}(?:,\d{3}))", text)]
        if nums: pays = [(min(nums), max(nums))]
    if pays: e["pay_min"], e["pay_max"] = min(p[0] for p in pays), max(p[1] for p in pays)
    j["enr"] = e

def cmd_enrich(a):
    st = load(STATE, {"jobs": {}}); rej = load_rej()
    rows = []
    for j in st["jobs"].values():
        if not j.get("open") or j.get("enr") or (a.chicago and not j.get("chicago")): continue
        sc, fl, hid = rank(j, rej)
        if not hid and sc >= a.min: rows.append((sc, j))
    rows.sort(key=lambda x: -x[0]); rows = rows[:a.top]
    with ThreadPoolExecutor(6) as ex: list(ex.map(enrich_one, [j for _, j in rows]))
    json.dump(st, open(STATE, "w"), indent=1)
    print(f"enriched {sum(1 for _, j in rows if j.get('enr'))}/{len(rows)}")

def cmd_sync_tracker(a):
    import openpyxl
    wb = openpyxl.load_workbook(TRACKER, data_only=True)
    ws = wb["Applications Log"]; rej = load_rej(); rows = []
    for r in list(ws.iter_rows(values_only=True))[2:]:
        if r[1] and str(r[4]).lower() in ("rejected", "applied", "interview", "withdrawn"): rows.append({"org": str(r[1]), "role": str(r[2] or ""), "status": str(r[4])})
    rej["rejected"] = rows
    json.dump(rej, open(REJ, "w"), indent=1); print(f"synced {len(rows)} tracker rows")

# ---------- commands ----------
def slugs(name):
    n = re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()
    return list(dict.fromkeys([n.replace(" ", ""), n.replace(" ", "-"), n.split()[0] if n else ""]))

def probe(name):
    found = []
    for s in slugs(name):
        if not s: continue
        for ats in ("greenhouse", "lever", "ashby", "smartrecruiters", "workable"):
            try:
                r = FETCH[ats](s)
            except Exception:
                r = []
            if r: found.append(dict(name=name, ats=ats, slug=s, n=len(r)))
    return found

def cmd_discover(a):
    names = [l.strip() for l in open(a.names) if l.strip() and not l.startswith("#")]
    emp = load(EMP, {"boards": []})
    have = {(b["ats"], b["slug"]) for b in emp["boards"]}
    with ThreadPoolExecutor(8) as ex:
        for res in ex.map(probe, names):
            for f in res:
                if (f["ats"], f["slug"]) not in have:
                    if a.watch: f["watch"] = True
                    emp["boards"].append(f); have.add((f["ats"], f["slug"]))
                    print(f"FOUND {f['name']:30} {f['ats']:16} {f['slug']:25} {f['n']} jobs")
    json.dump(emp, open(EMP, "w"), indent=1)

def cmd_scan(a):
    emp = load(EMP, {"boards": []}); st = load(STATE, {"jobs": {}, "runs": []})
    today = datetime.now().strftime("%Y-%m-%d"); new = 0; seen_now = set()
    def run(b):
        try: return b, FETCH[b["ats"]](b["slug"], **{k: v for k, v in b.items() if k in ("wd", "site", "search", "eu")})
        except Exception as e: return b, []
    with ThreadPoolExecutor(8) as ex:
        for b, jobs in ex.map(run, emp["boards"]):
            for j in jobs:
                if b.get("search") and re.search(r"chicago", b["search"], re.I) and re.search(r"location", j["loc"], re.I): j["loc"] = j["loc"] + " (Chicago search)"
                loc = f"{j['loc']} {j.get('remote','')}"
                if not b.get("watch"):
                    if a.city and not CHI.search(loc) and not (a.remote and re.search(r"remote|anywhere", loc, re.I)): continue
                    if not a.city and not LOC_OK.search(loc): continue
                j["watch"] = bool(b.get("watch")); j["employer"] = b["name"]; j["score"] = score(j); j["chicago"] = bool(CHI.search(loc)); seen_now.add(j["id"])
                old = st["jobs"].get(j["id"])
                if old: old.update({k: j[k] for k in ("title", "loc", "url", "score")}); old["last_seen"] = today; old["open"] = True
                else:
                    j.update(first_seen=today, last_seen=today, decision="", reason="", open=True); st["jobs"][j["id"]] = j; new += 1
    for i, j in st["jobs"].items():  # anything from scanned boards no longer present = closed
        if i not in seen_now and j.get("last_seen") != today and j.get("open") and not a.city: j["open"] = False
    st["runs"].append(dict(date=today, new=new, total_seen=len(seen_now)))
    json.dump(st, open(STATE, "w"), indent=1)
    print(f"scanned {len(emp['boards'])} boards; matching listings seen {len(seen_now)}; new {new}")

def cmd_digest(a):
    st = load(STATE, {"jobs": {}}); rej = load_rej(); rows = []; hidden = 0
    for j in st["jobs"].values():
        if not j.get("open") or j.get("decision"): continue
        sc, fl, hid = rank(j, rej)
        if hid and not a.show_hidden: hidden += 1; continue
        if sc >= a.min: rows.append((sc, fl, j))
    rows.sort(key=lambda x: (-x[0], not x[2]["chicago"], x[2]["title"]))
    print(f"{len(rows)} candidates scoring >= {a.min} ({hidden} hidden as same-role/exhausted-org rejects); showing {a.top}\n")
    for sc, fl, j in rows[:a.top]:
        print(f"[{sc:>2}] {j['title'][:70]} | {j['employer']} | {j['loc'][:30]} | {j['posted']} | {j['url']}" + (f"\n      flags: {'; '.join(fl)}" if fl else ""))

def cmd_verify(a):
    st = load(STATE, {"jobs": {}})
    rows = sorted([j for j in st["jobs"].values() if j.get("open") and (j["chicago"] or not a.chicago)], key=lambda j: -j["score"])[:a.top]
    CLOSED = re.compile(r"no longer (accepting|available)|position (has been )?(filled|closed)|job (is )?not (active|found)|has expired|page not found|not currently accepting", re.I)
    for j in rows:
        s, final, body = http(j["url"])
        txt = body.decode("utf8", "ignore")[:200000]
        bad = s != 200 or "error=true" in final or bool(CLOSED.search(txt))
        j["verified"] = datetime.now().strftime("%Y-%m-%d"); j["link_ok"] = not bad
        print(("DEAD " if bad else "OK   ") + f"{s} {j['title'][:50]} — {j['employer']} {j['url']}")
    json.dump(st, open(STATE, "w"), indent=1)

if __name__ == "__main__":
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest="cmd", required=True)
    d = sp.add_parser("discover"); d.add_argument("names"); d.add_argument("--watch", action="store_true"); d.set_defaults(f=cmd_discover)
    s = sp.add_parser("scan"); s.add_argument("--city", default=""); s.add_argument("--remote", action="store_true"); s.set_defaults(f=cmd_scan)
    g = sp.add_parser("digest"); g.add_argument("--top", type=int, default=25); g.add_argument("--min", type=int, default=3); g.add_argument("--show-hidden", action="store_true"); g.set_defaults(f=cmd_digest)
    en = sp.add_parser("enrich"); en.add_argument("--top", type=int, default=40); en.add_argument("--min", type=int, default=2); en.add_argument("--chicago", action="store_true"); en.set_defaults(f=cmd_enrich)
    sy = sp.add_parser("sync-tracker"); sy.set_defaults(f=cmd_sync_tracker)
    v = sp.add_parser("verify"); v.add_argument("--top", type=int, default=20); v.add_argument("--chicago", action="store_true"); v.set_defaults(f=cmd_verify)
    a = p.parse_args(); a.f(a)
