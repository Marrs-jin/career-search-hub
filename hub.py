#!/usr/bin/env python3
"""Daily Hub: one local page to run the day's job search and applications.

Run:  python3 hub.py          (opens http://127.0.0.1:8765 in your browser)
Needs only Python 3 (standard library). Uses the scanner in ./scanner.
Your data lives in data/hub.json (backups in data/backups/).
"""
import argparse, json, os, re, sys, threading, time, traceback, uuid, webbrowser, html as htmllib
import contextlib, io, shutil, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
HUB_FILE = os.path.join(DATA_DIR, "hub.json")
CACHE_FILE = os.path.join(DATA_DIR, "desc_cache.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
STATIC = os.path.join(HERE, "static")
SCAN_DIR = os.environ.get("HUB_SCANNER_DIR") or os.path.join(HERE, "scanner")
SCAN_DIR = os.path.abspath(SCAN_DIR)

sys.path.insert(0, SCAN_DIR)
try:
    import ats_scan  # the existing scanner; the hub calls its functions directly
except Exception as e:  # pragma: no cover
    print(f"Could not load the scanner from {SCAN_DIR}: {e}", file=sys.stderr)
    IMPORT_ERROR[0] = f"Could not load the scanner from {SCAN_DIR}: {type(e).__name__}: {e}"
    ats_scan = None

import search_sources as SS  # where-parsing, web search, local sites, summaries (lives next to hub.py)

EXTRA_FILE = os.path.join(DATA_DIR, "extra_jobs.json")      # listings found by web search and local sites
BLURB_FILE = os.path.join(DATA_DIR, "blurbs.json")          # short job summaries
ERR_FILE = os.path.join(DATA_DIR, "errors.json")            # error log shown on the Error log tab
SECRET_KEYS = ("google_api_key", "google_cse_id", "anthropic_api_key")
CUSTOM_MD = os.path.join(HERE, "CUSTOMIZATIONS.md")         # readable copy of the customization record (How it works)
RES_LABEL = {"board": "Job Boards", "local": "Local-Specific Job Resources", "large": "Large Employers", "small": "Small Employers", "own": "Self-generated resources"}
LAYER_VIA = {"board": "jobboard", "large": "large", "small": "small"}
VIA_GROUP = {"board": "large", "large": "large", "small": "small", "local": "local", "web": "jobboard", "jobboard": "jobboard"}  # what the Found by filter calls each source

LOCK = threading.RLock()
SCAN = {"running": False, "phase": "", "started": None, "finished": None, "message": "", "error": "", "city": "", "new": 0}

OPEN_STATUSES = ("Applied", "Interview", "Offer")
WAIT_STATUSES = ("Waitlisted", "Watching")
STATUSES = ["Applied", "Interview", "Offer", "Waitlisted", "Watching", "Rejected", "Withdrawn"]
REJ_SYNC = ("rejected", "applied", "interview", "withdrawn", "offer")

TRACKS = {  # the six clusters of the Career Fit Map; used to filter and to word the web searches
    "Advisory/Consultant": r"consult|advis|strateg|client|engagement|solutions",
    "Think Tanks": r"policy|fellow|think tank|institute|advocacy|government affairs|research analyst",
    "AI Governance": r"\bai\b|artificial intelligence|governance|responsible|safety|trust|alignment|risk|emerging tech",
    "Modeling": r"model|simulation|data scientist|quantitative|operations research|systems|forecast|analytics",
    "0-to-1 Launch": r"launch|new initiative|founding|early.stage|chief of staff|program (strategist|lead|manager)|incubat|pilot|special projects|zero to one|0.to.1",
    "Urban Systems": r"urban|city|cities|transport|mobility|housing|municipal|smart city|civic|planning|infrastructure",
}



# ------------------------------------------------------------------ error log
_err_lock = threading.Lock()
IMPORT_ERROR = [""]


def _err_load():
    try:
        with open(ERR_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("items"), list):
            return d
    except Exception:
        pass
    return {"items": [], "seen": ""}


def log_error(area, message, detail="", level="error", source="server"):
    """Add to data/errors.json (newest last, at most 200; repeats of the same problem are counted, not repeated). Never raises."""
    try:
        if level == "error" and re.search(r"BrokenPipe|ConnectionReset|ConnectionAborted", str(message)):
            return  # the browser tab closed mid-answer: nothing to fix
        message, detail = str(message)[:600], (detail or "")[-2500:]
        now = datetime.now().isoformat(timespec="seconds")
        sys.stderr.write(f"[hub] {level.upper()} {area}: {message}\n")
        with _err_lock:
            d = _err_load()
            hit = next((x for x in reversed(d["items"][-30:]) if x["area"] == area and x["message"] == message and x["level"] == level and x["source"] == source), None)
            if hit:
                hit["count"] = hit.get("count", 1) + 1
                hit["at"] = now
                if hit.get("status") == "fixed":  # it came back, so the fix did not hold
                    hit["status"], hit["fix"] = "open", (hit.get("fix") or "") + " (recurred " + now[:10] + ")"
                if detail:
                    hit["detail"] = detail
                d["items"].remove(hit)
                d["items"].append(hit)
            else:
                d["items"].append({"id": uuid.uuid4().hex[:8], "at": now, "level": level, "area": area, "message": message, "detail": detail, "count": 1, "source": source, "status": "open", "fix": ""})
            d["items"] = d["items"][-200:]
            os.makedirs(DATA_DIR, exist_ok=True)
            atomic_write(ERR_FILE, d)
    except Exception:
        pass


def _thread_hook(args):
    log_error("background task", f"{args.exc_type.__name__}: {args.exc_value}", "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)))


threading.excepthook = _thread_hook


def resolve_error(eid, status, note=""):
    """Mark an Error log entry open / fixed / ignored (used by the Error log tab and by Claude's error triage)."""
    if status not in ("open", "fixed", "ignored"):
        raise ValueError("status must be open, fixed or ignored")
    with _err_lock:
        d = _err_load()
        it = next((x for x in d["items"] if x["id"] == eid), None)
        if not it:
            raise ValueError("Unknown error entry")
        it["status"], it["fix"] = status, str(note or "")[:600]
        it["handled_at"] = datetime.now().isoformat(timespec="seconds")
        atomic_write(ERR_FILE, d)
    return {"ok": True}


def errors_new():
    d = _err_load()
    return sum(1 for x in d["items"] if x["at"] > (d.get("seen") or ""))


# ------------------------------------------------------------------ storage
def today():
    return datetime.now().strftime("%Y-%m-%d")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        log_error("data file", f"Could not read {os.path.basename(path)}: {type(e).__name__}: {e}")
        return default


def atomic_write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


_last_backup = [0.0]


def backup_hub():
    """Keep a rolling set of copies of hub.json (at most one per minute, last 30)."""
    if not os.path.exists(HUB_FILE) or time.time() - _last_backup[0] < 60:
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    shutil.copy2(HUB_FILE, os.path.join(BACKUP_DIR, "hub-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"))
    _last_backup[0] = time.time()
    files = sorted(os.listdir(BACKUP_DIR))
    for old in files[:-30]:
        try:
            os.remove(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass


HUB = {}


def load_hub():
    global HUB
    HUB = read_json(HUB_FILE, None)
    if HUB is None and os.path.exists(HUB_FILE):
        log_error("startup", "hub.json could not be read, so the Hub started empty. Your old file is still on disk; do not save anything, quit, and restore a copy from data/backups/.")
    if HUB is None:
        HUB = {"version": 1, "settings": {}, "applications": [], "marks": {}, "manual_jobs": [], "resources": [], "networking": {"companies": [], "people": []},
               "goals": {"bridging": [], "people": [], "study": []}, "activity": []}
    HUB.setdefault("settings", {})
    s = HUB["settings"]
    s.setdefault("daily_goal", 3)
    s.setdefault("default_city", "")
    s.setdefault("cities", ["New York", "London", "Remote"])
    s.setdefault("resume_versions", ["Standard", "Strategy", "AI-Policy", "Data", "Urban"])
    s.setdefault("reminder_after", 5)
    s.setdefault("reminder_since", today())
    s.setdefault("reminder_dismissed", False)
    for k, v in (("applications", []), ("marks", {}), ("manual_jobs", []), ("resources", []), ("activity", [])):
        HUB.setdefault(k, v)
    HUB.setdefault("networking", {})
    for k in ("companies", "people"):
        HUB["networking"].setdefault(k, [])
    HUB.setdefault("todos", [])
    HUB.setdefault("notes", [])
    if not isinstance(HUB.get("reference"), list):  # background notes worth keeping when tuning the search
        HUB["reference"] = []
    HUB.setdefault("goals", {})
    for k in ("bridging", "people", "study"):
        HUB["goals"].setdefault(k, [])
    s.setdefault("small_auto", True)
    s.setdefault("small_last_check", "")
    s.setdefault("reminder_snooze_until", "")
    seed_defaults()
    if not isinstance(HUB.get("customizations"), list):
        HUB["customizations"] = []  # the personalization record starts empty: add a line each time you ask for a change


def seed_defaults():
    """A fresh install gets the two big job boards as Resources; everything else you add yourself."""
    if HUB.get("res_version") == 2:
        return
    have = " ".join((r.get("name") or "").lower() for r in HUB["resources"] if r.get("kind") == "board")
    extra = []
    if "indeed" not in have:
        extra.append({"id": new_id("res_"), "kind": "board", "cat": RES_LABEL["board"], "name": "Indeed", "url": "https://www.indeed.com/", "scan": False, "note": "No open search feed. Refresh searches it through web search.", "last_checked": ""})
    if "linkedin" not in have:
        extra.append({"id": new_id("res_"), "kind": "board", "cat": RES_LABEL["board"], "name": "LinkedIn Jobs", "url": "https://www.linkedin.com/jobs/", "scan": False, "note": "No open search feed. Refresh searches it through web search.", "last_checked": ""})
    HUB["resources"] = extra + HUB["resources"]
    HUB["res_version"] = 2
    save_hub()


def write_customizations_md():
    try:
        out = ["# How this page has been personalized", "", "Same record as the one at the bottom of the How it works tab (stored in data/hub.json under `customizations`).", ""]
        for e in sorted(HUB.get("customizations", []), key=lambda x: x.get("date", ""), reverse=True):
            out.append(f"## {e.get('date', '')}: {e.get('title', '')}")
            out += [f"- {it}" for it in e.get("items", [])]
            if e.get("done_note"):
                out.append(f"- Done: {e['done_note']}")
            out.append("")
        with open(CUSTOM_MD, "w", encoding="utf-8") as f:
            f.write("\n".join(out))
    except Exception as e:
        log_error("customization record", f"{type(e).__name__}: {e}", level="warn")


def do_custom(b):
    op = b.get("op")
    with LOCK:
        L = HUB["customizations"]
        if op == "add":
            items = [str(x).strip()[:600] for x in (b.get("items") or []) if str(x).strip()]
            if not items:
                raise ValueError("Write at least one line about what was requested")
            L.append({"id": new_id("cz_"), "date": b.get("date") or today(), "title": str(b.get("title") or "Request").strip()[:120], "items": items, "source": "requested", "done_note": str(b.get("done_note") or "")[:600]})
        else:
            it = next((x for x in L if x["id"] == b.get("id")), None)
            if not it:
                raise ValueError("Unknown entry")
            if op == "delete":
                L.remove(it)
            elif op == "edit":
                for k in ("title", "date", "done_note"):
                    if k in b:
                        it[k] = str(b[k])[:600]
                if "items" in b:
                    it["items"] = [str(x).strip()[:600] for x in b["items"] if str(x).strip()]
            else:
                raise ValueError("Unknown op")
        save_hub()
    write_customizations_md()
    return {"ok": True}


def save_hub():
    with LOCK:
        os.makedirs(DATA_DIR, exist_ok=True)
        backup_hub()
        atomic_write(HUB_FILE, HUB)


def new_id(prefix):
    return prefix + uuid.uuid4().hex[:8]


def log(kind, text):
    HUB["activity"].append({"at": datetime.now().isoformat(timespec="seconds"), "type": kind, "text": text})
    HUB["activity"] = HUB["activity"][-300:]


# ------------------------------------------------------------------ scanner glue
def scanner_state():
    if not ats_scan:
        return {"jobs": {}, "runs": []}
    return read_json(ats_scan.STATE, {"jobs": {}, "runs": []})


_state_cache = {"mtime": None, "data": None}


def state_cached():
    """jobs_state.json is large; re-read only when the file changes."""
    if not ats_scan:
        return {"jobs": {}, "runs": []}
    try:
        m = os.path.getmtime(ats_scan.STATE)
    except OSError:
        return {"jobs": {}, "runs": []}
    if _state_cache["mtime"] != m:
        _state_cache["data"] = scanner_state()
        _state_cache["mtime"] = m
    return _state_cache["data"]


def sync_rejected():
    """Mirror the records into rejected.json so the scanner hides roles you already tried."""
    if not ats_scan:
        return
    rej = read_json(ats_scan.REJ, {"single_role_orgs": [], "rejected": [], "watch": []})
    rows = []
    for a in HUB["applications"]:
        if a.get("org") and (a.get("status") or "").lower() in REJ_SYNC:
            rows.append({"org": a["org"], "role": a.get("role", ""), "status": a["status"]})
    rej["rejected"] = rows
    atomic_write(ats_scan.REJ, rej)


def sync_marks_to_state():
    """Write your keep/decline choices into the scanner's own decision fields (only when no scan is running)."""
    if not ats_scan or SCAN["running"]:
        return
    with LOCK:
        st = scanner_state()
        changed = False
        for jid, m in HUB["marks"].items():
            j = st["jobs"].get(jid)
            want = "saved" if m.get("state") == "later" else m.get("state", "")  # the scanner has no "later"
            if j and j.get("decision") != want:
                j["decision"] = want
                j["reason"] = m.get("reason", "")
                changed = True
        if changed:
            atomic_write(ats_scan.STATE, st)
            _state_cache["mtime"] = None


def rejection_data():
    return ats_scan.load_rej() if ats_scan else {"single_role_orgs": [], "rejected": []}


def desc_cache():
    return read_json(CACHE_FILE, {})


_rank = {"key": None, "map": {}}


def _mt(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0


def rank_map():
    """Score every listing once, and again only when the scanner files, rejections or cached descriptions change."""
    key = (_mt(ats_scan.STATE), _mt(ats_scan.REJ), _mt(CACHE_FILE))
    if _rank["key"] != key:
        rej, cache, out = rejection_data(), desc_cache(), {}
        for jid, j in state_cached()["jobs"].items():
            jj = dict(j)
            ce = cache.get(jid, {})
            if ce.get("enr") and not jj.get("enr"):
                jj["enr"] = ce["enr"]
            sc, flags, hidden = ats_scan.rank(jj, rej)
            out[jid] = (sc, flags, hidden, jj.get("enr") or {})
        _rank["key"], _rank["map"] = key, out
    return _rank["map"]


def job_view(j, rej=None, cache=None):
    """Turn a scanner job into what the page shows."""
    r = rank_map().get(j["id"])
    if r is None:  # listings from web search / local sites are scored on the fly
        jj = dict(j)
        ce = (cache if cache is not None else desc_cache()).get(j["id"], {})
        if ce.get("enr") and not jj.get("enr"):
            jj["enr"] = ce["enr"]
        sc, flags, hidden = ats_scan.rank(jj, rej if rej is not None else rejection_data())
        r = (sc, flags, hidden, jj.get("enr") or {})
    sc, flags, hidden, enr = r
    m = HUB["marks"].get(j["id"], {})
    return {
        "id": j["id"], "title": (j.get("title") or "").strip(), "employer": j.get("employer", ""),
        "loc": j.get("loc", ""), "url": j.get("url", ""), "posted": j.get("posted", ""),
        "first_seen": j.get("first_seen", ""), "score": sc, "flags": flags, "hidden": hidden,
        "remote": bool(re.search(r"remote|anywhere", f"{j.get('loc','')} {j.get('remote','')}", re.I)),
        "dept": j.get("dept", ""), "open": j.get("open", True), "link_ok": j.get("link_ok"),
        "pay": [enr.get("pay_min"), enr.get("pay_max")] if enr.get("pay_max") else None,
        "years": enr.get("years") or 0, "mark": m, "source": "scan",
        "via": j.get("via") or "board", "group": VIA_GROUP.get(j.get("via") or "board", "large"), "source_name": j.get("source_name", ""), "blurb": blurb_for(j["id"]),
    }


def manual_view(mj):
    m = HUB["marks"].get(mj["id"], {})
    return {
        "id": mj["id"], "title": mj.get("title", ""), "employer": mj.get("employer", ""), "loc": mj.get("loc", ""),
        "url": mj.get("url", ""), "posted": "", "first_seen": mj.get("added", ""), "score": mj.get("score"),
        "flags": mj.get("flags", []), "hidden": False, "remote": False, "dept": "", "open": True, "link_ok": None,
        "pay": mj.get("pay"), "years": 0, "mark": m, "source": "manual", "notes": mj.get("notes", ""), "via": "manual", "group": "manual", "source_name": "", "blurb": None,
        "deadline": mj.get("deadline", ""),
    }


def any_job_view(jid):
    for mj in HUB["manual_jobs"]:
        if mj["id"] == jid:
            return manual_view(mj)
    if not ats_scan:
        return None
    j = all_jobs().get(jid)
    return job_view(j, rejection_data(), desc_cache()) if j else None


# ------------------------------------------------------------------ extra sources, summaries
def keys():
    st = HUB.get("settings", {})
    return {"google_key": os.environ.get("GOOGLE_API_KEY") or st.get("google_api_key", ""),
            "google_cx": os.environ.get("GOOGLE_CSE_ID") or st.get("google_cse_id", ""),
            "anthropic_key": os.environ.get("ANTHROPIC_API_KEY") or st.get("anthropic_api_key", ""),
            "blurb_model": st.get("blurb_model", "")}


_extra_cache = {"mtime": None, "data": {"jobs": {}, "runs": [], "sources": {}}}
_blurb_cache = {"mtime": None, "data": {}}


def extras_cached():
    m = _mt(EXTRA_FILE)
    if _extra_cache["mtime"] != m:
        _extra_cache["data"] = read_json(EXTRA_FILE, {"jobs": {}, "runs": [], "sources": {}})
        _extra_cache["mtime"] = m
    return _extra_cache["data"]


def blurbs():
    m = _mt(BLURB_FILE)
    if _blurb_cache["mtime"] != m:
        _blurb_cache["data"] = read_json(BLURB_FILE, {})
        _blurb_cache["mtime"] = m
    return _blurb_cache["data"]


BLURB_VERSION = 3  # bump when the plain-extract rules change: older plain summaries are rewritten, Claude-written ones are kept


def blurb_current(b):
    return bool(b) and (b.get("by") == "ai" or b.get("v") == BLURB_VERSION)


def blurb_for(jid):
    b = blurbs().get(jid)
    return {"text": b["text"], "by": b.get("by", "auto")} if blurb_current(b) else None


def all_jobs():
    """Scanner listings plus web-search and local-site listings (their ids start with web: or loc:)."""
    jobs = dict(state_cached()["jobs"]) if ats_scan else {}
    jobs.update(extras_cached().get("jobs", {}))
    return jobs


def ensure_blurb(j, text):
    b, by = SS.make_blurb(j, text, keys(), on_error=lambda m: log_error("Summaries", m, level="warn"))
    with LOCK:
        d = read_json(BLURB_FILE, {})
        d[j["id"]] = {"text": b, "by": by, "at": today(), "v": BLURB_VERSION}
        atomic_write(BLURB_FILE, d)
    _blurb_cache["mtime"] = None
    return b


BLURB = {"running": False, "done": 0, "total": 0}
_blurb_tried = set()


def blurb_worker(ids):
    def one(jid):
        try:
            j = all_jobs().get(jid)
            if not j:
                return
            ce = desc_cache().get(jid)
            if ce is None:
                try:
                    text, pays = fetch_for(j)
                except Exception:
                    text, pays = "", []
                if text:
                    ce = store_desc(jid, j, text, pays)
            ensure_blurb(j, (ce or {}).get("text", ""))
        except Exception as e:
            log_error("Summaries", f"{type(e).__name__}: {e}", traceback.format_exc())
        finally:
            BLURB["done"] += 1
    try:
        with ThreadPoolExecutor(4) as ex:
            list(ex.map(one, ids))
    finally:
        BLURB["running"] = False


def start_blurbs(ids):
    have = blurbs()
    ids = [i for i in ids if not blurb_current(have.get(i)) and i not in _blurb_tried][:60]
    if not ids:
        return {"ok": True, "queued": 0}
    with LOCK:
        if BLURB["running"]:
            return {"ok": True, "queued": 0, "busy": True}
        BLURB.update(running=True, done=0, total=len(ids))
    _blurb_tried.update(ids)
    threading.Thread(target=blurb_worker, args=(ids,), daemon=True).start()
    return {"ok": True, "queued": len(ids)}


def merge_extra_rows(rows):
    """Add new listings and refresh known ones in extra_jobs.json. Returns the number of new ones."""
    new, t = 0, today()
    with LOCK:
        d = read_json(EXTRA_FILE, {"jobs": {}, "runs": [], "sources": {}})
        seen_urls = {j.get("url") for j in state_cached()["jobs"].values()} if ats_scan else set()
        for r in rows:
            if r["url"] in seen_urls:
                continue  # an employer board already has it
            old = d["jobs"].get(r["id"])
            if old:
                for k in ("title", "url", "snippet", "loc"):
                    if r.get(k):
                        old[k] = r[k]
                old["last_seen"], old["open"] = t, True
            else:
                r.update(first_seen=t, last_seen=t, decision="", reason="", open=True)
                d["jobs"][r["id"]] = r
                new += 1
        atomic_write(EXTRA_FILE, d)
    _extra_cache["mtime"] = None
    return new


def age_out_web():
    cut = (datetime.now() - timedelta(days=21)).strftime("%Y-%m-%d")
    with LOCK:
        d = read_json(EXTRA_FILE, {"jobs": {}, "runs": [], "sources": {}})
        for j in d["jobs"].values():
            if j.get("via") == "web" and (j.get("last_seen") or "") < cut:
                j["open"] = False
        atomic_write(EXTRA_FILE, d)
    _extra_cache["mtime"] = None


def _board_hit_ok(url):
    """Keep LinkedIn and Indeed hits that are job pages or job searches; drop people, company and advice pages."""
    u = urllib.parse.urlparse(url or "")
    host, path = u.netloc.lower(), u.path.lower()
    if host.endswith("linkedin.com"):
        return path.startswith(("/jobs", "/comm/jobs")) and "/in/" not in path
    if host.endswith("indeed.com"):
        return not path.startswith(("/cmp", "/career-advice", "/career/", "/q-")) or path.startswith("/q-") and "jobs" in path
    return True


def run_web_layer(W, q, track):
    k = keys()
    queries = []
    for query, label in SS.build_queries(W, q, track, max_queries=4):  # web search is really LinkedIn and Indeed
        queries.append((query + " site:linkedin.com/jobs", label))
        queries.append((query + " site:indeed.com", label))
    rows, errs, engine = [], [], "web"
    for query, label in queries:
        (res, err), engine = SS.web_search(query, k)
        if err:
            errs.append(err)
        rows += [r0 for r0 in SS.web_rows(res, label, today(), W) if _board_hit_ok(r0["url"])]
        time.sleep(0.8)  # be polite to the search engine
    rows = list({r["id"]: r for r in rows}.values())
    if errs and not rows:
        log_error("Web search", errs[0], level="warn")
    new = merge_extra_rows(rows)
    age_out_web()
    with LOCK:
        d = read_json(EXTRA_FILE, {"jobs": {}, "runs": [], "sources": {}})
        d.setdefault("sources", {})["Web search (" + engine + ")"] = {"found": len(rows), "note": (errs[0] if errs and not rows else f"{len(queries)} searches"), "at": today(), "city": "", "url": ""}
        atomic_write(EXTRA_FILE, d)
    _extra_cache["mtime"] = None
    if rows or not errs:
        mark_checked({"LinkedIn Jobs", "LinkedIn", "Indeed"}, ("board",), today())
    return f"LinkedIn and Indeed through web search ({engine}): {len(rows)} job-like results, {new} new" + (f". Problem: {errs[0]}" if errs and not rows else "")


def all_local_sources():
    """Local sites = Resources of kind 'local' (they live under Employers and Resources > Local-Specific Job Resources)."""
    srcs = []
    for r in HUB.get("resources", []):
        u = r.get("url") or ""
        if r.get("kind") == "local" and u.startswith("http") and r.get("scan", True):
            srcs.append({"city": r.get("city", ""), "name": r["name"], "url": u, "kind": r.get("fetch") or "auto", "slug": r.get("slug", ""), "region": r.get("region", ""), "from": "resources"})
    return srcs


def run_local_layer(W):
    chosen = SS.sources_for(W, all_local_sources())
    if not chosen:
        return "Local employers: none listed for these places yet (Employers and Resources > Local-Specific Job Resources has Find local sites)"
    t = today()

    def one(src):
        try:
            return src, SS.fetch_local_source(src, t, ats_scan)
        except Exception as e:
            return src, ([], f"error ({type(e).__name__})")
    rows_all, stats = [], {}
    with ThreadPoolExecutor(6) as ex:
        for src, (rows, note) in ex.map(one, chosen):
            rows_all += [r for r in rows if not W.excluded(r.get("loc", "") + " " + r.get("title", ""))]
            stats[src["name"]] = {"found": len(rows), "note": note, "at": t, "city": src.get("city", ""), "url": src.get("url", "")}
    for nm, st0 in stats.items():
        if st0["note"].startswith(("could not load", "error")):
            log_error("Local employer", f"{nm}: {st0['note']}", level="warn")
    new = merge_extra_rows(rows_all)
    close_gone(stats, ("local",), t)
    ok = sum(1 for v in stats.values() if v["found"])
    return f"Local employers: {len(chosen)} checked, {ok} gave listings, {len(rows_all)} entries, {new} new"


def _host(u):
    return re.sub(r"^www\.", "", urllib.parse.urlparse(u or "").netloc.lower())


def _site_ok(r, url):
    """A web hit counts for an employer only when it is on that employer's own site."""
    h, rh = _host(url), _host(r.get("url") if (r.get("url") or "").startswith("http") else "")
    if rh:
        parts = rh.split(".")
        base = ".".join(parts[-3:] if ".".join(parts[-2:]) in ("co.uk", "org.uk", "com.au", "ac.uk") else parts[-2:])
        return h.endswith(base)
    tok = re.sub(r"[^a-z0-9]", "", ((r.get("name") or "").lower().split() or [""])[0])
    return len(tok) >= 4 and tok in h


def mark_checked(names, kinds, t, how="search"):
    """A page the search reached counts as checked today, the same as ticking Checked today by hand."""
    hit = False
    for r in HUB.get("resources", []):
        if r.get("name") in names and r.get("kind") in kinds:
            r["last_checked"], r["checked_by"] = t, how
            hit = True
    if hit:
        try:
            save_hub()
        except Exception as e:
            log_error("Checked marks", f"{type(e).__name__}: {e}", level="warn")


def close_gone(stats, vias, t):
    """A site that answered with listings but no longer shows one of ours means that listing closed."""
    reached = {n for n, s in stats.items() if not str(s.get("note", "")).startswith(("could not load", "error", "no link saved"))}
    mark_checked(reached, ("board", "local", "large", "small"), t)
    with LOCK:
        d = read_json(EXTRA_FILE, {"jobs": {}, "runs": [], "sources": {}})
        d.setdefault("sources", {}).update(stats)
        for j in d["jobs"].values():
            st = stats.get(j.get("source_name"))
            if j.get("via") in vias and st and st["found"] and j.get("last_seen") != t:
                j["open"] = False
        atomic_write(EXTRA_FILE, d)
    _extra_cache["mtime"] = None


def run_resource_layer(kind, W, label):
    """Check the pages of Resources of one kind (board / large / small). Pages that give nothing are tried through a web search
    limited to that employer's own site."""
    via, t = LAYER_VIA[kind], today()
    res = [r for r in HUB["resources"] if r.get("kind") == kind and r.get("scan", True)]
    if not res:
        return f"{label}: none listed"
    with_url = [r for r in res if (r.get("url") or "").startswith("http")]

    def one(r):
        try:
            src = {"city": "", "name": r["name"], "url": r["url"], "kind": r.get("fetch") or "auto", "slug": r.get("slug", "")}
            rows, note = SS.fetch_local_source(src, t, ats_scan)
            return r, rows, note
        except Exception as e:
            return r, [], f"error ({type(e).__name__})"

    done = {}
    with ThreadPoolExecutor(6) as ex:
        for r, rows, note in ex.map(one, with_url):
            done[r["id"]] = (rows, note)
    places = [x.text for x in W.inc if x.kind == "text"][:2] or ["United States"] if kind != "board" else []
    budget, web_fails, rows_all, stats = 24, 0, [], {}
    for r in res:
        rows, note = done.get(r["id"], ([], "no link saved"))
        page_n = len(rows)
        if kind != "board" and not rows and budget > 0:  # page needs a browser, or no link saved: look for the employer's own postings
            for place in places:
                if budget <= 0:
                    break
                budget -= 1
                (hits, err), _eng = SS.web_search(f'{r["name"]} careers jobs {place}', keys(), 8)
                if err and not hits:
                    note = (note + "; " if note else "") + "web search: " + str(err)[:60]
                    web_fails += 1
                    if web_fails >= 3:  # the search engine is refusing us: stop asking for the rest of this run
                        budget = 0
                        log_error(label, "Web search backup stopped after 3 failed searches in a row: " + str(err)[:120], level="warn")
                hits = [h0 for h0 in hits if _site_ok(r, h0.get("url", ""))]
                rows += SS.web_rows(hits, place, t, W)
                time.sleep(0.8)
            if rows:
                note = f"{len(rows)} via web search on their own site"
        for i, x in enumerate(rows):
            x["via"], x["source_name"] = via, r["name"]
            if kind != "board" and i >= page_n:  # found through web search on the employer's own site
                x["employer"] = r["name"]
            if (x.get("loc") or "").strip() in ("(local site)", "(from search)"):
                x["loc"] = ""
        rows = [x for x in rows if not W.excluded((x.get("loc") or "") + " " + x.get("title", ""))]
        rows_all += rows
        stats[r["name"]] = {"found": len(rows), "note": note, "at": t, "city": "", "url": r.get("url", ""), "kind": kind}
    for nm, st0 in stats.items():
        if st0["note"].startswith(("could not load", "error")):
            log_error(label, f"{nm}: {st0['note']}", level="warn")
    new = merge_extra_rows(rows_all)
    close_gone(stats, (via,), t)
    ok = sum(1 for v in stats.values() if v["found"])
    return f"{label}: {len(res)} checked, {ok} gave listings, {len(rows_all)} entries, {new} new"


# ------------------------------------------------------------------ search
def kw_tokens(q):
    return [t for t in re.split(r"[\s,;]+", (q or "").lower()) if len(t) > 1]


def search_jobs(p):
    rej = rejection_data()
    cache = desc_cache()
    W = SS.Where(p.get("city"))
    remote_mode = p.get("remote") or "include"  # include | only | exclude
    src = p.get("src") or "all"  # all | jobboard | local | large | small
    toks = kw_tokens(p.get("q"))
    track_rx = re.compile(TRACKS[p["track"]], re.I) if p.get("track") in TRACKS else None
    min_score = int(p.get("min") or -99)
    show = p.get("show") or "undecided"  # undecided | saved | declined | applied | all
    show_hidden = p.get("hidden") == "1"
    sort = p.get("sort") or "fit"
    out, by_src = [], {"jobboard": 0, "local": 0, "large": 0, "small": 0}
    for j in all_jobs().values():
        if not j.get("open", True):
            continue
        via = j.get("via") or "board"
        grp = VIA_GROUP.get(via, "large")
        if src != "all" and grp != src:
            continue
        loc = f"{j.get('loc','')} {j.get('remote','')}"
        is_remote = SS.is_remote_text(loc)
        if W.excluded(loc, is_remote):
            continue
        in_city = W.include_hit(loc, is_remote) if W.inc else True
        if remote_mode == "only":
            if not is_remote:
                continue
        elif remote_mode == "exclude":
            if is_remote and not in_city:
                continue
            if not in_city:
                continue
        elif W.inc and not (in_city or is_remote):
            continue
        # nothing chosen = anywhere in the US and EU; remote roles tied to some other region are dropped
        if (not W.inc or (is_remote and not in_city)) and SS.region_of(loc) not in ("US", "EU", ""):
            continue
        hay = f"{j.get('title','')} {j.get('dept','')} {j.get('employer','')}".lower()
        if toks and not any(t in hay for t in toks):
            continue
        if track_rx and not track_rx.search(hay):
            continue
        v = job_view(j, rej, cache)
        state = v["mark"].get("state") or j.get("decision") or ""
        if state == "snoozed":
            state = "saved"
        if show == "undecided" and state:
            continue
        if show in ("saved", "declined", "applied") and state != show:
            continue
        if v["hidden"] and not show_hidden:
            continue
        sc = v["score"] + 2 * sum(1 for t in toks if t in hay)
        if W.inc and in_city:
            sc += 1
        v["score"] = sc
        v["in_city"] = in_city
        if sc < min_score:
            continue
        out.append(v)
        by_src[grp] += 1
    first = (lambda v: 0 if v.get("in_city") else 1) if W.inc else (lambda v: 0)
    if sort == "new":
        out.sort(key=lambda v: (first(v), [-ord(c) for c in v["first_seen"]], -v["score"]))
    elif sort == "posted":
        out.sort(key=lambda v: (first(v), [-ord(c) for c in (v["posted"] or "")], -v["score"]))
    else:
        out.sort(key=lambda v: (first(v), -v["score"], v["title"]))
    total = len(out)
    in_city_n = sum(1 for v in out if v.get("in_city")) if W.inc else None
    off = int(p.get("offset") or 0)
    lim = min(int(p.get("limit") or 25), 100)
    return {"total": total, "in_city": in_city_n, "jobs": out[off:off + lim], "offset": off, "where": W.describe(), "by_source": by_src}


# ------------------------------------------------------------------ job detail (description on demand)
def html_to_text(h):
    h = htmllib.unescape(h or "")
    h = re.sub(r"(?i)<\s*(script|style)[^>]*>.*?<\s*/\s*\1\s*>", " ", h, flags=re.S)
    h = re.sub(r"(?i)<\s*li[^>]*>", "\n• ", h)
    h = re.sub(r"(?i)<\s*/\s*(p|div|h[1-6]|ul|ol|tr)\s*>|<\s*br\s*/?\s*>", "\n", h)
    h = re.sub(r"<[^>]+>", " ", h)
    h = htmllib.unescape(h)
    h = re.sub(r"[ \t\r\f\v]+", " ", h)
    h = re.sub(r" ?\n ?", "\n", h)
    return re.sub(r"\n{3,}", "\n\n", h).strip()


def fetch_rich(j):
    """Like the scanner's fetch_desc, but keeps paragraph breaks so it reads well on screen."""
    kind, slug, jid = j["id"].split(":", 2)
    A = ats_scan
    if kind == "gh":
        d = A.jget(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}?pay_transparency=true") or {}
        pays = [(p.get("min_cents", 0) // 100, p.get("max_cents", 0) // 100) for p in (d.get("pay_input_ranges") or [])]
        return html_to_text(d.get("content", "")), pays
    if kind == "lv":
        d = A.jget(f"https://api.lever.co/v0/postings/{slug}/{jid}") or {}
        sr = d.get("salaryRange") or {}
        pays = [(sr["min"], sr["max"])] if sr.get("min") and str(sr.get("interval", "")).startswith("per-year") else []
        text = d.get("descriptionPlain", "") or html_to_text(d.get("description", ""))
        for x in d.get("lists", []):
            text += "\n\n" + x.get("text", "") + "\n" + html_to_text(x.get("content", ""))
        return text.strip(), pays
    if kind == "ab":
        d = A.jget(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true") or {}
        for x in d.get("jobs", []):
            if x.get("id") == jid:
                return (x.get("descriptionPlain") or html_to_text(x.get("descriptionHtml", ""))), []
    if kind == "wd":
        m = re.match(r"https://([^.]+)\.(wd\d+)\.myworkdayjobs\.com/([^/]+)(/job/.*)", j.get("url", ""))
        if m:
            d = A.jget(f"https://{m[1]}.{m[2]}.myworkdayjobs.com/wday/cxs/{m[1]}/{m[3]}{m[4]}") or {}
            return html_to_text((d.get("jobPostingInfo") or {}).get("jobDescription", "")), []
    return A.fetch_desc(j)


def enrich_text(text, pays):
    """Same signals as the scanner's enrich step: pay, years asked, clearance, people-management."""
    t = text.lower()
    e = {"dscore": min(4, sum(w for rx, w in ats_scan.DPOS if re.search(rx, text, re.I)))}
    e["clearance"] = bool(re.search(r"ts/sci|secret clearance|(active|current|must (hold|have|obtain)|ability to obtain|requires?)[^.]{0,40}clearance", t)) and not re.search(r"clearance required\s*:\s*none", t)
    e["mgmt"] = bool(re.search(r"direct reports|people management|manage a team|supervise|lead a team|manage and mentor", t))
    ys = [int(x) for x in re.findall(r"(\d{1,2})\+?\s*(?:or more )?(?:\+\s*)?years", t) if 0 < int(x) < 20]
    e["years"] = max(ys) if ys else 0
    if not pays:
        nums = [int(x.replace(",", "")) for x in re.findall(r"\$\s?(\d{2,3}(?:,\d{3}))", text)]
        if nums:
            pays = [(min(nums), max(nums))]
    if pays:
        e["pay_min"], e["pay_max"] = min(p[0] for p in pays), max(p[1] for p in pays)
    return e


def fetch_for(j):
    """Description text and pay ranges for any listing: employer-board API, or the page itself for web / local rows."""
    if (j.get("id") or "").startswith(("web:", "loc:")):
        st, _, body, err = SS.http_get(j.get("url", ""))
        text = SS.page_text(body) if st == 200 and body else ""
        if len(text) < 200 and j.get("snippet"):
            text = (text + "\n\n" + j["snippet"]).strip()
        if not text:
            raise ValueError(err or f"HTTP {st}")
        return text, []
    return fetch_rich(j)


def store_desc(jid, j, text, pays):
    ce = {"text": text[:12000], "enr": enrich_text(text, pays), "fetched": today()}
    with LOCK:
        cache = desc_cache()
        cache[jid] = ce
        atomic_write(CACHE_FILE, cache)
        jj = dict(j)
        jj["enr"] = ce["enr"]
        rk = ats_scan.rank(jj, rejection_data())
        if _rank["key"] is not None:  # update just this listing instead of re-scoring everything
            _rank["map"][jid] = (rk[0], rk[1], rk[2], ce["enr"])
            _rank["key"] = (_mt(ats_scan.STATE), _mt(ats_scan.REJ), _mt(CACHE_FILE))
    return ce


def job_detail(jid):
    v = any_job_view(jid)
    if not v:
        return None
    if v["source"] == "manual":
        return {"job": v, "description": None, "note": v.get("notes", "")}
    j = all_jobs().get(jid)
    ce = desc_cache().get(jid)
    if not ce:
        try:
            text, pays = fetch_for(j)
        except Exception as e:
            log_error("Job details", f"Could not load the description for {j.get('employer','')}: {j.get('title','')} ({type(e).__name__}: {e})", level="warn")
            if j.get("snippet") and not blurb_for(jid):
                ensure_blurb(j, "")
            return {"job": any_job_view(jid), "description": None, "error": f"Could not load the description ({type(e).__name__}). Use Open original."}
        if not text:
            return {"job": v, "description": None, "error": "This employer's page did not give a readable description. Use Open original."}
        ce = store_desc(jid, j, text, pays)
        v = any_job_view(jid)
    if not blurb_for(jid):
        ensure_blurb(j, ce["text"])
        v = any_job_view(jid)
    return {"job": v, "description": ce["text"]}


# ------------------------------------------------------------------ today
def week_days(n=7):
    base = datetime.now()
    return [(base - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n - 1, -1, -1)]


def group_of(status):
    if status in OPEN_STATUSES:
        return "open"
    if status in WAIT_STATUSES:
        return "waitlist"
    return "closed"


def build_today():
    t = today()
    apps = HUB["applications"]
    queue = []
    for jid, m in HUB["marks"].items():
        if m.get("state") not in ("saved", "snoozed"):
            continue
        v = any_job_view(jid)
        if not v:
            continue
        v["carried"] = bool(m.get("saved_for") and m["saved_for"] < t)
        v["snoozed"] = bool(m.get("saved_for") and m["saved_for"] > t)
        queue.append(v)
    queue.sort(key=lambda v: (v["snoozed"], v["mark"].get("order", 50), v.get("deadline") or "9999", v["mark"].get("saved_on", "")))
    later = []
    for jid, m in HUB["marks"].items():
        if m.get("state") == "later":
            v = any_job_view(jid)
            if v:
                later.append(v)
    later.sort(key=lambda v: (v.get("deadline") or "9999", v["mark"].get("saved_on", "")))
    applied_today = [a for a in apps if a.get("date_applied") == t and a.get("status") not in ("Watching", "Waitlisted")]
    s = HUB["settings"]
    since = s.get("reminder_since", t)
    count_since = sum(1 for a in apps if (a.get("date_applied") or "") >= since and a.get("status") in OPEN_STATUSES + ("Rejected", "Withdrawn", "Waitlisted"))
    reminder = None
    snooze = s.get("reminder_snooze_until") or ""
    if count_since >= s.get("reminder_after", 5) and not s.get("reminder_dismissed") and not (snooze and snooze > t):
        reminder = {"count": count_since, "text": "You have submitted " + str(count_since) + " applications since " + since + ". Time to decide whether to turn on the daily scan (see How it works)."}
    # fresh finds: best undecided listings from the most recent scan date, in the default city
    fresh, fresh_date = [], ""
    if ats_scan:
        st = state_cached()
        dates = sorted({j.get("first_seen", "") for j in st["jobs"].values()})
        fresh_date = dates[-1] if dates else ""
        city = s.get("default_city", "")
        res = search_jobs({"city": city, "remote": "include", "min": "3", "sort": "fit", "limit": "40"})
        fresh = [v for v in res["jobs"] if v["first_seen"] >= (dates[-2] if len(dates) > 1 else fresh_date)][:8]
        if len(fresh) < 8:
            fresh = res["jobs"][:8]
    deadlines = []
    past = lambda d: bool(re.match(r"\d{4}-\d{2}-\d{2}", d or "")) and d[:10] < t  # a date that has gone by drops off Coming up
    for a in apps:
        if a.get("deadline") and not past(a["deadline"]) and a.get("status") not in ("Rejected", "Withdrawn", "Applied", "Interview", "Offer"):
            deadlines.append({"label": f"{a.get('org','')}: {a.get('role','')}", "date": a["deadline"]})
    for v in queue + later:
        if v.get("deadline") and not past(v["deadline"]):
            deadlines.append({"label": f"{v['employer']}: {v['title']}", "date": v["deadline"]})
    deadlines.sort(key=lambda d: d["date"])
    bridging = [b for b in HUB["goals"]["bridging"] if not b.get("done")]
    bridging.sort(key=lambda b: (0 if "HIGHEST" in (b.get("notes") or "") else 1))
    days = week_days(7)
    per_day = {d: sum(1 for a in apps if a.get("date_applied") == d and a.get("status") not in ("Watching",)) for d in days}
    counts = {"open": 0, "waitlist": 0, "closed": 0}
    for a in apps:
        counts[group_of(a.get("status"))] += 1
    todos = HUB["todos"]
    tasks_now = [dict(x, carried=x.get("due", t) < t) for x in todos if not x.get("done") and x.get("due", t) <= t]
    tasks_now.sort(key=lambda x: (x.get("due", t), x.get("created", "")))
    tasks_done = [x for x in todos if x.get("done") and x.get("done_on") == t]
    tasks_later = sorted([x for x in todos if not x.get("done") and x.get("due", t) > t], key=lambda x: (x["due"], x.get("created", "")))
    notes_now = [n for n in HUB["notes"] if n.get("for", t) <= t and not n.get("dismissed") and (n.get("text") or "").strip()]
    tmr = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    note_tomorrow = next((n for n in HUB["notes"] if n.get("for") == tmr and not n.get("dismissed")), None)
    return {
        "tasks_now": tasks_now, "tasks_done": tasks_done, "tasks_later": tasks_later, "notes_now": notes_now,
        "note_tomorrow": note_tomorrow, "tomorrow": tmr,
        "date": t, "goal": s.get("daily_goal", 3), "applied_today": len(applied_today),
        "queue": queue, "later": later, "fresh": fresh, "fresh_date": fresh_date, "deadlines": deadlines[:6],
        "bridging": bridging[:3], "week": [{"date": d, "n": per_day[d]} for d in days], "counts": counts,
        "reminder": reminder, "scanner": scanner_info(), "errors_new": errors_new(),
    }


def scanner_info():
    st = state_cached() if ats_scan else {"jobs": {}, "runs": []}
    emp = read_json(ats_scan.EMP, {"boards": []}) if ats_scan else {"boards": []}
    runs = st.get("runs", [])
    k = keys()
    return {"available": bool(ats_scan), "jobs": len(st["jobs"]) + len(extras_cached().get("jobs", {})), "boards": len(emp.get("boards", [])),
            "last_run": runs[-1]["date"] if runs else "", "scan": dict(SCAN), "dir": SCAN_DIR,
            "web_engine": "Google" if k["google_key"] and k["google_cx"] else "DuckDuckGo", "ai_blurbs": bool(k["anthropic_key"]),
            "local_sites": len(all_local_sources()),
            "counts": {kd: sum(1 for r in HUB["resources"] if r.get("kind") == kd) for kd in ("board", "local", "large", "small")},
            "small_last": HUB["settings"].get("small_last_check", ""), "small_auto": HUB["settings"].get("small_auto", True)}


# ------------------------------------------------------------------ actions
def do_mark(body):
    jid, state = body["id"], body.get("state")
    with LOCK:
        if state == "clear" and jid.startswith("man:"):
            # a job you typed in has no other home, so taking it off the plan files it under Later instead of losing it
            HUB["marks"][jid] = {"state": "later", "saved_on": today(), "saved_for": "", "updated": today(), "order": 50}
        elif state == "clear":
            HUB["marks"].pop(jid, None)
        else:
            m = HUB["marks"].get(jid, {})
            m["state"] = state
            m["updated"] = today()
            if state == "saved":
                m["saved_on"] = m.get("saved_on") or today()
                m["saved_for"] = body.get("saved_for") or today()
                m.pop("reason", None)
            if state == "snoozed":
                m["saved_for"] = body.get("saved_for") or (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
            if state == "later":  # kept on file, not in any day's plan until you pull it in
                m["saved_on"] = m.get("saved_on") or today()
                m["saved_for"] = ""
                m.pop("reason", None)
            if state == "declined":
                m["reason"] = body.get("reason", "")
            HUB["marks"][jid] = m
        v = any_job_view(jid)
        log("mark", f"{state}: {v['employer'] + ' - ' + v['title'] if v else jid}")
        save_hub()
    sync_marks_to_state()
    return {"ok": True}


def do_apply(body):
    v = any_job_view(body["id"])
    if not v:
        raise ValueError("Unknown listing")
    with LOCK:
        tks = [t for t in (body.get("tracks") or ([body["track"]] if body.get("track") else [])) if isinstance(t, str)][:6]
        rec = {"id": new_id("app_"), "org": v["employer"], "role": v["title"], "track": (tks or [""])[0], "tracks": tks,
               "status": body.get("status", "Applied"), "date_applied": body.get("date") or today(),
               "deadline": "", "notes": body.get("notes", ""), "priority": "", "resume": body.get("resume", ""),
               "url": v["url"], "job_id": v["id"], "updated": today()}
        HUB["applications"].append(rec)
        HUB["marks"][v["id"]] = {"state": "applied", "updated": today(), "app_id": rec["id"]}
        log("apply", f"Applied: {rec['org']} - {rec['role']}")
        save_hub()
        sync_rejected()
    sync_marks_to_state()
    return {"ok": True, "record": rec}


def do_manual(body):
    mj = {"id": new_id("man:"), "title": body.get("title", "").strip(), "employer": body.get("employer", "").strip(),
          "loc": body.get("loc", ""), "url": body.get("url", ""), "notes": body.get("notes", ""),
          "deadline": body.get("deadline", ""), "flags": body.get("flags", []), "added": today()}
    if not mj["title"] or not mj["employer"]:
        raise ValueError("A job needs a title and an organization.")
    with LOCK:
        HUB["manual_jobs"].append(mj)
        when = body.get("when") or ("today" if body.get("save", True) else "later")
        tmr = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        if when == "today":
            HUB["marks"][mj["id"]] = {"state": "saved", "saved_on": today(), "saved_for": today(), "updated": today(), "order": 50}
        elif when == "tomorrow":
            HUB["marks"][mj["id"]] = {"state": "snoozed", "saved_on": today(), "saved_for": tmr, "updated": today(), "order": 50}
        else:
            HUB["marks"][mj["id"]] = {"state": "later", "saved_on": today(), "saved_for": "", "updated": today(), "order": 50}
        log("manual", f"Added by hand: {mj['employer']} - {mj['title']}")
        save_hub()
    return {"ok": True, "id": mj["id"]}


def do_manual_update(body):
    with LOCK:
        for mj in HUB["manual_jobs"]:
            if mj["id"] == body.get("id"):
                for k in ("title", "employer", "loc", "url", "notes", "deadline"):
                    if k in body:
                        mj[k] = body[k]
                save_hub()
                return {"ok": True}
    raise ValueError("Unknown job")


def do_todo(b):
    op = b.get("op")
    with LOCK:
        L = HUB["todos"]
        if op == "add":
            text = (b.get("text") or "").strip()
            if not text:
                raise ValueError("Write what needs doing first")
            due = b.get("due") or today()
            L.append({"id": new_id("td_"), "text": text[:300], "note": (b.get("note") or "")[:1000], "due": due, "done": False, "created": today()})
        else:
            it = next((x for x in L if x["id"] == b.get("id")), None)
            if not it:
                raise ValueError("Unknown to-do")
            if op == "toggle":
                it["done"] = not it.get("done")
                it["done_on"] = today() if it["done"] else ""
            elif op == "edit":
                for k in ("text", "note", "due"):
                    if k in b:
                        it[k] = (b[k] or "")[:1000] if k != "due" else (b[k] or it.get("due") or today())
            elif op == "delete":
                L.remove(it)
            else:
                raise ValueError("Unknown op")
        # keep finished items for a week only
        cut = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        HUB["todos"] = [x for x in L if not (x.get("done") and (x.get("done_on") or "9999") < cut)]
        save_hub()
    return {"ok": True}


def do_note(b):
    op, t = b.get("op"), today()
    tmr = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    with LOCK:
        N = HUB["notes"]
        if op == "set_tomorrow":
            text = (b.get("text") or "")[:5000]
            n = next((x for x in N if x.get("for") == tmr and not x.get("dismissed")), None)
            if n:
                n["text"] = text
            elif text.strip():
                N.append({"id": new_id("nt_"), "text": text, "for": tmr, "created": t})
            if n and not text.strip():
                N.remove(n)
        elif op == "dismiss":
            for x in N:
                if x["id"] == b.get("id"):
                    x["dismissed"] = True
        else:
            raise ValueError("Unknown op")
        cut = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
        HUB["notes"] = [x for x in N if not (x.get("dismissed") and x.get("for", "9999") < cut)]
        save_hub()
    return {"ok": True}


def put_section(name, data):
    with LOCK:
        if name == "applications" and isinstance(data, list):
            for a in data:
                a.setdefault("id", new_id("app_"))
                a["updated"] = today()
            HUB["applications"] = data
        elif name == "resources" and isinstance(data, list):
            for r in data:
                r.setdefault("id", new_id("res_"))
            HUB["resources"] = data
        elif name == "reference" and isinstance(data, list):
            out = []
            for it in data:
                if not isinstance(it, dict):
                    raise ValueError("reference items must be objects")
                kind = it.get("kind") if it.get("kind") in ("file", "note") else "note"
                row = {"id": it.get("id") or new_id("ref_"), "kind": kind, "title": str(it.get("title", "")).strip()[:200] or "Untitled",
                       "added": str(it.get("added") or today())}
                if kind == "file":
                    f = str(it.get("file", ""))
                    if not re.fullmatch(r"reference/[A-Za-z0-9_][A-Za-z0-9_. -]*\.html?", f):
                        raise ValueError("Bad reference file: " + f)
                    row["file"] = f
                    row["desc"] = str(it.get("desc", ""))[:2000]
                else:
                    row["body"] = str(it.get("body", ""))[:20000]
                out.append(row)
            HUB["reference"] = out
        elif name == "networking" and isinstance(data, dict):
            for k, pre in (("companies", "co_"), ("people", "pe_")):
                items = data.get(k, [])
                if not isinstance(items, list):
                    raise ValueError("networking." + k + " must be a list")
                for it in items:
                    it.setdefault("id", new_id(pre))
                HUB["networking"][k] = items
        elif name == "goals" and isinstance(data, dict):
            for k in ("bridging", "people", "study"):
                for it in data.get(k, []):
                    it.setdefault("id", new_id("g_"))
                HUB["goals"][k] = data.get(k, [])
        elif name == "settings" and isinstance(data, dict):
            HUB["settings"].update(data)
        else:
            raise ValueError("Unknown section or wrong shape: " + name)
        save_hub()
        if name == "applications":
            sync_rejected()
    return {"ok": True}


# ------------------------------------------------------------------ scanning in the background
def scan_worker(city, remote, layers=None, q="", track=""):
    """Refresh. Sections: large employers (employer boards + their own pages), job boards (LinkedIn and Indeed through web search,
    plus the board pages), local employers (for the places chosen), small employers (also run on their own once a week)."""
    import argparse as ap
    layers = layers or {}
    on = lambda k: bool(layers.get(k, k != "small"))
    SCAN.update(running=True, phase="Starting", started=datetime.now().isoformat(timespec="seconds"),
                finished=None, message="", error="", city=city, new=0)
    old_chi, old_ok = ats_scan.CHI, ats_scan.LOC_OK
    msgs = []
    try:
        W = SS.Where(city)
        if on("large"):
            SCAN["phase"] = "Large employers: scanning employer job boards"
            if W.inc:  # the scanner only needs the places to keep; exclusions are applied when you search
                ats_scan.CHI = SS.Where(W.include_text())
                scan_city = W.include_text()
            else:  # nothing chosen: keep the US, the EU and remote roles
                ats_scan.LOC_OK = SS.RegionOK()
                scan_city = ""
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                ats_scan.cmd_scan(ap.Namespace(city=scan_city, remote=remote))
            out = buf.getvalue().strip()
            m = re.search(r"new (\d+)", out)
            SCAN["new"] = int(m.group(1)) if m else 0
            msgs.append("Large employers, employer job boards: " + out)
            SCAN["phase"] = "Reading descriptions of the best matches"
            with contextlib.redirect_stdout(io.StringIO()):
                ats_scan.cmd_enrich(ap.Namespace(top=20, min=3, chicago=False))
            sync_marks_to_state()
            _state_cache["mtime"] = None
            SCAN["phase"] = "Large employers: checking their own career pages"
            try:
                msgs.append(run_resource_layer("large", W, "Large employers, career pages"))
            except Exception as e:
                msgs.append(f"Large employer pages failed: {type(e).__name__}: {e}")
                log_error("Large employers", f"{type(e).__name__}: {e}", traceback.format_exc())
        if on("boards"):
            SCAN["phase"] = "Job boards: LinkedIn and Indeed through web search"
            try:
                msgs.append(run_web_layer(W, q, track))
            except Exception as e:
                msgs.append(f"Web search failed: {type(e).__name__}: {e}")
                log_error("Web search", f"{type(e).__name__}: {e}", traceback.format_exc())
            SCAN["phase"] = "Job boards: reading board pages"
            try:
                msgs.append(run_resource_layer("board", W, "Job board pages"))
            except Exception as e:
                msgs.append(f"Job board pages failed: {type(e).__name__}: {e}")
                log_error("Job boards", f"{type(e).__name__}: {e}", traceback.format_exc())
        if on("local"):
            SCAN["phase"] = "Checking local employers"
            try:
                msgs.append(run_local_layer(W))
            except Exception as e:
                msgs.append(f"Local employers failed: {type(e).__name__}: {e}")
                log_error("Local employers", f"{type(e).__name__}: {e}", traceback.format_exc())
        if on("small"):
            SCAN["phase"] = "Checking small employers"
            try:
                msgs.append(run_resource_layer("small", W, "Small employers"))
                with LOCK:
                    HUB["settings"]["small_last_check"] = datetime.now().isoformat(timespec="seconds")
            except Exception as e:
                msgs.append(f"Small employers failed: {type(e).__name__}: {e}")
                log_error("Small employers", f"{type(e).__name__}: {e}", traceback.format_exc())
        SCAN["message"] = "\n".join(msgs)
        SCAN["phase"] = "Writing short summaries"
        try:
            top = search_jobs({"city": city, "remote": "include" if remote else "exclude", "q": q, "track": track, "min": "3", "sort": "fit", "limit": "40"})
            start_blurbs([v["id"] for v in top["jobs"]])
        except Exception:
            traceback.print_exc()
        SCAN["phase"] = "Done"
    except Exception as e:
        SCAN["error"] = f"{type(e).__name__}: {e}"
        log_error("Search refresh", SCAN["error"], traceback.format_exc())
    finally:
        ats_scan.CHI, ats_scan.LOC_OK = old_chi, old_ok
        SCAN["running"] = False
        SCAN["finished"] = datetime.now().isoformat(timespec="seconds")
        with LOCK:
            log("scan", f"Refreshed for '{city or 'US + EU'}': {SCAN['message'] or SCAN['error']}"[:600])
            save_hub()


def small_due():
    s0 = HUB["settings"]
    if not s0.get("small_auto", True) or not ats_scan:
        return False
    if not any(r.get("kind") == "small" and (r.get("url") or "").startswith("http") and r.get("scan", True) for r in HUB["resources"]):
        return False
    last = s0.get("small_last_check") or ""
    try:
        return not last or (datetime.now() - datetime.fromisoformat(last)).days >= 7
    except ValueError:
        return True


def weekly_loop():
    """Small employers get their own search once a week while the Hub is open (first check about a minute after it starts)."""
    time.sleep(60)
    while True:
        try:
            if not SCAN["running"] and small_due():
                start_scan("", True, {"small": True})
        except Exception as e:
            log_error("Weekly small-employer check", f"{type(e).__name__}: {e}", traceback.format_exc())
        time.sleep(1800)


def start_scan(city, remote, layers=None, q="", track=""):
    if not ats_scan:
        raise ValueError("Scanner not found at " + SCAN_DIR)
    with LOCK:
        if SCAN["running"]:
            return {"ok": False, "error": "A refresh is already running."}
        SCAN["running"] = True
    threading.Thread(target=scan_worker, args=(city, remote, layers, q, track), daemon=True).start()
    return {"ok": True}


def sources_view(q, city, track):
    W = SS.Where(city)
    stats = extras_cached().get("sources", {})
    local = []
    for s0 in SS.sources_for(W, all_local_sources()):
        st = stats.get(s0["name"], {})
        local.append({"name": s0["name"], "city": s0.get("city", ""), "url": s0.get("url", ""), "found": st.get("found"), "note": st.get("note", ""), "at": st.get("at", ""), "from": s0.get("from", "list")})
    qs = SS.build_queries(W, q, track)
    google = SS.google_jobs_link(qs[0][0]) if qs else ""
    return {"local": local, "google_link": google, "queries": [x[0] for x in qs]}


def discover_sources(city):
    city = (city or "").strip()
    if not city:
        raise ValueError("Type a place in Where first.")
    have = {s0.get("url", "").rstrip("/") for s0 in all_local_sources()}
    seen, out = set(), []
    for query in SS.discover_queries(city):
        (res, err), _eng = SS.web_search(query, keys(), 8)
        for r in res:
            u = r.get("url", "")
            host = re.sub(r"^www\.", "", urllib.parse.urlparse(u).netloc.lower())
            if not u.startswith("http") or SS.BLOCKED.search(u) or host in seen or u.rstrip("/") in have:
                continue
            seen.add(host)
            out.append({"title": SS.clean_title(r.get("title", "")) or host, "url": u, "snippet": (r.get("snippet") or "")[:200], "city": city})
        time.sleep(0.6)
    return {"candidates": out[:14]}


def add_source(body):
    url, name, city = (body.get("url") or "").strip(), (body.get("name") or "").strip(), (body.get("city") or "").strip()
    if not url.startswith("http") or not name or not city:
        raise ValueError("A site needs a name, a place and a link starting with http.")
    with LOCK:
        if any((r.get("url") or "").rstrip("/") == url.rstrip("/") for r in HUB["resources"]):
            raise ValueError("That site is already listed.")
        HUB["resources"].append({"id": new_id("res_"), "kind": "local", "cat": RES_LABEL["local"], "city": city, "region": body.get("region", ""), "name": name, "url": url,
                                 "fetch": "auto", "note": "Found with Find local sites on " + today() + ".", "last_checked": ""})
        save_hub()
    return {"ok": True}


def discover_worker(names):
    import argparse as ap
    SCAN.update(running=True, phase="Looking up employers", started=datetime.now().isoformat(timespec="seconds"), finished=None, message="", error="", city="")
    tmp = os.path.join(DATA_DIR, "_names.txt")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(names))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ats_scan.cmd_discover(ap.Namespace(names=tmp, watch=False))
        SCAN["message"] = buf.getvalue().strip() or "No supported job board found for those names."
        SCAN["phase"] = "Done"
    except Exception as e:
        SCAN["error"] = f"{type(e).__name__}: {e}"
        log_error("Employer lookup", SCAN["error"], traceback.format_exc())
    finally:
        SCAN["running"] = False
        SCAN["finished"] = datetime.now().isoformat(timespec="seconds")


def start_discover(names):
    names = [n.strip() for n in names if n.strip()]
    if not names:
        raise ValueError("Enter at least one employer name.")
    with LOCK:
        if SCAN["running"]:
            return {"ok": False, "error": "A refresh is already running."}
        SCAN["running"] = True
    threading.Thread(target=discover_worker, args=(names,), daemon=True).start()
    return {"ok": True}


# ------------------------------------------------------------------ http
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon"}


class NoEndpoint(Exception):
    """Unknown URL. (A KeyError from a handler is a bad request, not a missing page, and is logged as such.)"""


class Handler(BaseHTTPRequestHandler):
    server_version = "DailyHub/1"

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            return
        sys.stderr.write("[hub] " + fmt % args + "\n")

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # the browser tab was closed or reloaded mid-answer; nothing to report

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("127.0.0.1", "localhost", "[::1]")

    def _api(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path
        body = {}
        if method in ("POST", "PUT"):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            body = json.loads(raw or b"{}")
        if method == "GET":
            if path == "/api/hub":
                with LOCK:
                    out = {k: v for k, v in HUB.items() if k not in ("activity", "manual_jobs")}
                    out["settings"] = {k: v for k, v in HUB["settings"].items() if k not in SECRET_KEYS}
                    kk = keys()
                    out["settings"]["has_google"] = bool(kk["google_key"] and kk["google_cx"])
                    out["settings"]["has_ai"] = bool(kk["anthropic_key"])
                    return out
            if path == "/api/ping":
                return {"hub": True}
            if path == "/api/today":
                return build_today()
            if path == "/api/jobs":
                return search_jobs(q)
            if path == "/api/job":
                d = job_detail(q.get("id", ""))
                if d is None:
                    raise ValueError("Unknown listing")
                return d
            if path == "/api/errors":
                d = _err_load()
                return {"items": d["items"][::-1], "new": errors_new(), "file": ERR_FILE}
            if path == "/api/errors/count":
                return {"new": errors_new()}
            if path == "/api/res/status":
                return {"src_stats": extras_cached().get("sources", {}), "small_last": HUB["settings"].get("small_last_check", ""), "small_auto": HUB["settings"].get("small_auto", True)}
            if path == "/api/sources":
                return sources_view(q.get("q", ""), q.get("city", ""), q.get("track", ""))
            if path == "/api/blurbs/status":
                return {"blurb": dict(BLURB)}
            if path == "/api/scan/status":
                return {"scan": dict(SCAN), "info": scanner_info()}
            if path == "/api/boards":
                emp = read_json(ats_scan.EMP, {"boards": []}) if ats_scan else {"boards": []}
                return {"boards": [{"name": b["name"], "ats": b["ats"], "n": b.get("n", 0), "watch": bool(b.get("watch"))} for b in emp.get("boards", [])]}
            if path == "/api/activity":
                return {"activity": HUB["activity"][-60:][::-1]}
            raise NoEndpoint(path)
        if path == "/api/customization":
            return do_custom(body)
        if path == "/api/errors/resolve":
            return resolve_error(str(body.get("id", "")), str(body.get("status", "")), body.get("note", ""))
        if path == "/api/todo":
            return do_todo(body)
        if path == "/api/note":
            return do_note(body)
        if path == "/api/quit":
            threading.Timer(0.3, lambda: os._exit(0)).start()
            return {"ok": True}
        if path == "/api/mark":
            return do_mark(body)
        if path == "/api/apply":
            return do_apply(body)
        if path == "/api/manual/update":
            return do_manual_update(body)
        if path == "/api/manual":
            return do_manual(body)
        if path == "/api/scan":
            return start_scan(body.get("city", ""), bool(body.get("remote", True)), body.get("layers") or {}, body.get("q", ""), body.get("track", ""))
        if path == "/api/errors/log":
            log_error(str(body.get("area") or "page")[:80], body.get("message") or "Unknown error", body.get("detail") or "", "warn" if body.get("level") == "warn" else "error", "page")
            return {"ok": True}
        if path == "/api/errors/seen":
            with _err_lock:
                d = _err_load()
                d["seen"] = datetime.now().isoformat(timespec="seconds")
                atomic_write(ERR_FILE, d)
            return {"ok": True}
        if path == "/api/errors/clear":
            with _err_lock:
                atomic_write(ERR_FILE, {"items": [], "seen": datetime.now().isoformat(timespec="seconds")})
            return {"ok": True}
        if path == "/api/blurbs":
            return start_blurbs([x for x in body.get("ids", []) if isinstance(x, str)])
        if path == "/api/sources/discover":
            return discover_sources(body.get("city", ""))
        if path == "/api/source/add":
            return add_source(body)
        if path == "/api/discover":
            return start_discover(body.get("names", []))
        if path.startswith("/api/hub/") and method == "PUT":
            return put_section(path.rsplit("/", 1)[1], body)
        raise NoEndpoint(path)

    def _handle(self, method):
        if not self._host_ok():
            return self._send(403, {"error": "Bad host"})
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            if method != "GET" and self.headers.get("X-Hub") != "1":
                return self._send(403, {"error": "Missing header"})
            try:
                return self._send(200, self._api(method))
            except NoEndpoint:
                return self._send(404, {"error": "No such endpoint"})
            except (ValueError, KeyError, json.JSONDecodeError) as e:
                if not u.path.startswith("/api/errors"):
                    log_error("request " + u.path, f"{type(e).__name__}: {e}", level="warn")
                return self._send(400, {"error": str(e)})
            except Exception as e:
                tb = traceback.format_exc()
                traceback.print_exc()
                log_error("request " + u.path, f"{type(e).__name__}: {e}", tb)
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})
        rel = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
        fp = os.path.abspath(os.path.join(STATIC, rel))
        if not fp.startswith(os.path.abspath(STATIC) + os.sep) or not os.path.isfile(fp):
            return self._send(404, "Not found", "text/plain")
        with open(fp, "rb") as f:
            data = f.read()
        self._send(200, data, MIME.get(os.path.splitext(fp)[1], "application/octet-stream"))

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    os.makedirs(DATA_DIR, exist_ok=True)
    load_hub()
    if IMPORT_ERROR[0]:
        log_error("startup", IMPORT_ERROR[0])
    sync_marks_to_state()
    if ats_scan:
        threading.Thread(target=rank_map, daemon=True).start()  # warm the score cache so the first page load is fast
    threading.Thread(target=weekly_loop, daemon=True).start()
    for port in range(a.port, a.port + 15):  # already running? just open it
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.6) as r:
                if json.load(r).get("hub"):
                    print(f"Daily Hub is already running at http://127.0.0.1:{port}/ - opening it.")
                    if not a.no_open:
                        webbrowser.open(f"http://127.0.0.1:{port}/")
                    return
        except Exception:
            pass
    srv = None
    for port in range(a.port, a.port + 15):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if not srv:
        sys.exit("No free port found near " + str(a.port))
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    print(f"Daily Hub is running at {url}")
    print(f"Scanner folder: {SCAN_DIR}" + ("" if ats_scan else "  (NOT FOUND: search refresh is off)"))
    print("Press Ctrl+C in this window to stop it.")
    if not a.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
