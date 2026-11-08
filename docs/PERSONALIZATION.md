# How this app was personalized

The app was shaped by plain-language requests, one batch at a time, in conversation with an AI assistant. This is the record: what was asked (paraphrased and trimmed of personal detail) and what it became. The same record lives inside the app (**How it works > How this page has been personalized**) so that it stays current. Dates are 2026.

## Oct 23: first build
- *Ask:* one starting point for the job-search day.
- *Built:* Today, Search, Records, Resources, a "how it works" page and Goals. A local Python app with its own data file instead of a spreadsheet; a detail card with "Open original" in a new tab.

## Oct 26: round two
- Desktop shortcut. Collapsible resource sections. Richer text styling in the guide.
- Manual to-dos on Today plus a "For tomorrow" list and notes that roll into the next day's plan.

## Oct 28: Networking
- Small firms, think tanks and nonprofits where a real person can answer, plus named people at them.

## Oct 30: search rebuilt, Error log
- A *Where* box with places to include and leave out; employer boards plus web search plus local sites; short summaries per listing.
- An Error log tab that collects anything that breaks.

## Nov 3: saved for later
- A state for jobs kept on file that sit in no day's plan.

## Nov 6: reference tab
- A tab for background used to tune the search.

## Nov 7: the big rework (16 requests)
Asked as one list; each line became a change.

| Request | What it became |
|---|---|
| Make the reference tabs larger and distinct | Large, colour-coded section tabs |
| Too much white; add colour | A colour per tab (later pared back, see below) |
| Resources should be Job Boards, Local-Specific (a sub-tab per place), Large Employers, Small Employers | A `kind` on every resource, migrated from the old free-text categories |
| A search should go through local sites, boards with the chosen locations, and large employers for that location; small employers weekly | Four search layers; a background weekly check for small employers |
| Refresh still forces a search; web search is really just LinkedIn and Indeed | Refresh toggles match the new categories; web search became `site:` queries |
| Move "find local sites" into the local sub-tabs; remove it from Search | One place for it |
| Rename Resources, Search, Goals | Employers and Resources; Active Jobs and Search; Goals and Next Steps |
| Goals should also show "For tomorrow" and "Small moves" | The same records rendered in two places |
| Remove "Search for more" from Today (one function, one place) | Removed |
| The daily-scan reminder was snoozed and never came back | Root cause: a permanent Dismiss. Replaced with snooze options and a one-time migration |
| Keep a record of how the page was personalized | This record, stored in the data file and mirrored to a Markdown file |
| Have the assistant fix what appears in the Error log | Error entries gained Open / Fixed / Ignored status and a fix note; a documented triage process |
| Drop "Coming up" items whose date has passed | Done in server and page |

## Nov 7, evening: first-use fixes
- A pop-up form was clipped on the right: fixed for every pop-up.
- Colour problems found by using it: a tab's green clashed with the green "Open" status; two neighbouring tabs looked alike. Result: neutral Records, a distinct colour per tab, then white backgrounds everywhere with colour kept for titles, buttons, menu dots and card edges.
- Refresh search: all four section buttons one colour; plainer wording with bold labels.
- Employers and Resources: an *All pages* view with collapsible sections and Open all / Close all; the filter box keeps focus while typing; pages are marked *Checked today* automatically when a search reaches them, with a distinct badge.
- Web search: DuckDuckGo returned a robot check (HTTP 202) to plain requests. A form-style request is tried first, then the plain one, then Bing.

## Nov 7, night: tracks
- Tracks renamed to six clusters from a personal career map; a job can carry several tracks; the first picked is the main one.
- The main track suggests a resume when saving a job. (A direct question about *where* this appears led to a written walk-through of the two places it happens.)
- Existing records were re-sorted by an estimate, shown with a "~" until edited.

## Patterns worth noting
- **Principle stated by the user, then applied everywhere:** "keep functionality in a single spot."
- **Bugs reported by use, not by test:** the reminder, the clipped pop-up, the colour clashes and the typing focus loss were all found by using the app. Fixes were reproduced first, then verified in a browser.
- **Migrations instead of edits to the data file:** every reshaping of stored data runs once at startup, with a backup first.
- **Judgment calls are labelled:** machine-sorted records show "~" until the owner confirms them.
