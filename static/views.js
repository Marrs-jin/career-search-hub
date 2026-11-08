'use strict';
/* Daily Hub front end, part 2: Records, Goals, Resources, How it works. */

const stClass = (s) => ({ Applied: "open", Interview: "int", Offer: "offer", Waitlisted: "wait", Watching: "wait", Rejected: "rej", Withdrawn: "rej" }[s] || "");
const grpOf = (s) => (OPEN_ST.includes(s) ? "open" : WAIT_ST.includes(s) ? "waitlist" : "closed");
async function saveApps() { try { await api("/api/hub/applications", "PUT", S.hub.applications); await loadToday(); } catch (e) { fail(e); } }
async function saveGoals() { try { await api("/api/hub/goals", "PUT", S.hub.goals); } catch (e) { fail(e); } }
async function saveRes() { try { await api("/api/hub/resources", "PUT", S.hub.resources); } catch (e) { fail(e); } }
async function saveNet() { try { await api("/api/hub/networking", "PUT", S.hub.networking); } catch (e) { fail(e); } }
function linkify(text) {
  const out = []; let last = 0; const rx = /https?:\/\/[^\s)]+/g; let m;
  while ((m = rx.exec(text))) { out.push(text.slice(last, m.index)); out.push(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0])); last = m.index + m[0].length; }
  out.push(text.slice(last)); return out;
}
function ago(isoDate) { if (!isoDate) return "not checked yet"; const n = -dayDiff(isoDate); return n <= 0 ? "checked today" : n === 1 ? "checked yesterday" : "checked " + n + " days ago"; }
function uid(p) { return p + Math.random().toString(36).slice(2, 10); }
function confirmModal(title, text, label, fn) {
  openModal(title, h("p", { style: "margin:0" }, text), [h("button", { class: "btn", onclick: closeLayer }, "Cancel"), h("button", { class: "btn primary", onclick: () => { closeLayer(); fn(); } }, label)]);
}

/* ---------- Records ---------- */
function recFiltered() {
  const R = S.rec, q = R.q.toLowerCase();
  return S.hub.applications.filter((a) => (R.group === "all" || grpOf(a.status) === R.group) && (!R.track || tracksOf(a).includes(R.track)) && (!q || (a.org + " " + a.role + " " + (a.notes || "")).toLowerCase().includes(q)))
    .sort((a, b) => (b.date_applied || "").localeCompare(a.date_applied || "") || (b.num || 0) - (a.num || 0));
}
function recCard(a) {
  const sel = h("select", { class: "statsel chip " + stClass(a.status), "aria-label": "Status for " + a.org, onclick: (e) => e.stopPropagation(), onchange: async (e) => { e.stopPropagation(); a.status = e.target.value; await saveApps(); renderRecords(); } }, ALL_ST.map((s) => h("option", { value: s, selected: s === a.status }, s)));
  return h("article", { class: "card rec s-" + a.status, tabindex: "0", onclick: () => recModal(a), onkeydown: (e) => { if (e.key === "Enter") recModal(a); } },
    h("div", { class: "o" }, a.org), h("div", { class: "r" }, a.role || "No role listed"),
    h("div", { class: "m" }, sel, a.date_applied ? h("span", {}, "applied " + niceDate(a.date_applied)) : null, a.deadline ? h("span", { class: "chip deadline" }, "closes " + niceDate(a.deadline)) : null, tracksOf(a).length ? h("span", { class: "small" }, (a.tracks_est ? "~ " : "") + tracksOf(a).join(" · ")) : null, a.priority ? h("span", { class: "chip warn" }, a.priority + " priority") : null),
    a.notes ? h("div", { class: "n" }, a.notes) : null);
}
function renderRecords() {
  const el = clear($("#v-records")), R = S.rec, apps = S.hub.applications, cnt = { open: 0, waitlist: 0, closed: 0 };
  apps.forEach((a) => cnt[grpOf(a.status)]++);
  const sum = (k, cls, label) => h("button", { class: "sum " + cls, "aria-pressed": String(R.group === k), onclick: () => { R.group = R.group === k ? "all" : k; R.showAllClosed = false; renderRecords(); } }, h("b", { class: "num" }, String(cnt[k])), h("span", {}, label));
  el.append(h("div", { class: "section-head" }, h("h2", {}, "Records"), h("button", { class: "btn primary", onclick: () => recModal() }, "Add a record")),
    h("div", { class: "summary" }, sum("open", "open", "Open: applied, interviewing, offers"), sum("waitlist", "wait", "Waitlist: waitlisted or watching"), sum("closed", "rej", "Closed: rejected or withdrawn")));
  const sugg = apps.filter((a) => a.suggest);
  if (sugg.length) el.append(h("div", { class: "banner", role: "note" }, h("span", {}, plural(sugg.length, "record") + " marked Rejected look like watchlist entries (their notes say to check back)."), h("button", { class: "btn sm", onclick: () => suggestModal() }, "Review them")));
  const tracks = [...TRACKS, ...EXTRA_TAGS].filter((t) => apps.some((a) => tracksOf(a).includes(t)));
  el.append(h("div", { class: "toolbar" }, h("input", { type: "search", placeholder: "Search organization, role, notes", value: R.q, "aria-label": "Search records", oninput: (e) => { R.q = e.target.value; renderRecordsBody(); } }),
    select([["", "All tracks"], ...tracks.map((t) => [t, t])], R.track, { "aria-label": "Track", onchange: (e) => { R.track = e.target.value; renderRecordsBody(); } }),
    h("div", { class: "seg", role: "group", "aria-label": "View" }, [["board", "Board"], ["table", "Table"]].map(([v, t]) => h("button", { "aria-pressed": String(R.view === v), onclick: () => { R.view = v; localStorage.setItem("hub.recview", v); renderRecords(); } }, t)))),
    h("div", { id: "recbody" }));
  renderRecordsBody();
}
function renderRecordsBody() {
  const body = clear($("#recbody")), R = S.rec, list = recFiltered();
  if (!list.length) return body.append(h("div", { class: "empty" }, h("strong", {}, "No records match"), "Clear the search or pick another group."));
  if (R.view === "table") {
    return body.append(h("div", { style: "overflow:auto" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, ["Organization", "Role", "Status", "Track", "Applied", "Notes"].map((c) => h("th", {}, c)))),
      h("tbody", {}, list.map((a) => h("tr", { class: "clk", tabindex: "0", onclick: () => recModal(a), onkeydown: (e) => { if (e.key === "Enter") recModal(a); } }, h("td", {}, a.org), h("td", {}, a.role), h("td", {}, h("span", { class: "chip " + stClass(a.status) }, a.status)), h("td", {}, (a.tracks_est ? "~ " : "") + tracksOf(a).join(" · ")), h("td", { class: "num" }, a.date_applied ? niceDate(a.date_applied) : ""), h("td", {}, a.notes)))))));
  }
  const groups = [["open", "Open", "Applications still in play"], ["waitlist", "Waitlist", "Waitlisted, or watching for a role"], ["closed", "Closed", "Rejected or withdrawn"]];
  const shown = R.group === "all" ? groups : groups.filter((g) => g[0] === R.group);
  const board = h("div", { class: "board", style: R.group === "all" ? "" : "grid-template-columns:repeat(auto-fill,minmax(290px,1fr))" });
  shown.forEach(([k, title, sub]) => {
    const items = list.filter((a) => grpOf(a.status) === k), lim = k === "closed" && R.group === "all" && !R.showAllClosed ? 10 : 9999;
    const col = h("div", { class: R.group === "all" ? "col" : "", style: R.group === "all" ? "" : "display:contents" });
    if (R.group === "all") col.append(h("h3", {}, title, h("span", { class: "muted small num" }, items.length)));
    if (!items.length) col.append(h("div", { class: "empty" }, h("strong", {}, k === "open" ? "Nothing open right now" : "Nothing here"), k === "open" ? "Applications you submit land here. " + (S.today && S.today.queue.length ? plural(S.today.queue.length, "job") + " waiting in today's plan." : "") : sub));
    items.slice(0, lim).forEach((a) => col.append(recCard(a)));
    if (items.length > lim) col.append(h("button", { class: "btn", onclick: () => { R.showAllClosed = true; renderRecordsBody(); } }, "Show all " + items.length));
    board.append(col);
  });
  body.append(board);
}
function suggestModal() {
  const box = h("div", { style: "display:grid;gap:10px" });
  const draw = () => { clear(box); const s = S.hub.applications.filter((a) => a.suggest); if (!s.length) { closeLayer(); renderRecords(); return; }
    s.forEach((a) => box.append(h("div", { class: "card", style: "padding:10px 12px" }, h("strong", {}, a.org + ": " + a.role), h("div", { class: "muted small", style: "margin:2px 0 8px" }, a.notes), h("div", { class: "chips" },
      h("button", { class: "btn sm primary", onclick: async () => { a.status = a.suggest.status; delete a.suggest; await saveApps(); draw(); } }, "Move to " + a.suggest.status), h("button", { class: "btn sm", onclick: async () => { delete a.suggest; await saveApps(); draw(); } }, "Keep as Rejected"))))); };
  draw(); openModal("Review suggestions", box, [h("button", { class: "btn", onclick: () => { closeLayer(); renderRecords(); } }, "Done")]);
}
function recModal(a) {
  const edit = !!a, v = (k, d = "") => (a && a[k]) || d;
  const org = h("input", { value: v("org") }), role = h("input", { value: v("role") }), status = select(ALL_ST, v("status", "Applied")),
    date = h("input", { type: "date", value: v("date_applied") }), dl = h("input", { type: "date", value: v("deadline") }), resume = select(["", ...(S.hub.settings.resume_versions || [])], v("resume")),
    url = h("input", { type: "url", value: v("url") }), pr = select([["", "Normal"], ["High", "High"]], v("priority")), notes = h("textarea", {}); notes.value = v("notes");
  let lastSugg = resumeFor(tracksOf(a));
  const hint = h("div", { class: "small muted" }, "Pick a track and, if the resume box is empty, the matching resume fills in.");
  const tp = trackPicker(tracksOf(a), (sel) => { const s = resumeFor(sel); if (!resume.value || resume.value === lastSugg) resume.value = s; lastSugg = s; hint.textContent = s ? "Suggested from the main track: " + s : hint.textContent; });
  openModal(edit ? "Edit record" : "Add a record", h("div", { style: "display:grid;gap:12px" }, field("Organization", org), field("Role", role),
    field("Status", status), h("div", { class: "field" }, h("span", {}, a && a.tracks_est ? "Track (more than one is fine) · estimated, edit to confirm" : "Track (more than one is fine)"), tp.el), h("div", { class: "grid2" }, field("Date applied", date), field("Closes on", dl)),
    h("div", { class: "grid2" }, field("Resume version", resume), field("Priority", pr)), hint, field("Link to the posting", url), field("Notes", notes)),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: () => confirmModal("Delete this record?", a.org + ": " + a.role + " will be removed from your records.", "Delete", async () => { S.hub.applications = S.hub.applications.filter((x) => x !== a); await saveApps(); renderRecords(); }) }, "Delete") : null,
      h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => {
        if (!org.value.trim()) return toast("Add an organization first.", true);
        const rec = a || { id: uid("app_"), num: S.hub.applications.length + 1 };
        Object.assign(rec, { org: org.value.trim(), role: role.value.trim(), tracks: tp.get(), track: tp.get()[0] || "", tracks_est: false, status: status.value, date_applied: date.value, deadline: dl.value, resume: resume.value, url: url.value, priority: pr.value, notes: notes.value });
        delete rec.suggest; if (!a) S.hub.applications.push(rec);
        closeLayer(); await saveApps(); renderRecords(); toast("Saved"); } }, "Save")]);
}

