**AI involvement statement**  
Modelled on the structure of Anthropic's "AI Diligence Statement" (AI Fluency course, Dakan and Feller, CC BY-NC-SA 4.0): what the work is, what the person did, what the AI did, and how it was checked. Items marked **[confirm]** are for the author to edit before relying on this.  
**The work**  
A local job-search web app (this repository), built for the author's own use and published as a portfolio piece. Data in the author's copy is private and is not in this repository.  
**Who did what**  
- **The author:** decided what the app is for; asked for every feature and change in plain language; ran the app on their own machine; reported what was confusing, broken or ugly; made the product decisions (for example tab names, which clusters to use, which resume goes with which cluster, that the repository is public).   
- **The AI (Claude, by Anthropic):** wrote essentially all of the code (Python server, JavaScript front end, CSS, scanner glue); designed the data migrations; wrote the sandbox tests; reorganized and scrubbed the project for publication; drafted this statement and the other docs.  
**How it was checked**  
- Each change was run in an isolated copy against a copy of real data, then driven with a headless browser (Playwright): every tab opened, key interactions clicked, page errors collected. Screenshots were reviewed.  
- Python was compile-checked and JavaScript syntax-checked before installing. Installs were guarded by file-modification checks and followed by a hash comparison. Backups were kept before each batch of changes.  
- Search against the live internet could only partly be tested from the build environment; those paths were validated by the author's use afterwards.  
- There is** **no automated test suite, and the code was not independently reviewed line by line.   
**Examples of where the AI went wrong, and how it showed up**  
- A pop-up was clipped on the right edge; found by the author using the app.  
- Two tab colours were too similar and one clashed with a status colour; found by the author.  
- A filter box lost focus after each keystroke; found by the author.  
- Web search was unreliable on the author's network even though it worked in the build environment.  
- Initial results were not tuned correctly to career preferences, and required further discussion  
- Several bugs went unnoticed by the AI  
 These are in [PERSONALIZATION.md too.](PERSONALIZATION.md "PERSONALIZATION.md")  
**Privacy**  
Nothing personal is in this repository: no applications, contacts, notes, employer lists, resume names, local paths or keys. Seed data is a few fictional examples used only for the screenshots. The personalization history was trimmed of personal detail. The scanner's example employer list is five public job boards.  
**Limits of this statement**  
It describes the process as the AI recorded it during the work. It is not a guarantee of correctness or security. Use at your own risk, and read the code before trusting it with real data.  
