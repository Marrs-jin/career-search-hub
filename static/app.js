'use strict';
/* Daily Hub front end, part 1: helpers, Today, Search. Part 2 (Records, Goals, Resources, How it works) is views.js.
   All text from job sites is inserted with textContent (never innerHTML), so a listing cannot inject markup. */

/* The six clusters are an example career map. Edit this list (and the matching TRACKS in hub.py) to describe your own targets.
   `resume` must match a name in Settings > resume_versions (data/hub.json). */
const CLUSTERS = [
  { name: "Advisory/Consultant", resume: "Strategy", gives: "A recommendation to a client, then you move on to the next problem.", titles: "Responsible-AI consultant, social-impact strategy consultant, tech-and-society advisor" },
  { name: "Think Tanks", resume: "Standard", gives: "A policy design at a shop whose recommendations can become reality; an aligned team carries it out.", titles: "Policy analyst or fellow, policy entrepreneur, AI policy advisor" },
  { name: "AI Governance", resume: "AI-Policy", gives: "An ongoing AI-risk or AI-policy function inside an organization.", titles: "AI governance lead or policy manager, AI risk strategist, government AI advisor" },
  { name: "Modeling", resume: "Data", gives: "A model that decision-makers use, built with them sitting next to you.", titles: "Policy or systems modeler embedded with decision-makers; computational social scientist" },
  { name: "0-to-1 Launch", resume: "Standard", gives: "Something new stood up from nothing to launched, and you help make it real. Other clusters end at a recommendation or an analysis; this one owns the start of the build, then hands it off.", titles: "Program strategist for new initiatives, AI strategy lead, early-stage chief of staff" },
  { name: "Urban Systems", resume: "Urban", gives: "High-level questions about how a city works (how much green space it needs).", titles: "Urban strategist or city innovation lead, mobility strategy analyst" }
];
const EXTRA_TAGS = ["Short-term / Income", "Other"];  // tags, not clusters: income gigs and anything that fits no cluster
const TRACKS = CLUSTERS.map((c) => c.name);
const resumeFor = (tracks) => { for (const t of tracks || []) { const c = CLUSTERS.find((x) => x.name === t); if (c) return c.resume; } return ""; };
const tracksOf = (a) => (a && a.tracks && a.tracks.length ? a.tracks : a && a.track ? [a.track] : []);
/* Several tracks per job: click to add or remove; the first one picked is the main one (it picks the suggested resume). */
function trackPicker(init, onChange) {
  let sel = [...(init || [])];
  const box = h("div", { class: "trackpick" });
  const toggle = (t) => { sel = sel.includes(t) ? sel.filter((x) => x !== t) : [...sel, t]; draw(); if (onChange) onChange(sel); };
  const btn = (t) => h("button", { type: "button", "aria-pressed": String(sel.includes(t)), onclick: () => toggle(t) }, t, sel[0] === t && sel.length > 1 ? h("span", { class: "mainmark" }, " · main") : null);
  function draw() { clear(box).append(h("div", { class: "pick" }, TRACKS.map(btn)), h("div", { class: "small muted", style: "margin:8px 0 4px" }, "Not a career track"), h("div", { class: "pick" }, EXTRA_TAGS.map(btn)), h("div", { class: "small muted", style: "margin-top:6px" }, "Pick as many as fit. The first one you pick is the main one.")); }
  draw();
  return { el: box, get: () => sel };
}
const OPEN_ST = ["Applied", "Interview", "Offer"], WAIT_ST = ["Waitlisted", "Watching"], CLOSED_ST = ["Rejected", "Withdrawn"];
const ALL_ST = [...OPEN_ST, ...WAIT_ST, ...CLOSED_ST];
const S = { hub: null, today: null, tab: "today", lastDone: 0, scanTimer: null,
  search: { p: { city: "", remote: "include", q: "", track: "", min: "3", show: "undecided", sort: "fit", src: "all" }, data: null, sel: 0, loading: false, limit: 25, layers: { boards: true, local: true, large: true, small: false }, writing: false },
  rec: { group: "all", q: "", track: "", view: localStorage.getItem("hub.recview") || "board", showAllClosed: false } };

/* ---------- tiny DOM helpers ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (["value", "checked", "selected", "disabled", "hidden", "open"].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c.nodeType ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
const NS = "http://www.w3.org/2000/svg";
function sv(tag, attrs, ...kids) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); kids.forEach((c) => el.append(c.nodeType ? c : document.createTextNode(c))); return el; }
const $ = (s, el = document) => el.querySelector(s);
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
async function api(path, method = "GET", body) {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json", "X-Hub": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch (e) { /* empty body */ }
  if (!r.ok) { const err = new Error(d.error || ("Request failed (" + r.status + ")")); err.fromApi = true; throw err; } // the server already logged this one
  return d;
}
let toastT;
function toast(msg, err) { document.querySelectorAll(".toast").forEach((t) => t.remove()); const t = h("div", { class: "toast" + (err ? " err" : ""), role: "status" }, msg); document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), err ? 6000 : 2800); }
const fail = (e) => { toast(e.message || String(e), true); if (!e || !e.fromApi) logPage("page (" + S.tab + ")", e); };
/* anything that breaks in the page goes to the Error log tab (the server logs its own failures) */
let pageLogged = 0;
function logPage(area, err, level) {
  if (pageLogged++ >= 20) return;
  try {
    fetch("/api/errors/log", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub": "1" }, body: JSON.stringify({ area, message: (err && err.message) || String(err), detail: (err && err.stack) || "", level: level || "error" }) }).then(() => refreshErrBadge()).catch(() => {});
  } catch (e) { /* nothing more to do */ }
}
window.addEventListener("error", (ev) => logPage("page (" + S.tab + ")", ev.error || ev.message));
window.addEventListener("unhandledrejection", (ev) => logPage("page (" + S.tab + ")", ev.reason));
async function refreshErrBadge() { try { const d = await api("/api/errors/count"); const b = $("#c-errors"); if (b) b.textContent = d.new || ""; } catch (e) { /* server not answering */ } }
const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const todayIso = () => iso(new Date());
function dayDiff(a) { if (!/^\d{4}-\d{2}-\d{2}/.test(a || "")) return null; const [y, m, d] = a.split("-").map(Number); const t = new Date(); return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5); }
const isIso = (s) => /^\d{4}-\d{2}-\d{2}/.test(s || "");
function niceDate(s) { if (!isIso(s)) return ""; const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function inDays(n) { return n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? Math.abs(n) + " days ago" : "in " + n + " days"; }
const money = (n) => "$" + Number(n).toLocaleString();
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

/* ---------- layer: modal and drawer ---------- */
function closeLayer() { clear($("#layer")); document.body.style.overflow = ""; }
function openModal(title, content, actions, opts = {}) {
  closeLayer();
  const box = h("div", { class: "box", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", {}, title), content, actions ? h("div", { class: "foot" }, actions) : null);
  const wrap = h("div", { class: "modal" }, box);
  const scrim = h("div", { class: "scrim", onclick: closeLayer });
  $("#layer").append(scrim, wrap);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeLayer(); });
  const first = box.querySelector("input:not([type=hidden]), select, textarea, button"); if (first && !opts.nofocus) first.focus();
  return box;
}
function openDrawer(head, body, foot) {
  closeLayer(); document.body.style.overflow = "hidden";
  const d = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": "Listing details" },
    h("header", {}, head, h("button", { class: "btn ghost sm", onclick: closeLayer, "aria-label": "Close" }, "Close")),
    h("div", { class: "body" }, body), foot ? h("footer", {}, foot) : null);
  $("#layer").append(h("div", { class: "scrim", onclick: closeLayer }), d);
  d.querySelector("header button").focus();
  return d;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#layer").firstChild) return closeLayer();
  if (S.tab === "search" && !$("#layer").firstChild && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest("input,select,textarea,button,a")) searchKeys(e);
});
function field(label, input) { return h("label", { class: "field" }, label, input); }
function select(opts, val, attrs) { return h("select", attrs, opts.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return h("option", { value: v, selected: v === val }, t); })); }