/* ---------- Goals ---------- */
async function renderGoals() {
  const el = clear($("#v-goals")), G = S.hub.goals;
  try { S.today = await api("/api/today"); } catch (e) { fail(e); }
  el.append(h("div", { class: "section-head" }, h("h2", {}, "Goals and Next Steps"), h("span", { class: "muted small" }, "What is next, and the small moves that make the applications land")));
  if (S.today) el.append(h("div", { class: "nextsteps" }, tomorrowCard(S.today), smallMovesCard(S.today, "goals")));
  el.append(h("div", { class: "section-head" }, h("h2", {}, "Goals beyond applications")));
  const three = h("div", { class: "three" });
  three.append(checkPanel("Bridging moves", "Things that build credibility and contacts.", G.bridging, true), peoplePanel(), checkPanel("Study plan", "A credential or course you are working through.", G.study, false));
  el.append(three);
}
function checkPanel(title, sub, items, grouped) {
  const done = items.filter((i) => i.done).length, pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const panel = h("section", { class: "card panel" }, h("h3", {}, title), h("div", { class: "muted small" }, sub), h("div", { class: "progress", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": title + " progress" }, h("i", { style: "width:" + pct + "%" })), h("div", { class: "small muted", style: "margin:-6px 0 6px" }, done + " of " + items.length + " done"));
  const row = (it) => h("div", { class: "check" + (it.done ? " done" : "") },
    h("input", { type: "checkbox", checked: !!it.done, "aria-label": it.action, onchange: async (e) => { it.done = e.target.checked; await saveGoals(); renderGoals(); } }),
    h("div", { class: "tx" }, h("div", { class: "tx" }, it.action), h("div", { class: "chips", style: "margin-top:4px" }, it.target ? h("span", { class: "chip deadline" }, it.target) : null, it.notes ? h("span", { class: "chip " + (/HIGHEST/.test(it.notes) ? "warn" : "") }, it.notes) : null)),
    h("button", { class: "btn sm ghost", onclick: () => goalModal(items, it) }, "Edit"));
  if (grouped) { const cats = [...new Set(items.map((i) => i.category || "Other"))]; cats.forEach((c) => { panel.append(h("div", { class: "muted small", style: "margin-top:12px;font-weight:600" }, c)); items.filter((i) => (i.category || "Other") === c).forEach((i) => panel.append(row(i))); }); }
  else items.forEach((i) => panel.append(row(i)));
  panel.append(h("div", { style: "margin-top:12px" }, h("button", { class: "btn sm", onclick: () => goalModal(items) }, "Add an item")));
  return panel;
}
function goalModal(items, it) {
  const edit = !!it, f = (k) => (it && it[k]) || "";
  const act = h("textarea", {}); act.value = f("action"); const cat = h("input", { value: f("category"), list: "cats" }), tg = h("input", { value: f("target"), placeholder: "e.g. Nov 15" }), nt = h("input", { value: f("notes") });
  const dl = h("datalist", { id: "cats" }, [...new Set(items.map((i) => i.category).filter(Boolean))].map((c) => h("option", { value: c })));
  openModal(edit ? "Edit item" : "Add an item", h("div", { style: "display:grid;gap:12px" }, field("What to do", act), h("div", { class: "grid2" }, field("Category", cat), field("Target date", tg)), field("Note", nt), dl),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: async () => { items.splice(items.indexOf(it), 1); closeLayer(); await saveGoals(); renderGoals(); } }, "Delete") : null, h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => { if (!act.value.trim()) return toast("Write what to do first.", true); const o = it || { id: uid("g_"), done: false }; Object.assign(o, { action: act.value.trim(), category: cat.value.trim(), target: tg.value.trim(), notes: nt.value.trim() }); if (!it) items.push(o); closeLayer(); await saveGoals(); renderGoals(); } }, "Save")]);
}
const PEOPLE_ST = ["To contact", "Contacted", "Replied", "Talked", "Closed"];
function peoplePanel() {
  const P = S.hub.goals.people, panel = h("section", { class: "card panel" }, h("h3", {}, "People to reach out to"), h("div", { class: "muted small", style: "margin-bottom:8px" }, "Contacts, and where each conversation stands."));
  if (!P.length) panel.append(h("div", { class: "empty" }, h("strong", {}, "No one yet"), "Add a contact at an employer you want to work for."));
  P.forEach((p) => panel.append(h("div", { class: "res-row" },
    h("div", {}, h("strong", {}, p.name), h("span", { class: "muted" }, p.org ? " · " + p.org : ""), p.contact ? h("div", { class: "small" }, p.contact.includes("@") ? h("a", { href: "mailto:" + p.contact }, p.contact) : linkify(p.contact)) : null, p.why ? h("div", { class: "small muted", style: "margin-top:2px" }, p.why) : null,
      p.next ? h("div", { class: "small", style: "margin-top:4px" }, "Next: " + p.next) : null, p.last ? h("div", { class: "small muted" }, "Last contact " + niceDate(p.last)) : null),
    h("div", { style: "display:grid;gap:6px;justify-items:end" }, select(PEOPLE_ST, p.status, { class: "statsel chip " + (p.status === "To contact" ? "wait" : p.status === "Closed" ? "rej" : "open"), "aria-label": "Status for " + p.name, onchange: async (e) => { p.status = e.target.value; if (p.status !== "To contact" && !p.last) p.last = todayIso(); await saveGoals(); renderGoals(); } }), h("button", { class: "btn sm ghost", onclick: () => personModal(p) }, "Edit")))));
  panel.append(h("div", { style: "margin-top:12px" }, h("button", { class: "btn sm", onclick: () => personModal() }, "Add a person")));
  return panel;
}
function personModal(p) {
  const edit = !!p, f = (k) => (p && p[k]) || "";
  const name = h("input", { value: f("name") }), org = h("input", { value: f("org") }), contact = h("input", { value: f("contact"), placeholder: "Email or LinkedIn link" }), why = h("input", { value: f("why") }), next = h("input", { value: f("next") }), last = h("input", { type: "date", value: f("last") }), st = select(PEOPLE_ST, f("status") || "To contact");
  openModal(edit ? "Edit person" : "Add a person", h("div", { style: "display:grid;gap:12px" }, h("div", { class: "grid2" }, field("Name", name), field("Organization", org)), field("How to reach them", contact), field("Why them", why), h("div", { class: "grid2" }, field("Status", st), field("Last contact", last)), field("Next step", next)),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: async () => { const L = S.hub.goals.people; L.splice(L.indexOf(p), 1); closeLayer(); await saveGoals(); renderGoals(); } }, "Delete") : null, h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => { if (!name.value.trim()) return toast("Add a name first.", true); const o = p || { id: uid("g_") }; Object.assign(o, { name: name.value.trim(), org: org.value.trim(), contact: contact.value.trim(), why: why.value.trim(), next: next.value.trim(), last: last.value, status: st.value }); if (!p) S.hub.goals.people.push(o); closeLayer(); await saveGoals(); renderGoals(); } }, "Save")]);
}

