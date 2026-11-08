#!/usr/bin/env python3
"""Search layers for the Daily Hub (standard library only).

  * Where: parse "New York, London, -Remote" into include / exclude terms, and
    default to "anywhere in the US and EU" when nothing is included.
  * Web layer: a general web search (Google Programmable Search if a key is set,
    otherwise DuckDuckGo's HTML results) turned into job rows.
  * Local layer: city-specific job sites (data/local_sources.json plus Resources with a city).
  * Blurbs: a 1-2 sentence "what you would do, at what kind of organization" summary
    (Claude API if a key is set, otherwise a plain-text extract).
"""
import base64, hashlib, html as htmllib, json, os, re, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"}


def http_get(url, timeout=20, data=None, headers=None):
    """Returns (status, final_url, text, error). status 0 means the request never got an answer."""
    h = dict(UA)
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(3_000_000)
            m = re.search(r"charset=([\w-]+)", r.headers.get("Content-Type", ""))
            try:
                text = raw.decode(m.group(1) if m else "utf-8", "replace")
            except LookupError:
                text = raw.decode("utf-8", "replace")
            return r.status, r.geturl(), text, ""
    except urllib.error.HTTPError as e:
        return e.code, url, "", f"HTTP {e.code}"
    except Exception as e:  # network down, DNS, timeout, TLS
        return 0, url, "", f"{type(e).__name__}: {e}"


# ------------------------------------------------------------------ regions
US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO", "connecticut": "CT",
    "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
    "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH",
    "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH",
    "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
}
US_ABBR = set(US_STATES.values())
AMBIGUOUS_NAMES = {"georgia", "washington"}  # also a country / also a city: not used to detect the US on their own

_US_WORDS = re.compile(r"united states|\busa\b|\bu\.s\.a?\b", re.I)
_US_CAPS = re.compile(r"\bUS\b")
_US_NAME = re.compile(r"\b(" + "|".join(re.escape(n) for n in sorted((n for n in US_STATES if n not in AMBIGUOUS_NAMES), key=len, reverse=True)) + r")\b", re.I)
_ST_AFTER = re.compile(r"[,\-–]\s*([A-Z]{2})\b")
_DELAWARE = re.compile(r"wilmington|dover|newark|delaware", re.I)

_EU_COUNTRIES = (r"austria|belgium|bulgaria|croatia|cyprus|czech(?:ia| republic)|denmark|estonia|finland|france|germany|greece|hungary|"
                 r"(?<!northern )ireland|italy|latvia|lithuania|luxembourg|malta|(?:the )?netherlands|poland|portugal|romania|slovakia|slovenia|"
                 r"spain|sweden|deutschland|españa|espana|italia|österreich|osterreich|belgique|belgië|nederland|polska|sverige|suomi|danmark")
_EU_CITIES = (r"paris|berlin|rome|roma|milan|milano|madrid|barcelona|amsterdam|brussels|bruxelles|dublin|lisbon|lisboa|vienna|wien|munich|münchen|"
              r"hamburg|copenhagen|stockholm|helsinki|warsaw|prague|budapest|athens|tallinn|riga|vilnius|zagreb|ljubljana|bratislava|sofia|"
              r"bucharest|valletta|nicosia|frankfurt|cologne|köln|düsseldorf|stuttgart|rotterdam|the hague|den haag|utrecht|lyon|marseille|"
              r"toulouse|turin|torino|naples|napoli|florence|firenze|bologna|valencia|seville|sevilla|porto|gothenburg|göteborg|malmö|aarhus|"
              r"antwerp|ghent|leuven|eindhoven")
_EU = re.compile(r"\b(?:" + _EU_COUNTRIES + r"|" + _EU_CITIES + r"|europe|european union|emea|eea)\b|\bEU\b", re.I)
_OTHER = re.compile(r"\b(?:canada|united kingdom|england|scotland|wales|northern ireland|india|australia|new zealand|china|japan|singapore|brazil|"
                    r"mexico|israel|philippines|nigeria|kenya|south africa|switzerland|norway|turkey|t[uü]rkiye|ukraine|russia|argentina|colombia|"
                    r"chile|peru|uae|emirates|hong kong|korea|taiwan|vietnam|pakistan|bangladesh|egypt|saudi|qatar|london|toronto|vancouver|montreal|"
                    r"ottawa|calgary|tokyo|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|sydney|melbourne|seoul|shanghai|beijing|tel aviv|dubai|"
                    r"s[aã]o paulo|buenos aires|bogot[aá]|nairobi|lagos|cape town|johannesburg|zurich|zürich|geneva|oslo|manchester|edinburgh|"
                    r"belfast|bristol|apac|latam|asia)\b|\bUK\b", re.I)