/* ---------- shared job pieces ---------- */
function flagChip(f) {
  const cls = /BELOW FLOOR|clearance|defense|people-mgmt|prior reject|same role|REMOTE-ONLY|mission|asks \d+\+|confirm|find the link/i.test(f) ? "warn" : /^pay \$|deadline/i.test(f) ? (/deadline/i.test(f) ? "deadline" : "good") : "";
  return h("span", { class: "chip " + cls }, f);
}
function fitWord(s) { return s >= 6 ? "strong" : s >= 4 ? "good" : s >= 2 ? "possible" : "weak"; }
function fitMeter(s) { const pct = Math.max(4, Math.min(100, ((s + 4) / 14) * 100)); return h("span", { class: "fit", title: "Fit score " + s + ". Higher means closer to what you said you want." }, h("span", { class: "bar" }, h("i", { style: "width:" + pct + "%" })), fitWord(s)); }
function jobLine(v) { return [v.employer, v.loc].filter(Boolean).join(" · "); }
function origLink(v, cls = "btn sm") { return v.url ? h("a", { class: cls, href: v.url, target: "_blank", rel: "noopener noreferrer", title: "Opens the employer's page in a new tab" }, "Open original ↗") : null; }
function jobChips(v, max = 4) {
  const c = [];
  if (v.deadline) { const n = dayDiff(v.deadline); c.push(h("span", { class: "chip deadline" }, "Closes " + niceDate(v.deadline) + (n !== null && n >= 0 && n <= 14 ? " (" + inDays(n) + ")" : ""))); }
  if (v.pay && v.pay[1] && !v.flags.some((f) => /pay|FLOOR/i.test(f))) c.push(h("span", { class: "chip good" }, "Pay " + (v.pay[0] && v.pay[0] !== v.pay[1] ? money(v.pay[0]) + "–" : "") + money(v.pay[1])));
  v.flags.filter((f) => !/deadline Oct/i.test(f)).slice(0, max).forEach((f) => c.push(flagChip(f)));
  if (v.remote) c.push(h("span", { class: "chip" }, "Remote option"));
  return h("div", { class: "chips" }, c);
}

/* ---------- actions on listings ---------- */
async function refreshAll() { await loadToday(); if (S.tab === "search") await runSearch(true); if (S.tab === "records") renderRecords(); if (S.tab === "goals") await renderGoals(); }
async function queueJob(id, quiet) { try { await api("/api/mark", "POST", { id, state: "saved" }); if (!quiet) toast("Added to today's plan"); await refreshAll(); } catch (e) { fail(e); } }
async function laterJob(id) { try { await api("/api/mark", "POST", { id, state: "snoozed" }); toast("Moved to tomorrow"); await refreshAll(); } catch (e) { fail(e); } }
async function futureJob(id) { try { await api("/api/mark", "POST", { id, state: "later" }); toast("Saved for later"); await refreshAll(); } catch (e) { fail(e); } }
async function clearJob(id) { try { await api("/api/mark", "POST", { id, state: "clear" }); toast("Removed from the plan"); await refreshAll(); } catch (e) { fail(e); } }
async function passJob(id, reason = "") { try { await api("/api/mark", "POST", { id, state: "declined", reason }); toast("Passed. It won't show up again."); await refreshAll(); } catch (e) { fail(e); } }

const REASONS = ["Pay is below my floor", "Too senior or asks too many years", "Wrong kind of work", "Already closed", "Defense or mission concern", "Not in a city I want"];
function declineModal(v) {
  let pick = ""; const other = h("input", { placeholder: "Or write your own reason", "aria-label": "Other reason" });
  const btns = REASONS.map((r) => h("button", { type: "button", "aria-pressed": "false", onclick: (e) => { pick = r; btns.forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); other.value = ""; } }, r));
  openModal("Not for me", h("div", { style: "display:grid;gap:12px" }, h("div", { class: "muted small" }, v.employer + ": " + v.title + ". Your reason helps the next search skip similar listings."), h("div", { class: "pick" }, btns), other),
    [h("button", { class: "btn", onclick: closeLayer }, "Cancel"), h("button", { class: "btn primary", onclick: async () => { closeLayer(); await passJob(v.id, other.value.trim() || pick); } }, "Pass on it")]);
}
function applyModal(v) {
  const rv = (S.hub.settings.resume_versions || []);
  const resume = select(["", ...rv], ""), date = h("input", { type: "date", value: todayIso() }), notes = h("textarea", { placeholder: "Cover letter used, who referred you, anything to remember" });
  let lastSugg = "";
  const hint = h("div", { class: "small muted" }, "Pick a track and the matching resume fills in; you can still change it.");
  const tp = trackPicker([], (sel) => { const s = resumeFor(sel); if (!resume.value || resume.value === lastSugg) resume.value = s; lastSugg = s; hint.textContent = s ? "Suggested from the main track: " + s : "Pick a track and the matching resume fills in; you can still change it."; });
  openModal("Save to records", h("div", { style: "display:grid;gap:12px" }, h("div", {}, h("strong", {}, v.title), h("div", { class: "muted small" }, jobLine(v))),
    h("div", { class: "field" }, h("span", {}, "Track (more than one is fine)"), tp.el), h("div", { class: "grid2" }, field("Resume version", resume), field("Date applied", date)), hint, field("Notes", notes)),
    [h("button", { class: "btn", onclick: closeLayer }, "Cancel"), h("button", { class: "btn good", onclick: async () => {
      try { const r = await api("/api/apply", "POST", { id: v.id, resume: resume.value, date: date.value, tracks: tp.get(), notes: notes.value }); S.hub.applications.push(r.record); closeLayer(); toast("Saved to records. Nice."); await refreshAll(); } catch (e) { fail(e); } } }, "I applied")]);
}
function manualModal(v) {
  const edit = !!v, f = (k) => (v && v[k]) || "";
  const title = h("input", { value: f("title"), required: true }), org = h("input", { value: f("employer"), required: true }), loc = h("input", { value: f("loc") }),
    url = h("input", { type: "url", value: f("url"), placeholder: "https://…" }), dl = h("input", { type: "date", value: f("deadline") }), notes = h("textarea", {}, f("notes"));
  notes.value = f("notes");
  const when = h("select", {}, h("option", { value: "today" }, "Today's plan"), h("option", { value: "tomorrow" }, "Tomorrow"), h("option", { value: "later" }, "Later (keep on file)"));
  openModal(edit ? "Edit job" : "Add a job by hand", h("div", { style: "display:grid;gap:12px" }, field("Job title", title), field("Organization", org),
    h("div", { class: "grid2" }, field("Location", loc), field("Closes on", dl)), field("Link to the posting", url), field("Notes", notes),
    edit ? null : field("When will you work on it?", when)),
    [h("button", { class: "btn", onclick: closeLayer }, "Cancel"), h("button", { class: "btn primary", onclick: async () => {
      try {
        const body = { title: title.value, employer: org.value, loc: loc.value, url: url.value, deadline: dl.value, notes: notes.value };
        if (edit) await api("/api/manual/update", "POST", Object.assign({ id: v.id }, body)); else await api("/api/manual", "POST", Object.assign(body, { when: when.value }));
        closeLayer(); toast(edit ? "Saved" : { today: "Added to today's plan", tomorrow: "Saved for tomorrow", later: "Saved for later" }[when.value]); await refreshAll();
      } catch (e) { fail(e); } } }, edit ? "Save changes" : "Add job")]);
}