/* ---------- Employers and Resources ---------- */
const RES_TABS = [["all", "All pages", "all"], ["board", "Job Boards", "board"], ["local", "Local-Specific Job Resources", "local"], ["large", "Large Employers", "large"], ["small", "Small Employers", "small"], ["own", "Self-generated resources", "own"], ["reference", "Career Fit Map", "ref"]];
const KIND_LABEL = { board: "Job Boards", local: "Local-Specific Job Resources", large: "Large Employers", small: "Small Employers", own: "Self-generated resources" };
const KIND_BLURB = {
  board: "Where listings come from first. Refresh searches LinkedIn and Indeed through web search and loads each board's own page. Rows marked \"link only\" have no open feed: open them yourself.",
  local: "Sites for one place. Refresh checks a place's sites whenever that place is in Where on Active Jobs and Search. Find local sites (below the list) searches the web for more.",
  large: "Employers big enough to check every time. Refresh scans their job boards and career pages, narrowed to the places you chose.",
  small: "Employers with only a few openings. They are searched automatically about once a week, or on demand with Check now.",
  own: "Pages, saved searches and notes you gathered yourself. Refresh does not read these; tick Checked today when you look at one.",
  all: "Every page in one list. Use the tabs above to work on one section at a time."
};
const resTabNow = () => (RES_TABS.some((x) => x[0] === S.resTab) ? S.resTab : "all");
function resTabs() {
  const cur = resTabNow(), counts = {}; S.hub.resources.forEach((r) => { counts[r.kind] = (counts[r.kind] || 0) + 1; counts.all = (counts.all || 0) + 1; });
  return h("nav", { class: "restabs", role: "tablist", "aria-label": "Employers and Resources sections" }, RES_TABS.map(([k, t, c]) =>
    h("button", { class: "restab c-" + c, role: "tab", "aria-selected": String(cur === k), onclick: () => { S.resTab = k; renderResources(); } }, h("span", { class: "rt" }, t), k !== "reference" ? h("span", { class: "rn" }, String(counts[k] || 0)) : null)));
}
async function renderResources() {
  try { S.resStat = await api("/api/res/status"); } catch (e) { S.resStat = S.resStat || {}; }
  const el = clear($("#v-resources")), cur = resTabNow();
  el.append(h("div", { class: "section-head" }, h("h2", {}, "Employers and Resources"),
    cur === "reference" ? h("button", { class: "btn primary", onclick: () => refModal() }, "Add a note") : h("button", { class: "btn primary", onclick: () => resModal(null, cur === "all" ? "small" : cur) }, cur === "board" ? "Add a board" : cur === "local" ? "Add a site" : cur === "own" ? "Add a resource" : cur === "all" ? "Add a page" : "Add an employer")), resTabs());
  if (cur === "reference") return renderReference(el);
  el.append(h("p", { class: "muted small tabblurb" }, KIND_BLURB[cur]));
  if (cur === "small") {
    const st = S.resStat || {};
    el.append(h("div", { class: "card panel weeklybox" }, h("div", {}, h("strong", {}, "Weekly check"), h("div", { class: "small muted" }, (st.small_auto === false ? "The automatic weekly check is off (How it works > Settings). " : "Runs by itself about once a week while the Hub is open. ") + "Last check: " + (st.small_last ? niceDate(st.small_last) : "not yet") + ". Anything new lands in Active Jobs and Search under Small employers.")),
      h("button", { class: "btn primary", onclick: checkSmallNow }, "Check now")));
  }
  if (cur === "all") return renderAllPages(el);
  if (cur === "local") return renderLocal(el);
  el.append(filterRow(cur), h("div", { id: "reslist" }));
  renderResourceList(cur);
  if (cur === "large") el.append(boardsPanel());
}
function filterRow(cur, city) { return h("div", { class: "chips filterrow" }, h("input", { type: "search", placeholder: "Type to narrow the list", value: S.resQ || "", "aria-label": "Filter", class: "filterbox", oninput: (e) => { S.resQ = e.target.value; renderResourceList(cur, city); } })); }
function renderAllPages(el) {
  const match = (r) => { const q = (S.resQ || "").toLowerCase(); return !q || (r.name + " " + (r.note || "")).toLowerCase().includes(q); };
  const openMap = () => { try { return JSON.parse(localStorage.getItem("hub.resOpen") || "{}"); } catch (e) { return {}; } };
  const saveOpen = (o) => { try { localStorage.setItem("hub.resOpen", JSON.stringify(o)); } catch (e) { /* storage unavailable */ } };
  let dets = [];
  const list = h("div", { id: "allpages" });
  // only the list is redrawn while typing, so the box keeps focus
  const paint = () => {
    clear(list); dets = [];
    const q = (S.resQ || "").trim();
    const section = (kind, title, items) => {
      if (!items.length) return;
      const card = h("div", { class: "card panel reslistcard c-" + kind, style: "padding-top:4px;padding-bottom:4px" });
      items.forEach((r, i) => card.append(resRow(r, kind, i === 0)));
      const det = h("details", { class: "resgroup allgrp c-" + kind, open: !!q || openMap()[title] !== false }, h("summary", {}, h("span", { class: "gname" }, title), h("span", { class: "chip" }, plural(items.length, "page"))), card);
      det.addEventListener("toggle", () => { if (q) return; const o = openMap(); o[title] = det.open; saveOpen(o); });
      dets.push(det); list.append(det);
    };
    ["board", "large", "small"].forEach((k) => section(k, KIND_LABEL[k], S.hub.resources.filter((r) => r.kind === k && match(r))));
    const loc = S.hub.resources.filter((r) => r.kind === "local" && match(r)), cities = [...new Set(loc.map((r) => r.city || "No place"))].sort();
    cities.forEach((c) => section("local", KIND_LABEL.local + " · " + c, loc.filter((r) => (r.city || "No place") === c)));
    section("own", KIND_LABEL.own, S.hub.resources.filter((r) => r.kind === "own" && match(r)));
    if (!dets.length) list.append(h("div", { class: "empty" }, h("strong", {}, "Nothing matches"), "Clear the box to see every page."));
  };
  el.append(h("div", { class: "chips filterrow" }, h("input", { type: "search", placeholder: "Type to narrow the list", value: S.resQ || "", "aria-label": "Filter", class: "filterbox", oninput: (e) => { S.resQ = e.target.value; paint(); } }),
    h("button", { class: "btn sm ghost", onclick: () => dets.forEach((d) => { d.open = true; }) }, "Open all"), h("button", { class: "btn sm ghost", onclick: () => dets.forEach((d) => { d.open = false; }) }, "Close all")), list);
  paint();
}
async function checkSmallNow() {
  try { const r = await api("/api/scan", "POST", { city: "", remote: true, layers: { small: true, boards: false, local: false, large: false } }); if (!r.ok) return toast(r.error, true); toast("Checking small employers. Progress shows under Active Jobs and Search."); pollScan(); } catch (e) { fail(e); }
}
function localCities() {
  const set = [...(S.hub.settings.cities || [])];
  S.hub.resources.filter((r) => r.kind === "local" && r.city).forEach((r) => { if (!set.some((c) => c.toLowerCase() === r.city.toLowerCase())) set.push(r.city); });
  return set;
}
function renderLocal(el) {
  const cities = localCities();
  if (!cities.includes(S.resCity)) S.resCity = cities.includes(S.hub.settings.default_city) ? S.hub.settings.default_city : cities[0];
  const nOf = (c) => S.hub.resources.filter((r) => r.kind === "local" && (r.city || "").toLowerCase() === c.toLowerCase()).length;
  el.append(h("div", { class: "subtabs", role: "tablist", "aria-label": "Places" }, cities.map((c) => h("button", { class: "subtab", role: "tab", "aria-selected": String(c === S.resCity), onclick: () => { S.resCity = c; renderResources(); } }, c, h("span", { class: "rn" }, String(nOf(c))))),
    h("button", { class: "subtab add", onclick: addPlaceModal }, "+ Add a place")));
  if (!S.resCity) return el.append(h("div", { class: "empty" }, h("strong", {}, "No places yet"), "Add a place to start a list of sites for it."));
  el.append(filterRow("local", S.resCity), h("div", { id: "reslist" }));
  renderResourceList("local", S.resCity);
  el.append(findSitesBox(S.resCity));
}
function addPlaceModal() {
  const name = h("input", { placeholder: "e.g. Berlin" });
  openModal("Add a place", h("div", { style: "display:grid;gap:12px" }, h("p", { class: "muted small", style: "margin:0" }, "A place gets its own sub-tab for sites to search. It also becomes a quick button on Active Jobs and Search."), field("Place", name)),
    [h("button", { class: "btn", onclick: closeLayer }, "Cancel"), h("button", { class: "btn primary", onclick: async () => {
      const v = name.value.trim(); if (!v) return toast("Type a place first.", true);
      const cs = [...(S.hub.settings.cities || [])]; if (!cs.some((c) => c.toLowerCase() === v.toLowerCase())) cs.push(v);
      try { await api("/api/hub/settings", "PUT", { cities: cs }); S.hub.settings.cities = cs; S.resCity = v; closeLayer(); renderResources(); } catch (e) { fail(e); } } }, "Add")]);
}
function findSitesBox(city) {
  const body = h("div", { id: "candbody" });
  return h("section", { class: "card panel findbox" }, h("h3", {}, "Find local sites for " + city),
    h("p", { class: "muted small", style: "margin:4px 0 10px" }, "Searches the web for job boards and employers specific to " + city + ". You choose which to keep; kept sites join the list above and are searched whenever " + city + " is in Where."),
    h("button", { class: "btn primary", onclick: () => findSites(city, body) }, "Find local sites for " + city), body);
}
async function findSites(place, cb) {
  clear(cb).append(h("div", { class: "muted small", style: "margin-top:10px" }, "Searching for sites in " + place + "…"));
  try {
    const d = await api("/api/sources/discover", "POST", { city: place }); clear(cb);
    if (!d.candidates.length) return cb.append(h("div", { class: "muted small", style: "margin-top:10px" }, "Nothing new found. The search engine may be limiting automated searches; try again later."));
    cb.append(h("ul", { class: "lines", style: "margin-top:12px" }, d.candidates.map((c) => h("li", {}, h("span", {}, h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer" }, c.title), h("div", { class: "muted small" }, c.snippet)),
      h("button", { class: "btn sm", onclick: async (e) => { try { await api("/api/source/add", "POST", { city: place, name: c.title.slice(0, 80), url: c.url }); e.target.replaceWith(h("span", { class: "chip good" }, "Kept")); S.hub.resources = (await api("/api/hub")).resources; renderResourceList("local", place); } catch (er) { fail(er); } } }, "Keep")))));
  } catch (e) { clear(cb).append(h("div", { class: "muted small", style: "margin-top:10px" }, e.message)); }
}
function resRow(r, kind, first) {
  const st = ((S.resStat || {}).src_stats || {})[r.name];
  const status = r.scan === false ? h("span", { class: "chip" }, /^(Indeed|LinkedIn)/.test(r.name) ? "via web search" : "link only") : !(r.url || "").startsWith("http") ? null : st ? h("span", { class: "chip " + (st.found ? "good" : "") , title: st.note || "" }, st.found ? st.found + " found · " + niceDate(st.at) : "none found · " + niceDate(st.at)) : h("span", { class: "chip" }, "not searched yet");
  const today0 = r.last_checked && -dayDiff(r.last_checked) <= 0, by = r.checked_by === "search" ? " · by search" : r.checked_by === "you" ? " · by you" : "";
  const badge = today0 ? h("span", { class: "chip checked-today" }, "✓ Checked today" + by) : h("span", { class: "small muted" }, r.last_checked ? "Checked " + ago(r.last_checked).replace("checked ", "") + by : "Never checked");
  return h("div", { class: "res-row" + (today0 ? " ct" : ""), style: first ? "border-top:0" : "" },
    h("div", {}, r.url ? h("a", { href: /^https?:/.test(r.url) ? r.url : "https://" + r.url, target: "_blank", rel: "noopener noreferrer", style: "font-weight:600" }, r.name + " ↗") : h("strong", {}, r.name), r.url ? null : h("span", { class: "chip", style: "margin-left:8px" }, "no link saved"), r.note ? h("div", { class: "small muted" }, linkify(r.note)) : null),
    h("div", { class: "chips", style: "align-items:center;align-self:start;justify-content:flex-end" }, status, badge,
      today0 ? null : h("button", { class: "btn sm", onclick: async () => { r.last_checked = todayIso(); r.checked_by = "you"; await saveRes(); renderResources(); toast("Marked as checked"); } }, "Mark checked"), h("button", { class: "btn sm ghost", onclick: () => resModal(r) }, "Edit")));
}
function renderResourceList(kind, city) {
  const box = clear($("#reslist")), q = (S.resQ || "").toLowerCase();
  const items = S.hub.resources.filter((r) => r.kind === kind && (kind !== "local" || (r.city || "").toLowerCase() === (city || "").toLowerCase()) && (!q || (r.name + " " + (r.note || "")).toLowerCase().includes(q)));
  if (!items.length) return box.append(h("div", { class: "empty" }, h("strong", {}, q ? "Nothing matches" : "Nothing here yet"), q ? "Clear the filter." : "Use the button at the top right to add one."));
  const card = h("div", { class: "card panel reslistcard", style: "padding-top:4px;padding-bottom:4px" });
  items.forEach((r, i) => card.append(resRow(r, kind, i === 0)));
  box.append(card);
}
function resModal(r, kindHint) {
  const edit = !!r, f = (k) => (r && r[k]) || "";
  const name = h("input", { value: f("name") }), url = h("input", { type: "url", value: f("url"), placeholder: "https://…" }),
    kind = select(Object.entries(KIND_LABEL), f("kind") || kindHint || "small"), place = h("input", { value: f("city") || (kindHint === "local" ? S.resCity || "" : ""), list: "rplaces", placeholder: "e.g. London (only for Local-Specific)" }),
    note = h("textarea", {}), scan = h("input", { type: "checkbox", checked: !r || r.scan !== false });
  note.value = f("note");
  openModal(edit ? "Edit" : "Add", h("div", { style: "display:grid;gap:12px" }, field("Name", name), field("Link", url), field("Section", kind), field("Place (for Local-Specific)", place), field("Note", note),
    h("label", { class: "chk" }, scan, " Read this page on Refresh (turn off for sites with no open list)"), h("datalist", { id: "rplaces" }, localCities().map((c) => h("option", { value: c })))),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: () => confirmModal("Delete this?", r.name, "Delete", async () => { S.hub.resources = S.hub.resources.filter((x) => x !== r); await saveRes(); renderResources(); }) }, "Delete") : null, h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => {
        if (!name.value.trim()) return toast("Add a name first.", true);
        if (kind.value === "local" && !place.value.trim()) return toast("A local site needs a place.", true);
        const o = r || { id: uid("res_"), last_checked: "" };
        Object.assign(o, { name: name.value.trim(), url: url.value.trim(), kind: kind.value, cat: KIND_LABEL[kind.value], note: note.value.trim() });
        if (kind.value === "local") o.city = place.value.trim(); else delete o.city;
        if (scan.checked) delete o.scan; else o.scan = false;
        if (!r) S.hub.resources.push(o);
        S.resTab = kind.value; if (kind.value === "local") S.resCity = o.city;
        closeLayer(); await saveRes(); renderResources(); toast("Saved"); } }, "Save")]);
}