def region_of(loc):
    """'US', 'EU', 'OTHER' or '' (cannot tell). A state like ', OH' beats a city name like Dublin."""
    t = loc or ""
    if _US_WORDS.search(t) or _US_CAPS.search(t) or _US_NAME.search(t):
        return "US"
    for m in _ST_AFTER.finditer(t):
        ab = m.group(1)
        if ab in US_ABBR and (ab != "DE" or _DELAWARE.search(t)):
            return "US"
    if _EU.search(t):
        return "EU"
    if _OTHER.search(t):
        return "OTHER"
    return ""


def is_remote_text(t):
    return bool(re.search(r"remote|anywhere|work from home|telecommut", t or "", re.I))


# ------------------------------------------------------------------ Where
ALIASES = {
    "chicago": r"chicago|, il\b|illinois|evanston|oak brook",
    "bay area": r"bay area|san francisco|oakland|san jose|berkeley|palo alto|mountain view|menlo park|redwood city|sunnyvale|santa clara|south san francisco|emeryville|fremont|cupertino|san mateo",
    "boston": r"boston|cambridge, ma|somerville|brookline|waltham|watertown, ma|burlington, ma|quincy, ma",
    "rome": r"\brome\b(?!,\s*(?:ga|ny|georgia|new york))|\broma\b|lazio",
    "mexico city": r"mexico city|ciudad de m[eé]xico|cdmx",
    "new york": r"new york|\bnyc\b|brooklyn|manhattan",
    "dc": r"washington,? d\.?c|district of columbia|\bdc\b",
}
REMOTE_WORDS = {"remote", "remote work", "anywhere", "wfh"}
US_WORDS_SET = {"us", "usa", "u.s.", "u.s.a.", "united states", "america"}
EU_WORDS_SET = {"eu", "europe", "european union"}
_EXCL = re.compile(r"^(?:[-−–—!]+|not\s+|exclude\s+)\s*(.+)$", re.I)
_SPLIT = re.compile(r"[;,\n]+|\s+(?=[-−!]\S)")


class Term:
    def __init__(self, text):
        self.text = text.strip()
        t = self.text.lower()
        self.kind, self.rx = "text", None
        if t in REMOTE_WORDS:
            self.kind = "remote"
        elif t in US_WORDS_SET:
            self.kind = "US"
        elif t in EU_WORDS_SET:
            self.kind = "EU"
        elif t in ALIASES:
            self.rx = re.compile(ALIASES[t], re.I)
        elif t in US_STATES:
            ab = US_STATES[t]
            self.rx = re.compile(r"(?i:\b" + re.escape(t) + r"\b)|[,\-–]\s*" + ab + r"\b|^" + ab + r"\b")
        elif re.fullmatch(r"[A-Za-z]{2}", self.text) and self.text.upper() in US_ABBR:
            ab = self.text.upper()
            self.rx = re.compile(r"[,\-–]\s*" + ab + r"\b|^" + ab + r"\b|\bUS\s*-\s*" + ab + r"\b")
        else:
            self.rx = re.compile(r"(?<![a-z0-9])" + re.escape(t) + r"(?![a-z0-9])", re.I)

    def match(self, loc, remote):
        if self.kind == "remote":
            return bool(remote)
        if self.kind in ("US", "EU"):
            return region_of(loc) == self.kind
        return bool(self.rx.search(loc or ""))


class Where:
    """The 'Where' box. Plain terms include; a leading '-' (or '!', 'not ') excludes.
    No included terms means: anywhere in the United States and the EU."""

    def __init__(self, s):
        self.raw = s or ""
        self.inc, self.exc = [], []
        for part in _SPLIT.split(self.raw):
            p = (part or "").strip()
            if not p:
                continue
            m = _EXCL.match(p)
            if m and m.group(1).strip():
                self.exc.append(Term(m.group(1)))
            elif not re.fullmatch(r"[-−–—!]+", p):
                self.inc.append(Term(p))

    @property
    def default_region(self):
        return not self.inc

    def include_hit(self, loc, remote=None):
        remote = is_remote_text(loc) if remote is None else remote
        return any(t.match(loc, remote) for t in self.inc)

    def excluded(self, loc, remote=None):
        remote = is_remote_text(loc) if remote is None else remote
        return any(t.match(loc, remote) for t in self.exc)

    def search(self, text):
        """Lets the scanner use this object where it expects a compiled regex (ats_scan.CHI)."""
        return self.include_hit(text) and not self.excluded(text)

    def describe(self):
        return {"include": [t.text for t in self.inc], "exclude": [t.text for t in self.exc], "default_region": self.default_region}

    def include_text(self):
        return ", ".join(t.text for t in self.inc)