async function showJob(id) {
  const body = h("div", {}, h("div", { class: "skel", style: "width:70%" }), h("div", { class: "skel" }), h("div", { class: "skel", style: "width:85%" }), h("div", { class: "skel" }));
  const head = h("div", {}, h("h2", {}, "Loading…"));
  const foot = h("div", { class: "chips", style: "width:100%" });
  openDrawer(head, body, foot);
  try {
    const d = await api("/api/job?id=" + encodeURIComponent(id)); const v = d.job;
    clear(head).append(h("h2", {}, v.title), h("div", { class: "muted" }, jobLine(v)));
    clear(body);
    body.append(jobChips(v, 8));
    if (v.blurb) body.append(h("p", { class: "blurbbox" }, v.blurb.text, h("span", { class: "muted small" }, v.blurb.by === "ai" ? "  Written by Claude from the posting." : "  Short extract from the posting.")));
    const facts = [];
    if (v.via && v.via !== "board" && v.via !== "manual") facts.push(["Found through", (GROUP_LABEL[v.group] || "search") + ": " + v.source_name]);
    if (v.score !== null && v.score !== undefined) facts.push(["Fit", h("span", {}, fitMeter(v.score), " ", h("span", { class: "muted small" }, "score " + v.score))]);
    if (isIso(v.posted)) facts.push(["Posted", niceDate(v.posted)]);
    if (v.first_seen) facts.push(["First seen here", niceDate(v.first_seen)]);
    if (v.years) facts.push(["Years asked", v.years + "+"]);
    if (v.pay) facts.push(["Pay listed", (v.pay[0] && v.pay[0] !== v.pay[1] ? money(v.pay[0]) + " to " : "") + money(v.pay[1])]);
    if (v.mark && v.mark.state === "declined" && v.mark.reason) facts.push(["You passed", v.mark.reason]);
    body.append(h("dl", { style: "display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:14px 0" }, facts.map(([k, val]) => [h("dt", { class: "muted small" }, k), h("dd", { style: "margin:0" }, val)])));
    if (d.note) body.append(h("p", { class: "job note" }, d.note));
    if (d.description) body.append(h("h3", { style: "margin:16px 0 8px" }, "Description"), h("div", { class: "desc" }, d.description));
    else if (d.error) body.append(h("div", { class: "empty" }, h("strong", {}, "No description here"), d.error));
    clear(foot);
    const st = v.mark && v.mark.state;
    [
      st === "saved" || st === "snoozed" ? h("button", { class: "btn", onclick: async () => { closeLayer(); await clearJob(v.id); } }, "Take off the plan") : st === "applied" ? null : h("button", { class: "btn primary", onclick: async () => { closeLayer(); await queueJob(v.id); } }, "Add to today's plan"),
      st !== "later" && st !== "applied" && st !== "declined" ? h("button", { class: "btn", onclick: async () => { closeLayer(); await futureJob(v.id); } }, "Save for later") : null,
      st !== "applied" ? h("button", { class: "btn good", onclick: () => applyModal(v) }, "I applied") : h("span", { class: "chip open" }, "Applied"),
      st !== "declined" && st !== "applied" ? h("button", { class: "btn soft-danger", onclick: () => declineModal(v) }, "Not for me") : null,
      v.source === "manual" ? h("button", { class: "btn", onclick: () => manualModal(v) }, "Edit") : null, origLink(v, "btn")].filter(Boolean).forEach((x) => foot.append(x));
  } catch (e) { clear(body).append(h("div", { class: "empty" }, h("strong", {}, "Could not open this listing"), e.message)); }
}