async function saveRef() { try { await api("/api/hub/reference", "PUT", S.hub.reference); } catch (e) { fail(e); } }
function clusterTable() {
  const rows = CLUSTERS.map((c) => h("tr", {}, h("th", { scope: "row" }, c.name), h("td", {}, c.gives), h("td", {}, c.titles), h("td", { class: "mono" }, c.resume)));
  return h("div", { class: "card panel", style: "margin-bottom:14px" }, h("h3", {}, "The six clusters"),
    h("p", { class: "small muted", style: "margin:0 0 8px" }, "Each job in Records can carry several. The main (first) track picks the suggested resume. Short-term / Income and Other are tags, not clusters."),
    h("div", { style: "overflow-x:auto" }, h("table", { class: "clustertable" }, h("thead", {}, h("tr", {}, ["Cluster", "What you deliver", "Example titles", "Resume"].map((t) => h("th", { scope: "col" }, t)))), h("tbody", {}, rows))));
}
function renderReference(el) {
  const R = S.hub.reference || (S.hub.reference = []);
  el.append(clusterTable());
  el.append(h("p", { class: "muted small", style: "margin:0 0 12px;max-width:72ch" }, "Background worth keeping for when you tune the search: the six clusters, the Career Fit Map, what to look for, what to avoid. Job boards and employers are in the other tabs above."));
  R.forEach((it) => {
    const det = h("details", { class: "resgroup", open: true }, h("summary", {}, h("span", { class: "gname" }, it.title), h("span", { class: "muted small" }, it.kind === "file" ? "map" : "note")));
    const body = it.kind === "file"
      ? h("div", {}, it.desc ? h("p", { class: "small muted", style: "margin:4px 0 10px" }, it.desc) : null,
          h("iframe", { src: "/" + it.file, title: it.title, loading: "lazy", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", style: "width:100%;height:900px;border:0;border-radius:8px;background:#fff",
            onload: (e) => { try { const d = e.target.contentDocument; if (d && d.documentElement) e.target.style.height = (d.documentElement.scrollHeight + 24) + "px"; } catch (err) { /* keep default height */ } } }))
      : h("div", { style: "white-space:pre-wrap;padding:4px 0" }, linkify(it.body || ""));
    const bar = h("div", { class: "chips", style: "justify-content:flex-end;margin-top:8px" }, it.kind === "file" ? h("a", { class: "btn sm", href: "/" + it.file, target: "_blank", rel: "noopener noreferrer" }, "Open full page ↗") : null, h("button", { class: "btn sm ghost", onclick: () => refModal(it) }, "Edit"));
    det.append(h("div", { class: "card panel" }, body, bar));
    el.append(det);
  });
  if (!R.length) el.append(h("div", { class: "empty" }, h("strong", {}, "Nothing here yet"), "Add a note to keep background for tuning the search."));
}
function refModal(it) {
  const edit = !!it, isFile = edit && it.kind === "file";
  const title = h("input", { value: (it && it.title) || "" }), text = h("textarea", { rows: 10 }); text.value = edit ? (isFile ? it.desc || "" : it.body || "") : "";
  openModal(edit ? "Edit" : "Add a note", h("div", { style: "display:grid;gap:12px" }, field("Title", title), field(isFile ? "Description" : "Note", text)),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: () => confirmModal("Remove this from the page?", isFile ? it.title + " (the file itself stays on disk)" : it.title, "Remove", async () => { S.hub.reference = S.hub.reference.filter((x) => x !== it); await saveRef(); renderResources(); }) }, "Remove") : null,
      h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => { if (!title.value.trim()) return toast("Add a title first.", true); const o = it || { id: uid("ref_"), kind: "note", added: todayIso() }; o.title = title.value.trim(); if (isFile) o.desc = text.value.trim(); else o.body = text.value.trim(); if (!it) S.hub.reference.push(o); closeLayer(); await saveRef(); renderResources(); toast("Saved"); } }, "Save")]);
}