class RegionOK:
    """Stands in for ats_scan.LOC_OK when no city is chosen: keep US, EU and unknown places (and remote)."""

    def search(self, text):
        return region_of(text) in ("US", "EU", "") or bool(re.search(r"hybrid", text or "", re.I))


# ------------------------------------------------------------------ text helpers
def strip_tags(h):
    h = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", h or "")
    h = re.sub(r"(?s)<[^>]+>", " ", h)
    return re.sub(r"\s+", " ", htmllib.unescape(h)).strip()


def page_text(html_text):
    """Readable text of a page, keeping paragraph breaks; prefers a JobPosting description if the page has one."""
    for jp in jsonld_jobs(html_text):
        if jp.get("description"):
            d = htmllib.unescape(jp["description"])
            d = re.sub(r"(?i)<\s*li[^>]*>", "\n• ", d)
            d = re.sub(r"(?i)<\s*/\s*(p|div|h[1-6]|ul|ol)\s*>|<\s*br\s*/?\s*>", "\n", d)
            d = re.sub(r"<[^>]+>", " ", d)
            d = re.sub(r"[ \t]+", " ", htmllib.unescape(d))
            return re.sub(r"\n{3,}", "\n\n", d).strip()
    h = re.sub(r"(?is)<(script|style|noscript|nav|header|footer)[^>]*>.*?</\1>", " ", html_text or "")
    h = re.sub(r"(?i)<\s*li[^>]*>", "\n• ", h)
    h = re.sub(r"(?i)<\s*/\s*(p|div|h[1-6]|ul|ol|tr|section)\s*>|<\s*br\s*/?\s*>", "\n", h)
    h = re.sub(r"<[^>]+>", " ", h)
    h = htmllib.unescape(h)
    h = re.sub(r"[ \t\r\f\v]+", " ", h)
    h = re.sub(r" ?\n ?", "\n", h)
    return re.sub(r"\n{3,}", "\n\n", h).strip()


def short_id(prefix, url):
    return prefix + hashlib.sha1(url.strip().encode("utf-8")).hexdigest()[:12]