/* ---------- Today ---------- */
async function loadToday() { S.today = await api("/api/today"); renderToday(); updateChrome(); if (S.tab === "search" && !S.today.scanner.scan.running) paintScanBox(S.today.scanner.scan); }
function orbit(goal, done) {
  const R = 88, C = 2 * Math.PI * R, cx = 116, cy = 116, n = Math.max(1, goal);
  const svg = sv("svg", { viewBox: "0 0 232 232", role: "img", "aria-label": done + " of " + goal + " applications today" });
  svg.append(sv("circle", { cx, cy, r: R, fill: "none", stroke: "var(--line)", "stroke-width": 3 }));
  const from = Math.min(S.lastDone, goal), to = Math.min(done, goal);
  const arc = sv("circle", { class: "arc", cx, cy, r: R, fill: "none", stroke: "var(--open)", "stroke-width": 5, "stroke-linecap": "round", transform: "rotate(-90 " + cx + " " + cy + ")", "stroke-dasharray": C, "stroke-dashoffset": C * (1 - from / n) });
  svg.append(arc);
  for (let i = 0; i < n; i++) {
    const a = (-90 + (i * 360) / n) * Math.PI / 180, x = cx + R * Math.cos(a), y = cy + R * Math.sin(a), filled = i < done;
    svg.append(sv("circle", { class: "slot", cx: x, cy: y, r: 10, fill: filled ? "var(--open)" : "var(--paper)", stroke: filled ? "var(--open)" : "var(--mute)", "stroke-width": 2 }));
    if (filled) svg.append(sv("path", { d: "M" + (x - 4.5) + " " + y + " l3.4 3.6 l6 -7", fill: "none", stroke: "#fff", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  }
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute("stroke-dashoffset", C * (1 - to / n))));
  S.lastDone = to;
  return h("div", { class: "orbit" }, svg, h("div", { class: "mid" }, h("div", { class: "big num" }, String(done)), h("div", { class: "lbl" }, "of " + goal + " applications today")));
}
async function setReminder(body, msg) { try { await api("/api/hub/settings", "PUT", body); Object.assign(S.hub.settings, body); toast(msg); loadToday(); } catch (e) { fail(e); } }
function snoozeReminder(days) { const d = new Date(); d.setDate(d.getDate() + days); return setReminder({ reminder_snooze_until: iso(d) }, days === 1 ? "Snoozed. It comes back tomorrow." : "Snoozed. It comes back in a week (" + niceDate(iso(d)) + ")."); }
function stopReminder() { return setReminder({ reminder_dismissed: true }, "Reminder turned off. Turn it back on under How it works > Settings."); }
function heroLine(T) {
  const q = T.queue.filter((v) => !v.snoozed), dl = T.deadlines[0], n = dl ? dayDiff(dl.date) : null;
  if (T.applied_today >= T.goal) return "Goal met. Anything more today is a bonus; the Search tab is ready when you are.";
  const bits = [];
  if (q.length) bits.push(plural(q.length, "job") + " in today's plan.");
  else bits.push("Nothing in today's plan yet. Pick from the fresh finds or search for something new.");
  if (dl && n !== null && n >= 0 && n <= 10) bits.push(dl.label.split(":")[0] + " closes " + inDays(n) + ".");
  return bits.join(" ");
}
function planCard(v, i) {
  const done = v.mark && v.mark.state === "applied";
  return h("article", { class: "card job" + (done ? " done" : "") },
    h("div", { class: "idx" }, String(i + 1)),
    h("div", {},
      h("h3", {}, v.title), h("div", { class: "sub" }, jobLine(v) || "Add the location and link with Edit"),
      jobChips(v, 3),
      v.carried ? h("div", { class: "chips", style: "margin-top:6px" }, h("span", { class: "chip" }, "Carried over from " + niceDate(v.mark.saved_for))) : null,
      v.snoozed ? h("div", { class: "chips", style: "margin-top:6px" }, h("span", { class: "chip" }, "Back on " + niceDate(v.mark.saved_for))) : null,
      v.notes ? h("p", { class: "note" }, v.notes) : null,
      h("div", { class: "acts" },
        h("button", { class: "btn sm", onclick: () => showJob(v.id) }, "Read"),
        origLink(v) || h("button", { class: "btn sm", onclick: () => manualModal(v) }, "Add link"),
        h("button", { class: "btn sm good", onclick: () => applyModal(v) }, "I applied"),
        h("span", { class: "spacer" }),
        v.source === "manual" ? h("button", { class: "btn sm ghost", onclick: () => manualModal(v) }, "Edit") : null,
        h("button", { class: "btn sm ghost", onclick: () => laterJob(v.id), title: "Hide until tomorrow" }, "Tomorrow"),
        h("button", { class: "btn sm ghost", onclick: () => futureJob(v.id), title: "Keep on file for another day" }, "Later"),
        h("button", { class: "btn sm ghost soft-danger", onclick: () => declineModal(v) }, "Not for me"))));
}

/* ---------- To-dos and notes for tomorrow ---------- */
async function todoCall(body, msg) { try { await api("/api/todo", "POST", body); if (msg) toast(msg); await loadToday(); if (S.tab === "goals") await renderGoals(); } catch (e) { fail(e); } }
async function noteCall(body) { try { await api("/api/note", "POST", body); } catch (e) { fail(e); } }
function addTodoRow(due, ph, btn) {
  const inp = h("input", { placeholder: ph, "aria-label": ph, maxlength: 300 });
  const go1 = async () => { const t = inp.value.trim(); if (!t) { inp.focus(); return; } inp.value = ""; await todoCall({ op: "add", text: t, due }, due === todayIso() ? "Added to today's plan" : "Saved for tomorrow"); };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go1(); } });
  return h("div", { class: "addrow" }, inp, h("button", { class: "btn sm primary", onclick: go1 }, btn));
}
function todoModal(t) {
  const text = h("input", { value: t.text, maxlength: 300 }), note = h("textarea", {}), due = h("input", { type: "date", value: t.due });
  note.value = t.note || "";
  openModal("Edit to-do", h("div", { style: "display:grid;gap:12px" }, field("What", text), field("Details", note), field("Do it on", due)),
    [h("button", { class: "btn soft-danger", onclick: async () => { closeLayer(); await todoCall({ op: "delete", id: t.id }, "Removed"); } }, "Delete"), h("span", { style: "flex:1" }),
     h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
     h("button", { class: "btn primary", onclick: async () => { if (!text.value.trim()) return; closeLayer(); await todoCall({ op: "edit", id: t.id, text: text.value.trim(), note: note.value, due: due.value || t.due }, "Saved"); } }, "Save")]);
}
function taskCard(t) {
  const tmr = S.today.tomorrow;
  return h("article", { class: "card task" + (t.done ? " done" : "") },
    h("input", { type: "checkbox", checked: !!t.done, "aria-label": "Done: " + t.text, onchange: () => todoCall({ op: "toggle", id: t.id }) }),
    h("div", { class: "tx" }, h("strong", {}, t.text), t.note ? h("div", { class: "small muted" }, t.note) : null,
      t.carried ? h("div", { class: "chips", style: "margin-top:4px" }, h("span", { class: "chip" }, "Carried over from " + niceDate(t.due))) : null),
    h("div", { class: "chips" }, t.done ? null : h("button", { class: "btn sm ghost", onclick: () => todoCall({ op: "edit", id: t.id, due: tmr }, "Moved to tomorrow") }, "Tomorrow"), h("button", { class: "btn sm ghost", onclick: () => todoModal(t) }, "Edit")));
}
function smallMovesCard(T, where) {
  const again = where === "goals" ? renderGoals : loadToday;
  return h("div", { class: "card smallmoves" }, h("h3", {}, "Small moves"),
    T.bridging.length ? h("ul", { class: "lines" }, T.bridging.map((b) => h("li", {}, h("label", { style: "display:flex;gap:8px" }, h("input", { type: "checkbox", style: "accent-color:var(--open)", onchange: async () => { const g = S.hub.goals.bridging.find((x) => x.id === b.id); if (g) { g.done = true; await api("/api/hub/goals", "PUT", S.hub.goals); toast("Checked off"); again(); } } }), h("span", {}, b.action.split(" — ")[0]))))) : h("div", { class: "muted small" }, "Nothing open. Add items under Goals beyond applications."),
    where === "today" ? h("div", { style: "margin-top:8px" }, h("button", { class: "btn sm ghost", onclick: () => go("goals") }, "All goals and next steps")) : null);
}
function tomorrowCard(T) {
  const note = h("textarea", { placeholder: "Notes to yourself: who to follow up with, what to read, loose ends from today", "aria-label": "Notes for tomorrow", rows: 4 });
  note.value = (T.note_tomorrow && T.note_tomorrow.text) || "";
  let tm, saved = h("span", { class: "small muted", "aria-live": "polite" }, T.note_tomorrow ? "Saved" : "");
  const save = async () => { await noteCall({ op: "set_tomorrow", text: note.value }); saved.textContent = "Saved"; };
  note.addEventListener("input", () => { saved.textContent = "Typing…"; clearTimeout(tm); tm = setTimeout(save, 700); });
  note.addEventListener("blur", () => { clearTimeout(tm); if (saved.textContent === "Typing…") save(); });
  const later = T.tasks_later, snoozed = T.queue.filter((v) => v.snoozed);
  const lst = h("ul", { class: "lines later" });
  later.forEach((t) => lst.append(h("li", {}, h("span", {}, t.text, t.due > T.tomorrow ? h("span", { class: "small muted" }, "  · " + niceDate(t.due)) : null),
    h("span", { class: "chips" }, h("button", { class: "btn sm ghost", onclick: () => todoCall({ op: "edit", id: t.id, due: T.date }, "Moved to today") }, "Do today"), h("button", { class: "btn sm ghost", onclick: () => todoModal(t) }, "Edit")))));
  snoozed.forEach((v) => lst.append(h("li", {}, h("span", {}, v.employer + ": " + v.title), h("span", { class: "chips" }, h("button", { class: "btn sm ghost", onclick: () => queueJob(v.id) }, "Do today")))));
  return h("div", { class: "card tomorrow" }, h("h3", {}, "For tomorrow"),
    h("p", { class: "small muted", style: "margin:0 0 8px" }, "Anything here shows up in Today's plan when tomorrow starts. Jobs you push to tomorrow land here too."),
    addTodoRow(T.tomorrow, "Add a to-do for tomorrow", "Add"),
    lst.children.length ? lst : null, h("div", { class: "small", style: "margin:10px 0 4px;font-weight:600" }, "Notes"), note, h("div", {}, saved));
}
function renderToday() {
  const T = S.today, el = clear($("#v-today"));
  const d = new Date();
  const q = T.queue.filter((v) => !v.snoozed); // tomorrow's jobs are listed under "For tomorrow"
  const hero = h("div", { class: "hero" }, h("div", {}, h("h1", {}, d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })), h("p", {}, heroLine(T)),
    h("div", { class: "chips", style: "margin-top:14px" }, h("button", { class: "btn sm", onclick: () => manualModal() }, "Add a job by hand"))));
  hero.append(orbit(T.goal, T.applied_today));
  el.append(hero);
  if (T.reminder) el.append(h("div", { class: "banner reminder", role: "note" }, h("span", {}, T.reminder.text), h("span", { class: "chips" }, h("button", { class: "btn sm", onclick: () => go("process") }, "See the draft"), h("button", { class: "btn sm primary", onclick: () => snoozeReminder(1) }, "Remind me tomorrow"), h("button", { class: "btn sm", onclick: () => snoozeReminder(7) }, "In a week"), h("button", { class: "btn sm ghost", onclick: stopReminder, title: "Turns the reminder off until you switch it back on in How it works > Settings" }, "Stop reminding me"))));
  const plan = h("div", { class: "plan" });
  (T.notes_now || []).forEach((n) => el.append(h("div", { class: "banner note-left", role: "note" }, h("div", {}, h("strong", {}, "You left yourself a note" + (n.for < T.date ? " (for " + niceDate(n.for) + ")" : "")), h("div", { class: "notetext" }, n.text)), h("button", { class: "btn sm", onclick: async () => { await noteCall({ op: "dismiss", id: n.id }); loadToday(); } }, "Got it"))));
  (T.tasks_now || []).forEach((t) => plan.append(taskCard(t)));
  if (q.length) q.forEach((v, i) => plan.append(planCard(v, i)));
  else if (!(T.tasks_now || []).length) plan.append(h("div", { class: "empty" }, h("strong", {}, "Your plan is empty"), "Add listings from the fresh finds below, or search for new ones.", h("div", { style: "margin-top:10px" }, h("button", { class: "btn primary", onclick: () => go("search") }, "Open search"))));
  plan.append(addTodoRow(T.date, "Add a task to today's plan (call someone, write a letter, study)", "Add task"));
  if ((T.tasks_done || []).length) plan.append(h("details", { class: "donetasks" }, h("summary", {}, T.tasks_done.length + " task" + (T.tasks_done.length === 1 ? "" : "s") + " done today"), ...T.tasks_done.map((t) => taskCard(t))));
  const fresh = h("div", { class: "card" });
  if (T.fresh.length) T.fresh.forEach((v) => fresh.append(h("div", { class: "find" }, h("div", {}, h("div", { class: "t" }, h("a", { href: "#", style: "color:inherit;text-decoration:none", onclick: (e) => { e.preventDefault(); showJob(v.id); } }, v.title)), h("div", { class: "s" }, jobLine(v)), v.blurb ? h("div", { class: "blurb" }, v.blurb.text) : null, h("div", { style: "margin-top:4px" }, fitMeter(v.score))),
    h("div", { class: "chips" }, h("button", { class: "btn sm primary", onclick: () => queueJob(v.id) }, "Add to plan"), h("button", { class: "btn sm ghost", onclick: () => passJob(v.id) }, "Pass")))));
  else fresh.append(h("div", { class: "empty", style: "border:0" }, h("strong", {}, "No fresh finds yet"), "Run a refresh from the Search tab to pull current openings."));
  const laterBox = h("div", { class: "card" });
  if ((T.later || []).length) T.later.forEach((v) => laterBox.append(h("div", { class: "find" }, h("div", {}, h("div", { class: "t" }, h("a", { href: "#", style: "color:inherit;text-decoration:none", onclick: (e) => { e.preventDefault(); showJob(v.id); } }, v.title)), h("div", { class: "s" }, jobLine(v) + (v.deadline ? " · closes " + niceDate(v.deadline) : ""))),
    h("div", { class: "chips" }, h("button", { class: "btn sm primary", onclick: () => queueJob(v.id) }, "Do today"), h("button", { class: "btn sm ghost", onclick: () => laterJob(v.id) }, "Tomorrow"), h("button", { class: "btn sm ghost soft-danger", onclick: () => declineModal(v) }, "Not for me")))));
  else laterBox.append(h("div", { class: "empty", style: "border:0" }, h("strong", {}, "Nothing saved for later"), "Choose Later when you add a job by hand, or press Later on a job in today's plan."));
  const left = h("div", {}, h("div", { class: "section-head" }, h("h2", {}, "Today's plan"), h("span", { class: "muted small" }, "Work top to bottom")), plan,
    h("div", { class: "section-head" }, h("h2", {}, "Fresh finds"), h("span", { class: "muted small" }, T.fresh_date ? "From the scan on " + niceDate(T.fresh_date) + ", best fit first" : "")), fresh,
    h("div", { class: "section-head" }, h("h2", {}, "Saved for later"), h("span", { class: "muted small" }, "Not for today. Pull one in when you are ready")), laterBox);
  const c = T.counts, mx = Math.max(1, ...T.week.map((w) => w.n));
  const comingUp = T.deadlines.filter((x) => { const n = dayDiff(x.date); return n === null || n >= 0; }); // a date that has gone by drops off
  const week = h("div", { class: "week", role: "img", "aria-label": "Applications over the last 7 days" }, T.week.map((w) => h("div", { title: niceDate(w.date) + ": " + w.n }, h("i", { class: w.n ? "" : "zero", style: "height:" + (w.n ? 8 + (w.n / mx) * 40 : 3) + "px" }), new Date(w.date + "T00:00").toLocaleDateString(undefined, { weekday: "narrow" }))));
  const side = h("div", { class: "side" },
    tomorrowCard(T),
    h("div", { class: "card" }, h("h3", {}, "Where things stand"), h("div", { class: "tiles" },
      h("button", { class: "tile open", onclick: () => { S.rec.group = "open"; go("records"); } }, h("b", { class: "num" }, String(c.open)), h("span", {}, "open")),
      h("button", { class: "tile wait", onclick: () => { S.rec.group = "waitlist"; go("records"); } }, h("b", { class: "num" }, String(c.waitlist)), h("span", {}, "waitlist")),
      h("button", { class: "tile rej", onclick: () => { S.rec.group = "closed"; go("records"); } }, h("b", { class: "num" }, String(c.closed)), h("span", {}, "closed")))),
    h("div", { class: "card" }, h("h3", {}, "Last 7 days"), week),
    comingUp.length ? h("div", { class: "card comingup" }, h("h3", {}, "Coming up"), h("ul", { class: "lines" }, comingUp.map((x) => { const n = dayDiff(x.date); return h("li", {}, h("span", {}, x.label), h("span", { class: "chip deadline" }, n !== null ? inDays(n) : niceDate(x.date))); }))) : null,
    smallMovesCard(T, "today"));
  el.append(h("div", { class: "cols" }, left, side));
  wantBlurbs(T.fresh);
}