function boardsPanel() {
  const body = h("div", { style: "margin-top:10px" }, h("div", { class: "muted small" }, "Loading…"));
  const names = h("textarea", { placeholder: "One employer per line, e.g.\nAcme Analytics\nExample Institute", "aria-label": "Employer names", rows: 3, style: "width:100%;border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:8px 10px" });
  const msg = h("div", { class: "small muted" });
  const d = h("details", { class: "card panel", style: "margin-top:4px" }, h("summary", { style: "cursor:pointer;font:600 17px var(--serif)" }, "Employer job boards the scanner reads (Greenhouse, Lever, Ashby and others)"), body,
    h("div", { style: "margin-top:14px" }, h("strong", { class: "small" }, "Add employers to the scan"), h("div", { class: "muted small", style: "margin:2px 0 6px" }, "The hub looks for each employer's public job board on Greenhouse, Lever, Ashby, SmartRecruiters or Workable. Employers on other systems are not found yet."), names,
      h("div", { class: "chips", style: "margin-top:8px;align-items:center" }, h("button", { class: "btn sm primary", onclick: async () => { try { const r = await api("/api/discover", "POST", { names: names.value.split("\n") }); if (!r.ok) return toast(r.error, true); msg.textContent = "Looking them up. This takes a minute…"; const t = setInterval(async () => { const s = (await api("/api/scan/status")).scan; if (!s.running) { clearInterval(t); msg.textContent = s.error || s.message || "Done."; loadBoards(body); } }, 2000); } catch (e) { fail(e); } } }, "Look up and add"), msg)));
  d.addEventListener("toggle", () => { if (d.open) loadBoards(body); }, { once: true });
  return d;
}
async function loadBoards(body) {
  try {
    const b = (await api("/api/boards")).boards, by = {}; b.forEach((x) => (by[x.ats] = by[x.ats] || []).push(x)); clear(body);
    body.append(h("div", { class: "small muted", style: "margin-bottom:6px" }, plural(b.length, "board") + ". The number is how many openings each had at the last look."));
    Object.entries(by).forEach(([k, arr]) => body.append(h("div", { style: "margin:8px 0" }, h("div", { class: "small", style: "font-weight:600" }, k + " (" + arr.length + ")"), h("div", { class: "chips", style: "margin-top:4px" }, arr.map((x) => h("span", { class: "chip" }, x.name + " " + x.n))))));
  } catch (e) { clear(body).append(h("div", { class: "small" }, "Could not read the board list: " + e.message)); }
}