# ------------------------------------------------------------------ page parsing (local sites)
def jsonld_jobs(html_text):
    out = []
    for m in re.finditer(r'(?is)<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html_text or ""):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:
            continue
        stack = [data]
        while stack:
            x = stack.pop()
            if isinstance(x, list):
                stack.extend(x)
            elif isinstance(x, dict):
                t = x.get("@type")
                if t == "JobPosting" or (isinstance(t, list) and "JobPosting" in t):
                    out.append(x)
                stack.extend(v for v in x.values() if isinstance(v, (list, dict)))
    return out


def _jp_loc(jp):
    locs = jp.get("jobLocation")
    locs = locs if isinstance(locs, list) else [locs] if locs else []
    bits = []
    for l in locs:
        a = (l or {}).get("address") or {}
        if isinstance(a, dict):
            bits.append(", ".join(str(a.get(k)) for k in ("addressLocality", "addressRegion", "addressCountry") if a.get(k) and not isinstance(a.get(k), dict)))
    if (jp.get("jobLocationType") or "").upper() == "TELECOMMUTE":
        bits.append("Remote")
    return "; ".join(b for b in bits if b)


def feed_items(text):
    out = []
    for m in re.finditer(r"(?is)<(item|entry)\b.*?</\1>", text or ""):
        blk = m.group(0)
        title = re.search(r"(?is)<title[^>]*>(.*?)</title>", blk)
        link = re.search(r"(?is)<link[^>]*href=[\"']([^\"']+)[\"']", blk) or re.search(r"(?is)<link[^>]*>(.*?)</link>", blk)
        date = re.search(r"(?is)<(?:pubDate|published|updated)[^>]*>(.*?)</", blk)
        if title and link:
            out.append((strip_tags(re.sub(r"<!\[CDATA\[|\]\]>", "", title.group(1))), htmllib.unescape(link.group(1).strip()), (date.group(1).strip() if date else "")))
    return out


JOB_WORDS = re.compile(r"\b(analyst|manager|director|coordinator|specialist|associate|officer|engineer|planner|researcher|research|consultant|advis[eo]r|assistant|"
                       r"fellow|scientist|developer|lead|program|policy|strategist|economist|administrator|supervisor|inspector|architect|designer|"
                       r"technician|representative|executive|counsel|attorney|clerk|intern|senior|junior|chief|head|deputy|project|expert|"
                       r"administrator|advisor|programme|statistician|data)\b", re.I)
NAV_WORDS = re.compile(r"^(careers?|jobs?|apply( now| here)?|read more|learn more|log ?in|sign in|sign up|search( jobs)?|view (all|more)( jobs| openings)?|"
                       r"home|contact( us)?|about( us)?|next|previous|back|menu|skip to .*|benefits|faq|privacy.*|terms.*|job (search|alerts?|openings)|"
                       r"current (openings|vacancies)|open positions|employment|human resources)$", re.I)


def anchor_jobs(html_text, base_url, cap=80):
    out, seen = [], set()
    for m in re.finditer(r"(?is)<a\b[^>]*?href=[\"']([^\"'#][^\"']*)[\"'][^>]*>(.*?)</a>", html_text or ""):
        href, text = m.group(1).strip(), strip_tags(m.group(2))
        if not (6 <= len(text) <= 120) or NAV_WORDS.match(text) or not JOB_WORDS.search(text):
            continue
        if re.match(r"(?i)(mailto:|javascript:|tel:)", href):
            continue
        url = urllib.parse.urljoin(base_url, htmllib.unescape(href))
        if not url.startswith("http") or url in seen:
            continue
        seen.add(url)
        out.append((text, url))
        if len(out) >= cap:
            break
    return out


def fetch_local_source(src, today, ats=None):
    """One local site -> (jobs, note). Tries structured data first, then RSS/Atom, then plain job-looking links."""
    name, city, url = src.get("name", ""), src.get("city", ""), src.get("url", "")
    kind = (src.get("kind") or "auto").lower()
    mk = lambda title, link, loc="", posted="", org="": dict(
        id=short_id("loc:", link), title=title.strip(), employer=org or name, loc=loc or (city + " (local site)"), url=link, posted=posted[:10],
        dept="", remote="remote" if is_remote_text(loc) else "", via="local", source_name=name, snippet="")
    if kind == "smartrecruiters" and ats is not None and src.get("slug"):
        rows = ats.f_smartrecruiters(src["slug"])
        jobs = []
        for r in rows:
            j = mk(r["title"], r["url"], r.get("loc", "") or (city + " (local site)"), r.get("posted", ""))
            j["dept"], j["remote"] = r.get("dept", ""), r.get("remote", "")
            jobs.append(j)
        return jobs, f"{len(jobs)} from the SmartRecruiters feed"
    st, final, body, err = http_get(url)
    if st != 200 or not body:
        return [], f"could not load ({err or st})"
    jobs = []
    for jp in jsonld_jobs(body):
        link = jp.get("url") or jp.get("sameAs") or final
        org = (jp.get("hiringOrganization") or {}).get("name") if isinstance(jp.get("hiringOrganization"), dict) else ""
        if jp.get("title"):
            jobs.append(mk(str(jp["title"]), str(link), _jp_loc(jp), str(jp.get("datePosted") or ""), org or ""))
    note = "structured job data"
    if not jobs and re.search(r"(?i)<(rss|feed)\b", body[:2000]):
        jobs = [mk(t, l, posted=d) for t, l, d in feed_items(body)]
        note = "feed"
    if not jobs:
        jobs = [mk(t, l) for t, l in anchor_jobs(body, final)]
        note = "links on the page that look like job titles"
    return jobs, (f"{len(jobs)} via {note}" if jobs else "loaded, but no job-like entries found (the site may need a browser to show its list)")


# ------------------------------------------------------------------ web search layer
BLOCKED = re.compile(r"wikipedia\.org|reddit\.com|quora\.com|youtube\.com|facebook\.com|twitter\.com|//x\.com|pinterest\.|tiktok\.com|"
                     r"glassdoor\.[a-z.]+/(salary|reviews|interview)|medium\.com|substack\.com|support\.google|indeed\.com/(cmp|career-advice|q-)", re.I)
JOBISH = re.compile(r"job|career|hiring|apply|position|opening|vacanc|recruit|\brole\b|opportunit|employment|we.re looking", re.I)
_SITE_TAIL = re.compile(r"\s*[|\-–—·•]\s*(?:linkedin|indeed|glassdoor|ziprecruiter|simplyhired|monster|lever|greenhouse|workday|ashby|careers?|jobs?|"
                        r"idealist|built ?in|handshake|wellfound|devex|reliefweb|[\w .&]+\.(?:com|org|net|io|gov|edu|eu|co))\b.*$", re.I)


def clean_title(t):
    t = strip_tags(t)
    for _ in range(3):
        n = _SITE_TAIL.sub("", t).strip()
        if n == t:
            break
        t = n
    return t.strip(" -–—|·")


def parse_employer(raw_title, snippet, url):
    t = strip_tags(raw_title)
    m = re.search(r"\bat\s+([A-Z0-9][\w&.,'’ \-]{1,60}?)(?:\s+[|\-–—]|\s+in\s|\s*\(|$)", t)
    if m:
        return m.group(1).strip(" ,.-")
    m = re.match(r"^(.{2,50}?)\s+(?:is\s+)?hiring\b", t, re.I)
    if m:
        return m.group(1).strip()
    parts = [p.strip() for p in re.split(r"\s+[|\-–—]\s+", t) if p.strip()]
    if len(parts) >= 2:
        cand = parts[1]
        if not re.search(r"linkedin|indeed|glassdoor|ziprecruiter|simplyhired|monster|careers?$|jobs?$|idealist|built ?in", cand, re.I) and len(cand) <= 60:
            return cand
    host = urllib.parse.urlparse(url).netloc.lower()
    host = re.sub(r"^(www|jobs|careers|boards|job-boards|apply)\.", "", host)
    return host.split(".")[0].replace("-", " ").title() if host else ""


def _ddg_parse(body, n):
    out = []
    parts = re.split(r'(?=<a[^>]+class="result__a")', body)
    for blk in parts[1:]:
        a = re.search(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', blk, re.S)
        if not a:
            continue
        href = htmllib.unescape(a.group(1))
        if "uddg=" in href:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(href if href.startswith("http") else "https:" + href).query)
            href = (qs.get("uddg") or [href])[0]
        sn = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', blk, re.S)
        out.append({"title": strip_tags(a.group(2)), "url": href, "snippet": strip_tags(sn.group(1)) if sn else ""})
        if len(out) >= n:
            break
    return out


def ddg_search(q, n=10):
    """DuckDuckGo answers a plain GET from a script with HTTP 202 (a robot check) and no results. A form POST that looks
    like the page's own search box goes through, so that is tried first, then the plain GET."""
    why = ""
    form = urllib.parse.urlencode({"q": q, "b": "", "kl": "us-en"}).encode()
    hdr = {"Referer": "https://html.duckduckgo.com/", "Origin": "https://html.duckduckgo.com", "Content-Type": "application/x-www-form-urlencoded"}
    for how, url, data, hd in (("form", "https://html.duckduckgo.com/html/", form, hdr), ("plain", "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": q}), None, {})):
        st, _, body, err = http_get(url, timeout=20, data=data, headers=hd)
        out = _ddg_parse(body, n) if st == 200 and body else []
        if out:
            return out, ""
        why = f"DuckDuckGo gave no results ({err or st})"
    return [], why