/* ---------- Search ---------- */
const RM = [["include", "Include remote"], ["only", "Only remote"], ["exclude", "Hide remote"]];
const SHOWS = [["undecided", "New"], ["saved", "Queued"], ["later", "Later"], ["declined", "Passed"], ["applied", "Applied"], ["all", "All"]];
const SRCS = [["all", "All"], ["jobboard", "Job boards"], ["local", "Local employers"], ["large", "Large employers"], ["small", "Small employers"]];
const GROUP_LABEL = { jobboard: "Job board", local: "Local employer", large: "Large employer", small: "Small employer" };
const normTerm = (x) => x.trim().replace(/^[-−–—!]+\s*/, "-").toLowerCase();
const whereTerms = (s) => (s || "").split(/[;,]/).map((x) => x.trim()).filter(Boolean);
function whereText(w) {
  if (!w) return "";
  const a = w.include.length ? "Looking in " + w.include.join(", ") : "Looking anywhere in the US and EU";
  return a + (w.exclude.length ? ", leaving out " + w.exclude.join(", ") : "");
}
function renderSearch() {
  const el = clear($("#v-search")), P = S.search.p;
  if (!P.city && !S.search.init) { P.city = S.hub.settings.default_city || ""; S.search.init = true; }
  let paintChips = () => {};
  const city = h("input", { id: "f-city", value: P.city, placeholder: "New York, London, -Remote  (blank = US + EU)", "aria-label": "Where", oninput: (e) => { P.city = e.target.value; paintChips(); debounced(); } });
  const q = h("input", { value: P.q, placeholder: "e.g. policy analyst, simulation, resilience", "aria-label": "What", oninput: (e) => { P.q = e.target.value; debounced(); } });
  const cityState = (c) => { const t = whereTerms(P.city).map(normTerm); return t.includes(c.toLowerCase()) ? "in" : t.includes("-" + c.toLowerCase()) ? "out" : "off"; };
  const cityChips = h("div", { class: "pick" });
  paintChips = () => clear(cityChips).append(...(S.hub.settings.cities || []).map((c) => {
    const st = cityState(c);
    return h("button", { class: st === "out" ? "out" : "", "aria-pressed": String(st === "in"), title: "Click once to include, again to leave it out, again to clear", onclick: () => {
      const now = cityState(c); // read the box as it is now, not as it was when the chips were drawn
      let t = whereTerms(P.city).filter((x) => { const n = normTerm(x); return n !== c.toLowerCase() && n !== "-" + c.toLowerCase(); });
      if (now === "off") t.push(c); else if (now === "in") t.push("-" + c);
      P.city = t.join(", "); renderSearch(); runSearch();
    } }, (st === "out" ? "− " : "") + c);
  }));
  paintChips();
  const trackChips = h("div", { class: "pick" }, TRACKS.map((t) => h("button", { "aria-pressed": String(P.track === t), onclick: () => { P.track = P.track === t ? "" : t; renderSearch(); runSearch(); } }, t)));
  const seg = (opts, key) => h("div", { class: "seg", role: "group" }, opts.map(([v, t]) => h("button", { "aria-pressed": String(P[key] === v), onclick: () => { P[key] = v; renderSearch(); runSearch(); } }, t)));
  const sc = S.today ? S.today.scanner : null;
  const filters = h("div", { class: "card filters" },
    h("div", { class: "row top" }, h("div", { class: "grow field" }, h("span", {}, "Where"), city, cityChips, h("div", { class: "hint" }, "Leave blank for anywhere in the US and EU. Put a minus in front to leave a place out: ", h("code", {}, "New York, London, -Remote"), ".")), h("div", { class: "grow field" }, h("span", {}, "What"), q)),
    h("div", { class: "field" }, h("span", {}, "Kind of work"), trackChips),
    h("div", { class: "row" }, h("div", { class: "field" }, h("span", {}, "Remote roles"), seg(RM, "remote")), h("div", { class: "field" }, h("span", {}, "Show"), seg(SHOWS, "show")), h("div", { class: "field" }, h("span", {}, "Found by"), seg(SRCS, "src")),
      field("Minimum fit", select([["-99", "Any"], ["2", "Possible+"], ["3", "Decent+"], ["4", "Good+"], ["6", "Strong only"]], P.min, { onchange: (e) => { P.min = e.target.value; runSearch(); } })),
      field("Sort by", select([["fit", "Best fit"], ["new", "Newest here"], ["posted", "Posted date"]], P.sort, { onchange: (e) => { P.sort = e.target.value; runSearch(); } }))),
    h("div", { class: "scanbox", id: "scanbox" }));
  el.append(h("div", { class: "section-head" }, h("h2", {}, "Active Jobs and Search"), h("button", { class: "btn sm", onclick: () => manualModal() }, "Add a job by hand")), filters, h("div", { id: "resbox", role: "listbox", "aria-label": "Search results" }));
  paintScanBox(sc ? sc.scan : { running: false });
}
let dT; function debounced() { clearTimeout(dT); dT = setTimeout(() => runSearch(), 280); }
function qs() { const P = S.search.p, o = Object.assign({}, P, { limit: S.search.limit, offset: 0 }); return Object.entries(o).filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&"); }
async function runSearch(keep) {
  const box = $("#resbox"); if (!box) return;
  if (!keep) S.search.limit = 25;
  try { S.search.data = await api("/api/jobs?" + qs()); } catch (e) { return fail(e); }
  if (!keep) S.search.sel = 0; S.search.sel = Math.min(S.search.sel, Math.max(0, S.search.data.jobs.length - 1));
  paintResults();
  wantBlurbs(S.search.data.jobs);
}
/* short summaries: ask the hub to write the missing ones, then repaint when it is done */
const askedBlurb = new Set(); let blurbT;
async function wantBlurbs(jobs) {
  const ids = (jobs || []).filter((v) => !v.blurb && !askedBlurb.has(v.id)).map((v) => v.id);
  if (!ids.length) return;
  ids.forEach((i) => askedBlurb.add(i));
  try {
    const r = await api("/api/blurbs", "POST", { ids });
    if (r.busy) ids.forEach((i) => askedBlurb.delete(i));
    if (r.queued || r.busy) { S.search.writing = true; if (S.tab === "search" && S.search.data) paintResults(); pollBlurbs(); }
  } catch (e) { /* summaries are a nicety; the list still works */ }
}
function pollBlurbs() {
  clearInterval(blurbT);
  blurbT = setInterval(async () => {
    try {
      const d = await api("/api/blurbs/status");
      if (!d.blurb.running) { clearInterval(blurbT); S.search.writing = false; if (S.tab === "search") await runSearch(true); else if (S.tab === "today") await loadToday(); }
    } catch (e) { clearInterval(blurbT); S.search.writing = false; }
  }, 2500);
}
function paintResults() {
  const box = clear($("#resbox")), D = S.search.data; if (!D) return;
  const sc = S.today ? S.today.scanner : { jobs: 0 };
  const bs = D.by_source || {}, GN = { jobboard: "job boards", local: "local employers", large: "large employers", small: "small employers" }, mix = Object.entries(bs).filter(([, n]) => n).map(([k, n]) => n + " from " + GN[k]).join(", ");
  box.append(h("div", { class: "section-head", style: "margin:16px 0 4px" }, h("span", { class: "muted" }, D.total === 0 ? "No listings match" : (D.in_city !== null && D.in_city !== undefined && D.where && D.where.include.length ? D.in_city.toLocaleString() + " in " + D.where.include.join(", ") + ", " + (D.total - D.in_city).toLocaleString() + " remote or nearby" : plural(D.total, "listing") + " match") + (mix ? " (" + mix + ")" : "") + (sc.jobs ? ", out of " + sc.jobs.toLocaleString() + " saved" : "")), h("span", { class: "muted small" }, "Keys: ↑ ↓ move, Enter read, Q add to plan, X pass, O open original")),
    h("div", { class: "wherenote muted small" }, whereText(D.where) + (S.search.writing ? " · writing short summaries…" : "")));
  if (!D.jobs.length) { box.append(h("div", { class: "empty" }, h("strong", {}, "Nothing here yet"), "Widen the place, lower the minimum fit, or press Refresh search to pull current openings.")); return; }
  const list = h("div", { class: "results" });
  D.jobs.forEach((v, i) => {
    const st = v.mark && v.mark.state, isNew = v.first_seen === todayIso();
    list.append(h("div", { class: "res", role: "option", "aria-selected": String(i === S.search.sel), "data-i": i, onclick: () => { S.search.sel = i; paintResults(); showJob(v.id); } },
      h("div", { class: "fitbox" }, h("b", { class: "num" }, String(v.score)), "fit"),
      h("div", {}, h("div", { class: "t" }, v.title, isNew ? h("span", { class: "newtag" }, "new today") : null), h("div", { class: "s" }, jobLine(v) + (isIso(v.posted) ? " · posted " + niceDate(v.posted) : "")),
        v.blurb ? h("div", { class: "blurb" }, v.blurb.text) : null,
        h("div", { style: "margin-top:6px" }, jobChips(v, 3), v.via && v.via !== "board" ? h("span", { class: "chip via g-" + v.group }, (GROUP_LABEL[v.group] || "Found") + ": " + v.source_name) : null)),
      h("div", { class: "acts", onclick: (e) => e.stopPropagation() },
        st === "saved" || st === "snoozed" ? h("span", { class: "chip open" }, "In plan") : st === "later" ? h("span", { class: "chip" }, "Saved for later") : st === "declined" ? h("span", { class: "chip rej" }, "Passed") : st === "applied" ? h("span", { class: "chip open" }, "Applied") : [h("button", { class: "btn sm primary", onclick: () => queueJob(v.id) }, "Add to plan"), h("button", { class: "btn sm ghost", onclick: () => passJob(v.id) }, "Pass")],
        origLink(v, "btn sm ghost"))));
  });
  box.append(list);
  if (D.total > D.jobs.length) box.append(h("div", { style: "margin-top:12px" }, h("button", { class: "btn", onclick: () => { S.search.limit += 25; runSearch(true); } }, "Show 25 more (" + (D.total - D.jobs.length) + " left)")));
  const sel = list.querySelector('[aria-selected="true"]'); if (sel && document.activeElement === box) sel.scrollIntoView({ block: "nearest" });
}
function searchKeys(e) {
  const D = S.search.data; if (!D || !D.jobs.length || e.target.closest("input,select,textarea")) return;
  const v = D.jobs[S.search.sel], k = e.key.toLowerCase();
  if (k === "arrowdown" || k === "j") { S.search.sel = Math.min(D.jobs.length - 1, S.search.sel + 1); paintResults(); e.preventDefault(); }
  else if (k === "arrowup" || k === "k") { S.search.sel = Math.max(0, S.search.sel - 1); paintResults(); e.preventDefault(); }
  else if (k === "enter") showJob(v.id);
  else if (k === "q") queueJob(v.id);
  else if (k === "x") passJob(v.id);
  else if (k === "o" && v.url) window.open(v.url, "_blank", "noopener");
}
const LAYERS = [["boards", "Job boards", "jobboard"], ["local", "Local employers", "local"], ["large", "Large employers", "large"], ["small", "Small employers", "small"]];
function paintScanBox(sc) {
  const box = $("#scanbox"); if (!box) return; clear(box);
  const info = S.today ? S.today.scanner : { boards: 0, last_run: "" };
  if (sc.running) { box.append(h("div", { style: "flex:1;min-width:220px" }, h("div", {}, h("strong", {}, sc.phase || "Working…")), h("div", { class: "muted small" }, "This can take a few minutes. You can keep using the page."), h("div", { class: "meter", style: "margin-top:8px" }, h("i"))));
  } else {
    box.append(h("div", { style: "display:grid;gap:8px;flex:1;min-width:260px" },
      h("div", { class: "chips" }, h("button", { class: "btn primary", onclick: startScan }, "Refresh search"),
        h("div", { class: "pick layerpick", role: "group", "aria-label": "Sections to search" }, LAYERS.map(([k, t, g]) => h("button", { class: "lp", "aria-pressed": String(S.search.layers[k]), onclick: () => { S.search.layers[k] = !S.search.layers[k]; paintScanBox(sc); } }, t)))),
      h("div", { class: "layerinfo" },
        h("div", { class: "lhead" }, "Refresh search looks at the sections switched on above, for the places in ", h("b", {}, "Where"), "."),
        h("div", {}, h("b", {}, "Job boards"), ": LinkedIn and Indeed (via " + (info.web_engine || "DuckDuckGo") + " web search) and " + ((info.counts || {}).board || 0) + " other board pages."),
        h("div", {}, h("b", {}, "Local employers"), ": " + ((info.counts || {}).local || 0) + " local sites, only for the places in Where."),
        h("div", {}, h("b", {}, "Large employers"), ": " + (info.boards || 0) + " job boards and " + ((info.counts || {}).large || 0) + " career pages, narrowed to those places."),
        h("div", {}, h("b", {}, "Small employers"), ": " + ((info.counts || {}).small || 0) + " pages. ", h("b", {}, "Off by default"), ": they run on their own once a week" + (info.small_auto === false ? " (automatic check is off)" : "") + ". Last run " + (info.small_last ? niceDate(info.small_last) : "never") + ". Switch it on to run them now."),
        h("div", { class: "muted" }, "Last refresh: ", h("b", {}, info.last_run ? niceDate(info.last_run) : "never"), ". Every page the search reaches is marked ", h("b", {}, "Checked today"), " in Employers and Resources.")),
      sc.error ? h("span", { class: "chip warn" }, "Last refresh failed: " + sc.error) : null,
      sc.message && sc.finished ? h("div", { class: "muted small" }, sc.message.split("\n").map((l) => h("div", {}, l))) : null,
      h("details", { class: "localsites", ontoggle: (e) => { if (e.target.open) loadSources(); } }, h("summary", {}, "Local sites searched for these places"), h("div", { id: "srcbody" }))));
  }
}
async function loadSources() {
  const body = $("#srcbody"); if (!body) return; clear(body).append(h("div", { class: "muted small" }, "Loading…"));
  const P = S.search.p;
  try {
    const d = await api("/api/sources?q=" + encodeURIComponent(P.q) + "&city=" + encodeURIComponent(P.city) + "&track=" + encodeURIComponent(P.track));
    clear(body);
    const rows = d.local.map((s) => h("li", {}, h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.name), h("span", { class: "muted small" }, " · " + s.city + " · " + (s.at ? (s.found ? s.found + " found " : "none found, ") + (s.note || "") + " (" + niceDate(s.at) + ")" : "not checked yet"))));
    body.append(h("p", { class: "small", style: "margin:6px 0" }, d.google_link ? ["Also try the same search on ", h("a", { href: d.google_link, target: "_blank", rel: "noopener noreferrer" }, "Google Jobs ↗"), "."] : ""),
      rows.length ? h("ul", { class: "lines" }, rows) : h("div", { class: "muted small" }, "No local sites listed for these places yet."),
      h("div", { class: "chips", style: "margin-top:8px" }, h("button", { class: "btn sm", onclick: () => { S.resTab = "local"; const p0 = whereTerms(P.city).filter((x) => !/^[-−–—!]/.test(x))[0]; if (p0) S.resCity = p0; go("resources"); } }, "Add or find local sites"), h("span", { class: "muted small" }, "Local sites are managed under Employers and Resources > Local-Specific Job Resources.")));
  } catch (e) { clear(body).append(h("div", { class: "muted small" }, e.message)); }
}
async function startScan() {
  const P = S.search.p;
  try { const r = await api("/api/scan", "POST", { city: P.city, remote: P.remote !== "exclude", layers: S.search.layers, q: P.q, track: P.track }); if (!r.ok) return toast(r.error, true); } catch (e) { return fail(e); }
  pollScan();
}
function pollScan() {
  clearInterval(S.scanTimer);
  const tick = async () => {
    try {
      const d = await api("/api/scan/status"); if (S.today) S.today.scanner = d.info; paintScanBox(d.scan);
      if (!d.scan.running) { clearInterval(S.scanTimer); if (!d.scan.error) toast("Refresh finished. " + (d.scan.new || 0) + " new listings."); await loadToday(); if (S.tab === "search") runSearch(); }
    } catch (e) { clearInterval(S.scanTimer); }
  };
  tick(); S.scanTimer = setInterval(tick, 2500);
}