/* ---------- How it works ---------- */
function box(x, y, w, hh, title, lines, tone) {
  const g = sv("g", {});
  g.append(sv("rect", { x, y, width: w, height: hh, rx: 10, fill: "var(--" + (tone || "paper") + ")", stroke: "var(--line)" }));
  g.append(sv("text", { x: x + w / 2, y: y + 24, "text-anchor": "middle", "font-weight": 600, "font-size": 14, "font-family": "var(--serif)" }, title));
  lines.forEach((l, i) => g.append(sv("text", { x: x + w / 2, y: y + 44 + i * 16, "text-anchor": "middle", "font-size": 12, fill: "var(--ink-2)", style: "fill:var(--ink-2)" }, l)));
  return g;
}
function arrow(x1, y1, x2, y2, both) {
  const g = sv("g", { stroke: "var(--mute)", "stroke-width": 1.6, fill: "none" });
  g.append(sv("line", { x1, y1, x2, y2 }));
  const a = Math.atan2(y2 - y1, x2 - x1), tip = (x, y, ang) => sv("path", { d: "M" + (x - 8 * Math.cos(ang - 0.45)) + " " + (y - 8 * Math.sin(ang - 0.45)) + " L" + x + " " + y + " L" + (x - 8 * Math.cos(ang + 0.45)) + " " + (y - 8 * Math.sin(ang + 0.45)), fill: "none" });
  g.append(tip(x2, y2, a)); if (both) g.append(tip(x1, y1, a + Math.PI)); return g;
}
function dayDiagram() {
  const W = 1000, svg = sv("svg", { viewBox: "0 0 " + W + " 190", role: "img", "aria-label": "Your day: find, decide, read, apply, record, follow up" });
  const steps = [["Find", ["Fresh finds on Today,", "or the Search tab"], "paper"], ["Decide", ["Add to plan,", "or pass"], "paper"], ["Read", ["Details card:", "pay, years, text"], "paper"], ["Apply", ["Open original in", "a new tab"], "paper"], ["Record", ["Press I applied;", "it lands in Records"], "paper"], ["Follow up", ["Goals tab, and", "Waitlist checks"], "paper"]];
  const w = 138, gap = 34;
  steps.forEach((s, i) => { const x = 4 + i * (w + gap); svg.append(box(x, 40, w, 96, s[0], s[1], s[2])); if (i < steps.length - 1) svg.append(arrow(x + w + 4, 88, x + w + gap - 4, 88)); svg.append(sv("text", { x: x + w / 2, y: 28, "text-anchor": "middle", "font-size": 12, style: "fill:var(--mute)" }, "step " + (i + 1))); });
  svg.append(sv("text", { x: W / 2, y: 168, "text-anchor": "middle", "font-size": 13, style: "fill:var(--ink-2)" }, "Search refresh and your daily goal sit behind step 1; the orbit on Today fills each time you save an application."));
  return h("div", { class: "flow" }, svg);
}
function partsDiagram() {
  const svg = sv("svg", { viewBox: "0 0 1000 300", role: "img", "aria-label": "How the pieces connect" });
  svg.append(box(10, 110, 170, 80, "This page", ["Runs in your browser"], "paper"));
  svg.append(box(250, 110, 190, 80, "hub.py", ["Small server on this", "computer only"], "accent-soft"));
  svg.append(box(520, 10, 210, 76, "hub.json", ["Your records, plan, goals,", "resources, settings"], "paper"));
  svg.append(box(520, 112, 210, 76, "jobs_state.json", ["Every listing the", "scanner has seen"], "paper"));
  svg.append(box(520, 214, 210, 76, "rejected.json", ["Roles to hide because", "you already tried them"], "paper"));
  svg.append(box(790, 112, 200, 76, "ats_scan.py", ["The scanner. Reads", "employer job boards"], "accent-soft"));
  svg.append(arrow(184, 150, 246, 150, true));
  svg.append(arrow(444, 130, 516, 54)); svg.append(arrow(444, 150, 516, 150, true)); svg.append(arrow(444, 170, 516, 250));
  svg.append(arrow(734, 150, 786, 150, true));
  svg.append(sv("text", { x: 890, y: 218, "text-anchor": "middle", "font-size": 12, style: "fill:var(--ink-2)" }, "needs the internet"));
  svg.append(sv("text", { x: 890, y: 236, "text-anchor": "middle", "font-size": 12, style: "fill:var(--ink-2)" }, "only for refresh"));
  return h("div", { class: "flow" }, svg);
}
function customizationList() {
  const L = (S.hub.customizations || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const box = h("div", { class: "czlist" });
  L.forEach((e) => box.append(h("details", { class: "cz", open: e === L[0] }, h("summary", {}, h("span", { class: "czdate" }, niceDate(e.date) || e.date), h("span", { class: "gname" }, e.title), h("span", { class: "muted small" }, plural((e.items || []).length, "request"))),
    h("div", { class: "card panel" }, h("ul", { class: "tight" }, (e.items || []).map((x) => h("li", {}, x))), e.done_note ? h("p", { class: "small muted", style: "margin:8px 0 0" }, "Done: " + e.done_note) : null,
      h("div", { class: "chips", style: "justify-content:flex-end;margin-top:8px" }, h("button", { class: "btn sm ghost", onclick: () => czModal(e) }, "Edit"))))));
  box.append(h("div", { style: "margin-top:10px" }, h("button", { class: "btn", onclick: () => czModal() }, "Add a request")));
  return box;
}
async function saveCz(body) { try { await api("/api/customization", "POST", body); S.hub = await api("/api/hub"); renderProcess(); toast("Saved"); } catch (e) { fail(e); } }
function czModal(e) {
  const edit = !!e, title = h("input", { value: edit ? e.title : "" }), date = h("input", { type: "date", value: edit ? e.date : todayIso() }), items = h("textarea", { rows: 7, placeholder: "One request per line" }), done = h("input", { value: edit ? e.done_note || "" : "", placeholder: "Optional: what was done about it" });
  items.value = edit ? (e.items || []).join("\n") : "";
  openModal(edit ? "Edit entry" : "Add a request", h("div", { style: "display:grid;gap:12px" }, field("Title", title), field("Date", date), field("What was asked (one line each)", items), field("Done", done)),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: () => confirmModal("Delete this entry?", e.title, "Delete", () => saveCz({ op: "delete", id: e.id })) }, "Delete") : null, h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => { const lines = items.value.split("\n").map((x) => x.trim()).filter(Boolean); if (!lines.length) return toast("Write at least one line.", true); closeLayer(); saveCz(edit ? { op: "edit", id: e.id, title: title.value, date: date.value, items: lines, done_note: done.value } : { op: "add", title: title.value, date: date.value, items: lines, done_note: done.value }); } }, "Save")]);
}
function renderProcess() {
  const el = clear($("#v-process")), st = S.hub.settings;
  const kg = h("input", { type: "password", autocomplete: "off", placeholder: st.has_google ? "saved" : "optional" }), kx = h("input", { autocomplete: "off", placeholder: st.has_google ? "saved" : "optional" }), ka = h("input", { type: "password", autocomplete: "off", placeholder: st.has_ai ? "saved" : "optional" });
  const goal = h("input", { type: "number", min: 1, max: 20, value: st.daily_goal || 3 }), city = h("input", { value: st.default_city || "" }), cities = h("input", { value: (st.cities || []).join(", ") }), rem = h("input", { type: "number", min: 1, max: 50, value: st.reminder_after || 5 }), smallAuto = h("input", { type: "checkbox", checked: st.small_auto !== false });
  const C = (t) => h("code", {}, t);
  const B = (t) => h("strong", {}, t), I = (t) => h("em", {}, t);
  const callout = (kind, title, ...kids) => h("aside", { class: "callout " + kind }, h("div", { class: "ct" }, title), ...kids);
  const bullets = (...items) => h("ul", { class: "tight" }, items.map((x) => h("li", {}, x)));
  el.append(h("div", { class: "section-head" }, h("h2", {}, "How it works")), h("div", { class: "doc rich" },
    callout("note", "The short version",
      bullets([B("One page"), " for the whole day: find jobs, decide, apply, record."],
        [B("Today"), " is your starting point. ", I("Everything else feeds it.")],
        [B("Nothing leaves your computer."), " It is a small program that only this machine can reach."])),
    h("h3", {}, "A day, step by step"), dayDiagram(),
    h("ol", { class: "steps", style: "margin-top:14px" },
      h("li", {}, h("div", {}, B("Open Today."), " Check the ", I("orbit"), " (applications done against your goal), then read ", B("Today's plan"), ". It holds queued jobs, your own tasks, and anything carried over from yesterday.")),
      h("li", {}, h("div", {}, B("Find jobs."), " Use ", B("Fresh finds"), ", or the ", B("Active Jobs and Search"), " tab: pick the ", I("where"), " and the ", I("what"), ". ", C("Refresh search"), " pulls current openings from the sections you switch on (see the box below). Leave ", I("where"), " blank for the US and EU, and put a minus in front of a place to leave it out (", C("-Boston"), ").")),
      h("li", {}, h("div", {}, B("Decide fast."), " ", B("Add to plan"), " or ", B("Pass"), ". Passed jobs stay hidden, and your reason helps later searches.")),
      h("li", {}, h("div", {}, B("Apply."), " ", C("Open original ↗"), " opens the employer's page in a ", I("new tab"), ". The hub shows the description; the real application happens on their site.")),
      h("li", {}, h("div", {}, B("Press I applied."), " Pick the resume version, add a note. The record is saved and the orbit fills.")),
      h("li", {}, h("div", {}, B("Close the day."), " Write anything unfinished under ", B("For tomorrow"), ". It reappears in Today's plan tomorrow, and notes show at the top as a banner.")),
      h("li", {}, h("div", {}, B("Spend ten minutes on Goals."), " Check off a bridging move, write to someone, study. Look at the ", B("Waitlist"), " column in Records for anything that needs a nudge."))),
    callout("tip", "Rolling over to tomorrow",
      bullets([B("To-dos"), " you add under ", I("For tomorrow"), " become tasks in Today's plan the next morning. No action needed."],
        [B("Notes"), " you type there show as a banner on the next day. Press ", I("Got it"), " to clear."],
        [B("Not finished?"), " Open tasks stay in the plan with a ", I("Carried over"), " tag until you check them off or move them."],
        [B("Want me to look?"), " In a Claude chat, ask me to read ", C("data/hub.json"), " and plan the day from it."])),
    callout("note", "What a search looks at",
      bullets([B("Job boards:"), " LinkedIn and Indeed through web search, plus each board's own page, for the places in ", I("Where"), "."],
        [B("Local employers:"), " the sites listed for those places under ", I("Employers and Resources > Local-Specific Job Resources"), " (only when a place is chosen)."],
        [B("Large employers:"), " employer job boards plus the big firms' career pages (the large consultancies, for example), narrowed to those places."],
        [B("Small employers:"), " a few openings each, so they get their own search about once a week, automatically while the Hub is open. Switch the section on in Refresh to force it, or use ", I("Check now"), " under Small Employers."],
        [B("Manual search"), " (the filters on the page) only filters what the last refreshes saved; ", C("Refresh search"), " is what goes out and looks."])),
    h("h3", {}, "How the pieces connect"), partsDiagram(),
    h("p", {}, "The page talks to a small program (", C("hub.py"), ") on your computer. It reads and writes your files and calls the scanner when you ask for a refresh."),
    h("h3", {}, "Where things live"),
    h("ul", { class: "tight" }, h("li", {}, C("Daily Hub/"), " ", I("this app."), " ", C("data/hub.json"), " holds records, plan, goals, networking, resources, tasks and notes. ", C("data/backups/"), " keeps the 30 latest copies."),
      h("li", {}, C("scanner/"), " ", I("the job scanner,"), " its employer list (", C("employers.json"), ") and every listing it has seen.")),
    h("h3", {}, "How listings are scored"),
    h("p", {}, "The scanner scores each ", B("title"), " against what you want (AI governance, simulation, policy and urban work, forecasting, mixed-methods analysis). Generic words alone cannot carry a listing. After a description is read it also checks:"),
    bullets([B("Pay"), " against your ", I("$67K floor")], [B("Years asked"), " and ", B("clearance"), " language"], [B("People management"), " duties"]),
    callout("warn", "What it cannot do yet",
      bullets(["Employer boards are read through their open feeds (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday). ", B("Web search"), " finds other postings, but it reads only what the search engine shows; ", B("local sites"), " work when the site lists jobs in plain HTML, a feed or structured data. Sites that need a browser to show their list report ", I("none found"), " in Employers and Resources; use the links in ", B("Employers and Resources"), " for those."],
        ["Short summaries are a plain extract from the posting. Add an Anthropic key under Settings and Claude writes them instead (", I("what you would do, at what kind of organization"), ")."],
        ["Career pages that need a browser to show their list are tried through a web search on the employer's own site; if that fails too, the row in Employers and Resources shows ", I("none found"), "."],
        ["With no place chosen, the UK, Switzerland and Norway count as outside the EU. A place that cannot be read from a listing (for example a bare city name) is kept."],
        ["The ", B("daily scan"), " is a saved draft, not running. See ", C("scheduled_task.md"), ". A banner on Today reminds you after about five applications; ", I("Remind me tomorrow"), " and ", I("In a week"), " bring it back on that day, and ", I("Stop reminding me"), " turns it off until you switch it on again under Settings."])),
    h("h3", {}, "Start it, stop it"),
    bullets([B("Start:"), " double-click the ", B("Daily Hub"), " shortcut on your desktop. It opens this page. If it is already running, it just opens the page again."],
      [B("Stop:"), " press ", I("Quit Daily Hub"), " at the bottom of the left menu. Data is saved on every change, so closing the tab is also safe."],
      [B("No shortcut?"), " Run ", C("bash launch_hub.sh"), " in the Daily Hub folder."]),
    h("h3", {}, "Keyboard, on the Active Jobs and Search tab"),
    h("p", {}, h("kbd", {}, "↑"), " ", h("kbd", {}, "↓"), " move   ", h("kbd", {}, "Enter"), " read   ", h("kbd", {}, "Q"), " add to plan   ", h("kbd", {}, "X"), " pass   ", h("kbd", {}, "O"), " open original in a new tab   ", h("kbd", {}, "Esc"), " close"),
    h("h3", {}, "How this page has been personalized"),
    h("p", { class: "muted small" }, "Every change asked for is recorded here, newest first, so there is one place that shows what was requested and when. The same record is kept as ", C("CUSTOMIZATIONS.md"), " in the Daily Hub folder. Entries before Nov 7, 2026 were rebuilt from the project notes."),
    customizationList(),
    h("h3", {}, "When something breaks"),
    bullets([B("Error log"), " (last tab) collects anything that fails. Each entry is ", I("Open"), ", ", I("Fixed"), " or ", I("Ignored"), "."],
      [B("An AI assistant can check it"), " (or you can): it reads ", C("data/errors.json"), ", fixes what it can in a scratch copy, tests it, backs up, installs it, and marks the entry Fixed with a note of what changed. Anything it cannot fix stays Open with the reason, and it tells you in one line."],
      [B("If it comes back"), ", the entry reopens, so a fix that did not hold shows up again."]),
    h("h3", {}, "Settings"),
    h("div", { class: "card panel", style: "max-width:560px;display:grid;gap:12px" }, h("div", { class: "grid2", style: "display:grid;grid-template-columns:1fr 1fr;gap:12px" }, field("Applications per day (goal)", goal), field("Default city for fresh finds", city)),
      field("Quick city buttons on Active Jobs and Search, and the places under Local-Specific (comma separated)", cities), field("Remind me about the daily scan after this many applications", rem), h("label", { class: "chk" }, smallAuto, " Check small employers automatically about once a week"),
      h("details", {}, h("summary", {}, "Search keys (optional)"), h("div", { style: "display:grid;gap:10px;margin-top:10px" }, h("p", { class: "small muted", style: "margin:0" }, "Kept in data/hub.json on this computer, never shown on the page. You can also set the environment variables GOOGLE_API_KEY, GOOGLE_CSE_ID and ANTHROPIC_API_KEY instead."),
        field("Google Programmable Search API key (web search uses Google instead of DuckDuckGo)", kg), field("Google search engine ID (cx)", kx), field("Anthropic API key (Claude writes the job summaries)", ka))),
      h("div", {}, h("button", { class: "btn primary", onclick: async () => { try { const body = { daily_goal: Math.max(1, +goal.value || 3), default_city: city.value.trim(), cities: cities.value.split(",").map((x) => x.trim()).filter(Boolean), reminder_after: Math.max(1, +rem.value || 5), reminder_dismissed: false, reminder_snooze_until: "", small_auto: smallAuto.checked }; if (kg.value.trim()) body.google_api_key = kg.value.trim(); if (kx.value.trim()) body.google_cse_id = kx.value.trim(); if (ka.value.trim()) body.anthropic_api_key = ka.value.trim(); await api("/api/hub/settings", "PUT", body); ["google_api_key", "google_cse_id", "anthropic_api_key"].forEach((k) => delete body[k]); Object.assign(S.hub.settings, body); S.search.init = false; toast("Settings saved"); loadToday(); } catch (e) { fail(e); } } }, "Save settings")))));
}