def _bing_url(href):
    u = (urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("u") or [""])[0]
    if u.startswith("a1"):  # Bing wraps result links; the real address is base64 after "a1"
        try:
            s = u[2:]
            return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()
        except Exception:
            return href
    return href


def bing_search(q, n=10):
    st, _, body, err = http_get("https://www.bing.com/search?" + urllib.parse.urlencode({"q": q, "setlang": "en-US", "cc": "us"}), timeout=20,
                                headers={"Accept-Language": "en-US,en;q=0.9"})
    if st != 200 or not body:
        return [], f"Bing gave no results ({err or st})"
    out = []
    for blk in re.split(r'(?=<li class="b_algo")', body)[1:]:
        a = re.search(r'<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', blk, re.S)
        if not a:
            continue
        sn = re.search(r'<p[^>]*>(.*?)</p>', blk, re.S)
        out.append({"title": strip_tags(a.group(2)), "url": _bing_url(htmllib.unescape(a.group(1))), "snippet": strip_tags(sn.group(1)) if sn else ""})
    # a robot-check or degraded page returns results that ignore the question: keep only pages that mention its main words
    words = [w for w in re.findall(r"[a-z]{4,}", re.sub(r"site:\S+|-\S+", " ", q.lower())) if w not in ("jobs", "careers")][:3]
    out = [r for r in out if sum(w in (r["title"] + " " + r["snippet"] + " " + r["url"]).lower() for w in words) >= min(2, len(words))]
    return out[:n], ("" if out else "Bing returned nothing that matches the question")