/* ---------- chrome, routing, boot ---------- */
function updateChrome() {
  const T = S.today; if (!T) return;
  $("#c-today").textContent = (T.queue.filter((v) => !v.snoozed).length + (T.tasks_now || []).length) || "";
  $("#c-records").textContent = T.counts.open || "";
  $("#c-errors").textContent = T.errors_new || "";
  const sc = T.scanner;
  clear($("#railfoot")).append(h("div", {}, sc.available ? sc.jobs.toLocaleString() + " listings saved" : "Scanner not found"), h("div", {}, sc.last_run ? "Last scan " + niceDate(sc.last_run) : "No scan yet"), h("div", {}, sc.boards + " employer boards"), h("button", { class: "btn sm ghost quit", title: "Stops the Daily Hub program. Everything is already saved.", onclick: quitHub }, "Quit Daily Hub"));
}
async function quitHub() {
  if (!confirm("Quit the Daily Hub? Everything is already saved. Start it again from the desktop shortcut.")) return;
  try { await api("/api/quit", "POST", {}); } catch (e) { /* the server closes the connection */ }
  document.body.replaceChildren(h("main", { style: "padding:48px;max-width:520px;margin:auto" }, h("h1", {}, "Daily Hub has stopped"), h("p", {}, "Your data is saved. Open the desktop shortcut to start it again, then close this tab.")));
}
const TABS = ["today", "search", "records", "goals", "networking", "resources", "process", "errors"];
function go(tab) { location.hash = tab; }
async function show(tab) {
  if (!TABS.includes(tab)) tab = "today"; S.tab = tab;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "v-" + tab));
  document.querySelectorAll("#nav button").forEach((b) => { if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  document.body.dataset.tab = tab;
  document.title = { today: "Today", search: "Active Jobs and Search", records: "Records", goals: "Goals and Next Steps", networking: "Networking", resources: "Employers and Resources", process: "How it works", errors: "Error log" }[tab] + " · Daily Hub";
  window.scrollTo(0, 0);
  if (tab === "today") await loadToday().catch(fail);
  if (tab === "search") { renderSearch(); runSearch(); }
  if (tab === "records") renderRecords();
  if (tab === "goals") await renderGoals();
  if (tab === "networking") renderNetworking();
  if (tab === "resources") await renderResources();
  if (tab === "process") renderProcess();
  if (tab === "errors") renderErrors();
}
async function boot() {
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  clear($("#v-today")).append(h("div", { class: "skel", style: "width:40%;height:34px" }), h("div", { class: "skel", style: "width:60%" }), h("div", { class: "skel", style: "width:50%" }));
  $("#v-today").hidden = false;
  try {
    S.hub = await api("/api/hub"); const info = await api("/api/scan/status");
    if (info.scan.running) pollScan();
  } catch (e) { $("#v-today").hidden = false; clear($("#v-today")).append(h("div", { class: "empty" }, h("strong", {}, "The hub server is not answering"), "Start it again with launch_hub.sh and reload this page. " + e.message)); return; }
  show(location.hash.slice(1) || "today");
  setInterval(refreshErrBadge, 20000);
}