/* ---------- Networking: small firms and the people at them ---------- */
const NET_ST = ["Not contacted", "Drafted", "Contacted", "Replied", "Talked", "Closed"];
const netCls = (s) => (s === "Not contacted" ? "wait" : s === "Closed" ? "rej" : s === "Talked" ? "offer" : "open");
const NET_TYPES = ["Consulting", "Think tank / research", "Nonprofit", "Public-interest tech", "Other"];
function netLinks(o, keys) {
  const L = { site: "Website", contact: "Contact page", team: "Team page", linkedin: "LinkedIn", url: "Profile" };
  const out = [];
  keys.forEach((k) => { if (o[k]) out.push(h("a", { class: "btn sm", href: o[k], target: "_blank", rel: "noopener noreferrer" }, L[k] + " ↗")); });
  if (o.email) out.push(h("a", { class: "btn sm", href: "mailto:" + o.email }, o.email));
  return out;
}
function renderNetworking() {
  const el = clear($("#v-networking")), N = S.hub.networking, q = (S.netQ || "").toLowerCase(), view = S.netView || "companies";
  el.append(h("div", { class: "section-head" }, h("h2", {}, "Networking"), h("span", { class: "muted small" }, "Small firms where a person can answer. Reach out directly; log each conversation.")));
  const bar = h("div", { class: "chips", style: "align-items:center;margin-bottom:14px" },
    h("div", { class: "seg", role: "group", "aria-label": "View" }, ["companies", "people"].map((v) => h("button", { "aria-pressed": view === v ? "true" : "false", onclick: () => { S.netView = v; renderNetworking(); } }, v === "companies" ? "Companies (" + N.companies.length + ")" : "People (" + N.people.length + ")"))),
    h("input", { type: "search", placeholder: "Search name, focus, region, notes", value: S.netQ || "", "aria-label": "Search networking", style: "border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:7px 11px;min-width:240px", oninput: (e) => { S.netQ = e.target.value; renderNetList(); } }),
    select([["", "Any type"], ...NET_TYPES], S.netType || "", { "aria-label": "Filter by type", onchange: (e) => { S.netType = e.target.value; renderNetList(); } }),
    select([["", "Any status"], ...NET_ST], S.netSt || "", { "aria-label": "Filter by status", onchange: (e) => { S.netSt = e.target.value; renderNetList(); } }),
    h("button", { class: "btn primary", onclick: () => coModal() }, "Add a company"), h("button", { class: "btn", onclick: () => pePersonModal() }, "Add a person"));
  el.append(bar, h("div", { id: "netlist" }));
  renderNetList();
}
function netOpen() { try { return JSON.parse(localStorage.getItem("hub.netOpen") || "{}"); } catch (e) { return {}; } }
function netOpenSave(o) { try { localStorage.setItem("hub.netOpen", JSON.stringify(o)); } catch (e) { /* storage unavailable */ } }
function setAllNet(list, on) { const o = netOpen(); list.forEach((c) => { o[c.id] = on; }); netOpenSave(o); renderNetList(); }
const NET_HUES = [215, 28, 165, 322, 48, 265, 190, 350];
function netHue(c, prev) { const N = S.hub.networking.companies; let i = Math.max(0, N.indexOf(c)) % NET_HUES.length; if (prev !== undefined && NET_HUES[i] === prev) i = (i + 1) % NET_HUES.length; return NET_HUES[i]; }
const initials = (n) => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const stale = (o) => (o.status === "Contacted" || o.status === "Drafted") && o.last && dayDiff(o.last) !== null && dayDiff(o.last) <= -7;
function statusDots(ppl) { return h("span", { class: "pdots", role: "img", "aria-label": ppl.map((p) => p.name + ": " + (p.status || "Not contacted")).join("; ") }, ppl.map((p) => h("i", { class: "pdot " + netCls(p.status || "Not contacted"), title: p.name + ": " + (p.status || "Not contacted") }))); }
function renderNetList() {
  const box = clear($("#netlist")), N = S.hub.networking, q = (S.netQ || "").toLowerCase(), ty = S.netType || "", st = S.netSt || "", view = S.netView || "companies";
  const hay = (o) => Object.values(o).join(" ").toLowerCase();
  if (view === "companies") {
    const list = N.companies.filter((c) => (!q || hay(c).includes(q) || N.people.some((p) => p.company_id === c.id && hay(p).includes(q))) && (!ty || c.type === ty) && (!st || c.status === st));
    if (!list.length) return box.append(h("div", { class: "empty" }, h("strong", {}, "No companies match"), "Clear the filters, or add a company."));
    box.append(h("div", { class: "chips", style: "justify-content:flex-end;margin-bottom:8px" }, h("button", { class: "btn sm", onclick: () => setAllNet(list, true) }, "Expand all"), h("button", { class: "btn sm", onclick: () => setAllNet(list, false) }, "Collapse all")));
    let prevHue;
    list.forEach((c) => {
      const hue = netHue(c, prevHue); prevHue = hue;
      const ppl = N.people.filter((p) => p.company_id === c.id);
      const stSel = select(NET_ST, c.status || "Not contacted", { class: "statsel chip " + netCls(c.status || "Not contacted"), "aria-label": "Status for " + c.name, onclick: (e) => e.stopPropagation(), onchange: async (e) => { c.status = e.target.value; if (c.status !== "Not contacted" && !c.last) c.last = todayIso(); await saveNet(); renderNetList(); } });
      const det = h("details", { class: "resgroup netco", style: "--hue:" + hue, open: !!q || netOpen()[c.id] === true },
        h("summary", {}, h("span", { class: "gname" }, c.name), c.type ? h("span", { class: "chip" }, c.type) : null, c.hq ? h("span", { class: "chip" }, c.hq) : null,
          h("span", { class: "muted small" }, ppl.length ? ppl.length + (ppl.length === 1 ? " person" : " people") : "no people yet"), ppl.length ? statusDots(ppl) : null, stale(c) || ppl.some(stale) ? h("span", { class: "chip warn" }, "Follow up") : null, stSel));
      det.addEventListener("toggle", () => { const o = netOpen(); o[c.id] = det.open; netOpenSave(o); });
      const card = h("section", { class: "card panel" },
        h("div", { class: "res-row", style: "border-top:0;padding-top:0" },
          h("div", {}, h("div", { class: "chips", style: "margin:0 0 4px" }, c.size ? h("span", { class: "chip" }, c.size) : null, c.remote ? h("span", { class: "chip good" }, c.remote) : null), c.focus ? h("div", { class: "small" }, c.focus) : null, c.why ? h("div", { class: "small muted", style: "margin-top:2px" }, "Why: " + c.why) : null),
          h("div", { style: "align-self:start" }, h("button", { class: "btn sm ghost", onclick: () => coModal(c) }, "Edit"))),
        h("div", { class: "chips", style: "margin-top:8px" }, netLinks(c, ["site", "contact", "team", "linkedin"]), (c.site || c.contact || c.team || c.linkedin || c.email) ? null : h("span", { class: "small muted" }, "No contact links yet")),
        c.notes ? h("div", { class: "small muted", style: "margin-top:8px" }, linkify(c.notes)) : null,
        c.next || c.last ? h("div", { class: "small", style: "margin-top:6px" }, c.next ? "Next: " + c.next : "", c.last ? h("span", { class: "muted" }, (c.next ? " · " : "") + "Last contact " + niceDate(c.last)) : null) : null,
        c.checked ? h("div", { class: "small muted" }, "Links checked " + niceDate(c.checked)) : null);
      if (ppl.length) { const pl = h("div", { style: "margin-top:10px;border-top:1px solid var(--line)" }); ppl.forEach((p) => pl.append(personRow(p, false, hue))); card.append(pl); }
      card.append(h("div", { style: "margin-top:8px" }, h("button", { class: "btn sm", onclick: () => pePersonModal(null, c) }, "Add a person here")));
      det.append(card); box.append(det);
    });
  } else {
    const list = N.people.filter((p) => (!q || hay(p).includes(q)) && (!st || p.status === st) && (!ty || (N.companies.find((c) => c.id === p.company_id) || {}).type === ty));
    if (!list.length) return box.append(h("div", { class: "empty" }, h("strong", {}, "No people yet"), "Add named contacts as you find them (team pages, LinkedIn, event speaker lists)."));
    const card = h("section", { class: "card panel", style: "padding-top:4px;padding-bottom:4px" }); list.forEach((p, i) => { const pc = N.companies.find((c) => c.id === p.company_id); const r = personRow(p, true, pc ? netHue(pc) : undefined); if (i === 0) r.style.borderTop = "0"; card.append(r); }); box.append(card);
  }
}
function personRow(p, showCo, hue) {
  const co = S.hub.networking.companies.find((c) => c.id === p.company_id), coName = co ? co.name : p.company || "";
  return h("div", { class: "res-row pe", style: hue === undefined ? "" : "--hue:" + hue },
    h("span", { class: "avatar", "aria-hidden": "true" }, initials(p.name)),
    h("div", {}, h("strong", {}, p.name), stale(p) ? h("span", { class: "chip warn", style: "margin-left:8px" }, "Follow up") : null, h("span", { class: "muted" }, (p.title ? " · " + p.title : "") + (showCo && coName ? " · " + coName : "")),
      p.why ? h("div", { class: "small muted" }, p.why) : null,
      h("div", { class: "chips", style: "margin-top:4px" }, netLinks(p, ["url", "linkedin"])),
      p.next ? h("div", { class: "small", style: "margin-top:4px" }, "Next: " + p.next) : null, p.last ? h("div", { class: "small muted" }, "Last contact " + niceDate(p.last)) : null),
    h("div", { style: "display:grid;gap:6px;justify-items:end;align-self:start" }, select(NET_ST, p.status || "Not contacted", { class: "statsel chip " + netCls(p.status || "Not contacted"), "aria-label": "Status for " + p.name, onchange: async (e) => { p.status = e.target.value; if (p.status !== "Not contacted" && !p.last) p.last = todayIso(); await saveNet(); renderNetList(); } }), h("button", { class: "btn sm ghost", onclick: () => pePersonModal(p) }, "Edit")));
}
function coModal(c) {
  const edit = !!c, f = (k) => (c && c[k]) || "", I = (k, ph, t) => h("input", { value: f(k), placeholder: ph || "", type: t || "text" });
  const name = I("name"), type = select(NET_TYPES, f("type") || "Consulting"), hq = I("hq", "City, country"), size = I("size", "e.g. ~50 people"), remote = I("remote", "e.g. Remote-friendly"), focus = h("textarea", {}), why = I("why"), site = I("site", "https://…", "url"), contact = I("contact", "https://…", "url"), team = I("team", "https://…", "url"), li = I("linkedin", "https://…", "url"), email = I("email", "Public general email only"), next = I("next"), last = I("last", "", "date"), notes = h("textarea", {});
  focus.value = f("focus"); notes.value = f("notes");
  const st = select(NET_ST, f("status") || "Not contacted");
  openModal(edit ? "Edit company" : "Add a company", h("div", { style: "display:grid;gap:12px;max-height:68vh;overflow:auto;padding-right:4px" }, h("div", { class: "grid2" }, field("Name", name), field("Type", type)), h("div", { class: "grid2" }, field("Headquarters", hq), field("Size", size)), field("Remote / location note", remote), field("What they do", focus), field("Why them", why),
    h("div", { class: "grid2" }, field("Website", site), field("Contact page", contact)), h("div", { class: "grid2" }, field("Team page", team), field("LinkedIn", li)), field("General email", email), h("div", { class: "grid2" }, field("Status", st), field("Last contact", last)), field("Next step", next), field("Notes", notes)),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: () => confirmModal("Delete this company?", c.name + " and its people", "Delete", async () => { const N = S.hub.networking; N.companies = N.companies.filter((x) => x !== c); N.people = N.people.filter((p) => p.company_id !== c.id); await saveNet(); renderNetworking(); }) }, "Delete") : null, h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => { if (!name.value.trim()) return toast("Add a name first.", true); const o = c || { id: uid("co_") }; Object.assign(o, { name: name.value.trim(), type: type.value, hq: hq.value.trim(), size: size.value.trim(), remote: remote.value.trim(), focus: focus.value.trim(), why: why.value.trim(), site: site.value.trim(), contact: contact.value.trim(), team: team.value.trim(), linkedin: li.value.trim(), email: email.value.trim(), status: st.value, last: last.value, next: next.value.trim(), notes: notes.value.trim() }); if (!c) S.hub.networking.companies.push(o); closeLayer(); await saveNet(); renderNetworking(); toast("Saved"); } }, "Save")]);
}
function pePersonModal(p, co) {
  const edit = !!p, f = (k) => (p && p[k]) || "", N = S.hub.networking;
  const name = h("input", { value: f("name") }), title = h("input", { value: f("title"), placeholder: "Role at the firm" }), url = h("input", { value: f("url"), placeholder: "Bio or profile link", type: "url" }), li = h("input", { value: f("linkedin"), placeholder: "https://linkedin.com/in/…", type: "url" }), email = h("input", { value: f("email") }), why = h("input", { value: f("why"), placeholder: "Why this person" }), next = h("input", { value: f("next") }), last = h("input", { type: "date", value: f("last") });
  const cosel = select([["", "(none / other)"], ...N.companies.map((c) => [c.id, c.name])], f("company_id") || (co ? co.id : "")), st = select(NET_ST, f("status") || "Not contacted");
  openModal(edit ? "Edit person" : "Add a person", h("div", { style: "display:grid;gap:12px" }, h("div", { class: "grid2" }, field("Name", name), field("Title", title)), field("Company", cosel), h("div", { class: "grid2" }, field("Bio / profile link", url), field("LinkedIn", li)), field("Email (only if public or given to you)", email), field("Why them", why), h("div", { class: "grid2" }, field("Status", st), field("Last contact", last)), field("Next step", next)),
    [edit ? h("button", { class: "btn soft-danger", style: "margin-right:auto", onclick: async () => { N.people = N.people.filter((x) => x !== p); closeLayer(); await saveNet(); renderNetworking(); } }, "Delete") : null, h("button", { class: "btn", onclick: closeLayer }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => { if (!name.value.trim()) return toast("Add a name first.", true); const o = p || { id: uid("pe_") }; Object.assign(o, { name: name.value.trim(), title: title.value.trim(), company_id: cosel.value, url: url.value.trim(), linkedin: li.value.trim(), email: email.value.trim(), why: why.value.trim(), status: st.value, last: last.value, next: next.value.trim() }); if (!p) N.people.push(o); closeLayer(); await saveNet(); renderNetworking(); toast("Saved"); } }, "Save")]);
}