def web_search(q, keys, n=10):
    """Google (if keys are saved), then DuckDuckGo, then Bing. Returns ((results, error), engine used)."""
    if keys.get("google_key") and keys.get("google_cx"):
        res = google_cse(q, keys["google_key"], keys["google_cx"], n)
        if res[0]:
            return res, "Google"
    errs = []
    for name, fn in (("DuckDuckGo", ddg_search), ("Bing", bing_search)):
        res, err = fn(q, n)
        if res:
            return (res, ""), name
        errs.append(err)
    return ([], "; ".join(e for e in errs if e)), "DuckDuckGo"


def google_cse(q, key, cx, n=10):
    st, _, body, err = http_get("https://www.googleapis.com/customsearch/v1?" + urllib.parse.urlencode({"key": key, "cx": cx, "q": q, "num": min(n, 10)}), timeout=20)
    if st != 200:
        return [], f"Google search error ({err or st})"
    try:
        items = json.loads(body).get("items") or []
    except Exception:
        return [], "Google search returned something unreadable"
    return [{"title": i.get("title", ""), "url": i.get("link", ""), "snippet": i.get("snippet", "")} for i in items], ""


def google_jobs_link(q):
    return "https://www.google.com/search?" + urllib.parse.urlencode({"q": q, "udm": "8"})


TRACK_QUERY = {
    "Advisory/Consultant": "strategy consultant responsible AI advisory",
    "Think Tanks": "policy analyst fellow think tank",
    "AI Governance": "AI governance policy manager",
    "Modeling": "policy systems modeler simulation analyst",
    "0-to-1 Launch": "program strategist new initiative AI strategy lead",
    "Urban Systems": "urban strategy mobility city innovation",
}


def build_queries(W, q, track, max_queries=8):
    whats = [q.strip()] if (q or "").strip() else [TRACK_QUERY[track]] if track in TRACK_QUERY else list(TRACK_QUERY.values())[:3]
    wheres = [t.text for t in W.inc if t.kind == "text"][:3] or ["United States", "Europe"]
    for t in W.inc:
        if t.kind == "remote":
            wheres.append("remote")
    out = []
    for w in wheres:
        for what in whats:
            neg = " ".join("-" + t.text.replace(" ", "") for t in W.exc if t.kind == "text")
            out.append((f"{what} jobs {w} {neg}".strip(), w))
    return out[:max_queries]


def web_rows(results, label_city, today, W):
    """Search hits -> job rows. Drops obvious non-job pages, and locations the Where box excludes."""
    rows = []
    for r in results:
        url, raw_title, snippet = r.get("url", ""), r.get("title", ""), r.get("snippet", "")
        if not url.startswith("http") or BLOCKED.search(url) or not JOBISH.search(f"{url} {raw_title} {snippet}"):
            continue
        title = clean_title(raw_title)
        employer = parse_employer(raw_title, snippet, url)
        for sep in (" - ", " – ", " — ", " | ", " at "):  # "Policy Analyst - Urban Institute": the employer is not part of the title
            if employer and title.lower().endswith((sep + employer).lower()):
                title = title[: -len(sep + employer)].strip()
        if len(title) < 5:
            continue
        text = f"{raw_title} {snippet}"
        loc = ""
        for t in W.inc:
            if t.kind == "text" and t.rx.search(text):
                loc = t.text
                break
        if not loc and label_city not in ("United States", "Europe"):
            loc = f"{label_city} (from search)"
        if W.excluded(f"{loc} {text}"):
            continue
        host = urllib.parse.urlparse(url).netloc.lower().replace("www.", "")
        rows.append(dict(id=short_id("web:", url), title=title, employer=employer, loc=loc, url=url, posted="",
                         dept="", remote="remote" if is_remote_text(text) else "", via="web", source_name=host, snippet=snippet[:400]))
    return rows