/* ---------- Error log ---------- */
const ERRQ = { level: "all", status: "open" };
async function resolveErr(id, status, note) { try { await api("/api/errors/resolve", "POST", { id, status, note }); renderErrors(); } catch (e) { fail(e); } }
async function renderErrors() {
  const el = clear($("#v-errors")), I = (t) => h("em", {}, t), C = (t) => h("code", {}, t);
  let d;
  try { d = await api("/api/errors"); } catch (e) { return el.append(h("div", { class: "empty" }, h("strong", {}, "Could not read the error log"), e.message)); }
  const st = (x) => x.status || "open";
  const lines = (list) => list.map((x) => "[" + x.at.replace("T", " ") + "] " + x.level.toUpperCase() + " " + x.area + " (id " + x.id + ")" + (x.count > 1 ? " (x" + x.count + ")" : "") + ": " + x.message + (x.detail ? "\n" + x.detail : "")).join("\n\n");
  const copy = async () => { try { await navigator.clipboard.writeText(lines(d.items.filter((x) => st(x) === "open"))); toast("Copied the open ones. Paste them into a Claude chat."); } catch (e) { toast("Could not copy. Open data/errors.json instead.", true); } };
  const seg = (opts, key) => h("div", { class: "seg", role: "group" }, opts.map(([k, t]) => h("button", { "aria-pressed": String(ERRQ[key] === k), onclick: () => { ERRQ[key] = k; renderErrors(); } }, t)));
  const items = d.items.filter((x) => (ERRQ.level === "all" || x.level === ERRQ.level) && (ERRQ.status === "all" || (ERRQ.status === "open" ? st(x) === "open" : st(x) !== "open")));
  const nOpen = d.items.filter((x) => st(x) === "open").length;
  el.append(h("div", { class: "section-head" }, h("h2", {}, "Error log"), h("div", { class: "chips" }, seg([["open", "Open (" + nOpen + ")"], ["handled", "Fixed or ignored"], ["all", "All"]], "status"), seg([["all", "Any level"], ["error", "Errors"], ["warn", "Warnings"]], "level"),
    h("button", { class: "btn sm", onclick: copy, disabled: !nOpen }, "Copy open ones"),
    h("button", { class: "btn sm soft-danger", disabled: !d.items.length, onclick: async () => { if (!confirm("Clear the whole log?")) return; try { await api("/api/errors/clear", "POST", {}); toast("Cleared"); renderErrors(); refreshErrBadge(); } catch (e) { fail(e); } } }, "Clear log"))),
    h("p", { class: "muted small", style: "margin:0 0 12px;max-width:80ch" }, "Anything that breaks in Search, Records or the rest of the page lands here, newest first. ", h("b", {}, "Errors"), " are failures; ", h("b", {}, "warnings"), " are things that did not work but did not stop anything. ", I("Claude checks this log at the start of each Job Hunt chat"), ", fixes what it can and marks it Fixed with a note; what it cannot fix stays Open. You can also press ", I("Copy open ones"), " and paste them into a chat, or ask Claude to read ", C("Daily Hub/data/errors.json"), "."));
  if (!items.length) el.append(h("div", { class: "empty" }, h("strong", {}, d.items.length ? (ERRQ.status === "open" ? "Nothing open" : "Nothing at this level") : "No errors logged"), d.items.length ? "Switch the filters above." : "That is the good outcome. Problems will show up here and as a number next to Error log in the menu."));
  items.forEach((x) => el.append(h("article", { class: "card errrow st-" + st(x) },
    h("div", { class: "errhead" }, h("span", { class: "chip " + (x.level === "warn" ? "warn" : "rej") }, x.level === "warn" ? "Warning" : "Error"), h("span", { class: "chip " + (st(x) === "fixed" ? "good" : st(x) === "ignored" ? "" : "wait") }, st(x) === "fixed" ? "Fixed" : st(x) === "ignored" ? "Ignored" : "Open"), h("strong", {}, x.area), x.count > 1 ? h("span", { class: "chip" }, "× " + x.count) : null,
      h("span", { class: "muted small", style: "margin-left:auto" }, new Date(x.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))),
    h("div", { class: "errmsg" }, x.message),
    x.fix ? h("div", { class: "errfix small" }, h("b", {}, st(x) === "fixed" ? "Fix: " : "Note: "), x.fix) : null,
    h("div", { class: "chips", style: "margin-top:8px" }, st(x) === "open" ? [h("button", { class: "btn sm", onclick: () => resolveErr(x.id, "fixed", "marked fixed by hand") }, "Mark fixed"), h("button", { class: "btn sm ghost", onclick: () => resolveErr(x.id, "ignored", "ignored by hand") }, "Ignore")] : h("button", { class: "btn sm ghost", onclick: () => resolveErr(x.id, "open", "") }, "Reopen")),
    x.detail ? h("details", {}, h("summary", { class: "small muted" }, "Technical details"), h("pre", {}, x.detail)) : null)));
  try { if (d.new) { await api("/api/errors/seen", "POST", {}); $("#c-errors").textContent = ""; } } catch (e) { /* not important */ }
}