# ------------------------------------------------------------------ local sources
def sources_for(W, all_sources):
    """Pick the local sites that fit the Where box. No include terms: every site whose region is US, EU or unknown."""
    out = []
    for s in all_sources:
        city, reg = s.get("city", ""), (s.get("region") or "").upper()
        if W.exc and W.excluded(city + " " + s.get("name", "")):
            continue
        if W.inc:
            hit = any((t.kind in ("US", "EU") and reg == t.kind) or (t.kind == "text" and t.rx.search(city)) for t in W.inc)
            if not hit:
                continue
        elif reg not in ("", "US", "EU"):
            continue
        out.append(s)
    return out


def discover_queries(city):
    return [f"{city} jobs board local employers", f"{city} government jobs careers", f"{city} nonprofit policy jobs"]


# ------------------------------------------------------------------ blurbs
_ROLE_CUE = re.compile(r"\b(you will|you'll|will be responsible|responsible for|will work|will lead|will support|will conduct|will develop|will analy[sz]e|"
                       r"will manage|will design|will research|the (?:role|position|analyst|consultant|associate|fellow|researcher)\b[^.]{0,30}\b(?:will|is|involves)|"
                       r"duties include|key responsibilities|what you.ll do|in this role)\b", re.I)
_ORG_CUE = re.compile(r"\b(we are|is a|is an|is the|our mission|founded|non-?profit|consultancy|firm|organi[sz]ation|company|institute|think tank|agency|"
                      r"department|laborator|university|foundation|startup|platform)\b", re.I)


def _sentences(text):
    t = re.sub(r"[ \t]+", " ", text or "")
    parts = re.split(r"(?<=[.!?])\s+|\n+\s*(?:•|-|\*)?\s*", t)
    return [p.strip(" •-*\t") for p in parts if 25 <= len(p.strip()) <= 320]


def _trim(s, n):
    s = s.strip()
    if len(s) <= n:
        return s.rstrip(".")
    cut = s[:n]
    k = max(cut.rfind(","), cut.rfind(";"), cut.rfind(" and "), cut.rfind(" "))
    return (cut[:k] if k > n * 0.6 else cut).rstrip(" ,;.") + "…"


_RESP_HEAD = re.compile(r"(?im)^[ \t•*-]*(?:key |main |primary |core )?(?:role )?(?:responsibilities|what you.ll do|what you will do|what you.ll be doing|"
                        r"duties|your responsibilities|in this role,? you will|your impact|the work|day[- ]to[- ]day)\b[^\n]{0,40}$")
_LOC_SKIP = {"remote", "hybrid", "locations", "location", "search", "anywhere", "united", "states", "onsite", "on-site"}


def strip_location(text, loc):
    """Remove the listing's own place names from a summary (the place is already shown on the row)."""
    for tok in re.split(r"[,;()/|\-–]+", loc or ""):
        tok = tok.strip()
        if len(tok) >= 3 and tok.lower() not in _LOC_SKIP and not tok.isdigit():
            text = re.sub(r"(?i)\b" + re.escape(tok) + r"\b[,]?\s*", "", text)
    return re.sub(r"\s{2,}", " ", text).strip(" ,;")


def bullets_blurb(text, loc="", cap=120, words=4):
    """First few words of each responsibilities bullet, joined until the length cap is reached. '' if there is no such section."""
    m = _RESP_HEAD.search(text or "")
    if not m:
        return ""
    items = []
    for line in text[m.end():].split("\n")[1:40]:
        ln = line.strip()
        if not ln:
            if items and not text[m.end():].split("\n")[1:40]:
                break
            continue
        if ln.startswith(("•", "*", "-", "–")):
            items.append(ln.lstrip("•*-– ").strip())
        elif items and len(ln) < 60 and not ln.endswith((".", ";", ",")):
            break  # the next heading
        elif not items and len(ln) < 220:
            items.append(ln)  # a plain-line list with no bullet marks
        if len(items) >= 10:
            break
    out = ""
    for it in items:
        it = strip_location(it, loc)
        if re.match(r"(?i)(duties|responsibilities|other duties|essential functions|key (duties|responsibilities))\b|.*\b(will include|include|includes|following):?$|.*(including but not limited|responsibilities across|areas of focus|as follows)", it) or len(it.split()) < 3:
            continue  # lead-in lines like "Duties will include" are not a duty
        w = re.sub(r"^[\W_]+", "", " ".join(it.split()[:words])).rstrip(" ,;:.")
        w = re.sub(r"(?i)(\s+(a|an|the|of|to|and|or|for|with|in|on|by|that|their|our|across|into|as))+$", "", w)  # no dangling "of" or "and"
        if len(w) < 6:
            continue
        piece = w if not out else out + "; " + w
        if len(piece) > cap:
            break
        out = piece
    return (out[:1].upper() + out[1:] + ".") if out else ""


def heuristic_blurb(job, text):
    b = bullets_blurb(text or "", job.get("loc", ""))
    if b:
        return b
    return _sentence_blurb(job, text)


def _sentence_blurb(job, text):
    """Plain extract: first sentence about the duties, then first sentence describing the organization."""
    emp, title = (job.get("employer") or "").strip(), (job.get("title") or "").strip()
    text = ((text or "").strip() or (job.get("snippet") or "")).replace("\u2019", "'").replace("\u2018", "'")
    sents = _sentences(text[:6000])
    junk = re.compile(r"(?i)not responsible|equal opportunity|if you\b|accommodation|privacy|applicants? (must|will)|^[^a-z]*$")
    sents = [s for s in sents if not junk.search(s) and s != s.upper()]
    role = next((s for s in sents if _ROLE_CUE.search(s)), None)
    head = re.search(r"(?i)(responsibilities|what you.ll do|the role|about the role|role overview|your impact)\s*:?\s*\n+(.{30,300})", text)
    if not role and head:
        role = _sentences(head.group(2))[:1] and _sentences(head.group(2))[0]
    org = next((s for s in _sentences(text[:3000]) if re.search(r"\b(we are|is an?|is the|our mission|non-?profit)\b", s, re.I)
                and not re.match(r"(?i)(the candidate|the successful|you|this (role|position)|as a)\b", s) and s != role), None)
    if role:
        role = re.sub(r"(?i)^(in this role,?\s*)?(you will|you'll|the \w+ will|will)\s+(be responsible for\s+)?", "", role).strip()
        role = role[:1].upper() + role[1:]
    if org and emp:
        org = re.sub(r"(?i)^(?:" + re.escape(emp) + r"|we|the company|the organi[sz]ation|our (?:company|organi[sz]ation))\s+(?:is|are)\s+", "", org).strip()
    if not role and not org:
        return ""  # nothing readable: the caller falls back to "Title at Employer"
    parts = []
    if role:
        parts.append(_trim(role, 85))
    else:
        parts.append(title)
    if emp and org and re.match(r"(?i)(a|an|the)\s", org):
        org = org[:1].lower() + org[1:] if org[:3].lower() != "the" else org
        if len(org) <= 75:  # a cut-off description of the employer reads worse than none
            parts.append("At " + emp + ", " + org.rstrip("."))
    out = strip_location(". ".join(parts).strip(), job.get("loc", ""))
    out = re.sub(r"…\.", "…", out)
    return out if out.endswith(("…", ".")) else out + "."


def ai_blurb(job, text, key, model):
    prompt = ("Write a summary of this job posting in 1 or 2 plain sentences (at most 25 words and 140 characters, so it fits on two short lines). First: what the person would actually do day to day. "
              "Then: what kind of organization it is (sector, mission, size) in the form 'at <kind of organization> <name>'. "
              "No hype, no repeating the job title, no salary, and do not mention the location. Output only the sentences.\n\n"
              f"Title: {job.get('title','')}\nEmployer: {job.get('employer','')}\nLocation: {job.get('loc','')}\nDepartment: {job.get('dept','')}\n\n"
              f"Posting text:\n{(text or job.get('snippet') or '')[:3500]}")
    body = json.dumps({"model": model, "max_tokens": 90, "messages": [{"role": "user", "content": prompt}]}).encode()
    st, _, resp, err = http_get("https://api.anthropic.com/v1/messages", timeout=30, data=body,
                                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    if st != 200:
        raise RuntimeError(f"Claude API error ({err or st})")
    d = json.loads(resp)
    out = "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text").strip()
    if not out:
        raise RuntimeError("Claude API returned no text")
    return out


def make_blurb(job, text, keys, on_error=None):
    """Returns (blurb, by). by is 'ai' or 'auto'. Falls back to the plain extract if the API is unavailable."""
    if keys.get("anthropic_key"):
        try:
            return ai_blurb(job, text, keys["anthropic_key"], keys.get("blurb_model") or "claude-haiku-5-5"), "ai"
        except Exception as e:
            if on_error:
                on_error(f"Claude summary failed, so the plain extract was used instead: {e}")
    b = heuristic_blurb(job, text)
    if not b or len(b) < 20:
        b = (job.get("title", "") + (" at " + job["employer"] if job.get("employer") else "")).strip() + ". The listing gave no readable description; open it for details."
    return b, "auto"
