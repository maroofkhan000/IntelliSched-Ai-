# IntelliSched AI: Decision Log

Every significant design decision made on the project so far, in the order it was made: what was decided, why, and what it costs. The newest decisions (October 2026) are not committed yet; see [Status](#status).

Format per entry: **Context** (the problem), **Decision**, **Why**, **Trade-offs / consequences**.

---

## D1. Scope the timetable to an active term, not the whole catalog

- **Context:** `timetable_dataset.xlsx` is a full 4-branch, 8-semester catalog. Its weekly demand is about 1,728 session-hours. Its supply is 18 rooms × 36 slots = 648 room-hours, so it is oversubscribed about 2.7×.
- **Decision:** The generator works on one term at a time: all, odd (1, 3, 5, 7) or even (2, 4, 6, 8) semesters, optionally one branch (`TERMS` in `frontend/src/generator.js`).
- **Why:** A university only runs odd or even semesters at once. Scheduling the whole catalog can never succeed and would hide real conflicts.
- **Trade-offs:** The user has to pick a term. A timetable for the whole year is two separate runs.

## D2. Two roles: Admin and Feeder, with approval

- **Context:** Many people enter data; one person is responsible for it.
- **Decision:** A Feeder's rows are saved as `pending`, and only an Admin can approve or reject them. Feeders can delete only their own pending rows (`canDeleteRow` in `store.jsx`, and the matching server filter).
- **Why:** Data entry can be spread across staff without letting unreviewed data reach the timetable. The generator and auto-assign read **approved rows only**.
- **Trade-offs:** There's an extra review step, and the admin can become a bottleneck. The bulk approve and reject buttons help.

## D3. React + Vite frontend, Express + MongoDB backend, one Vercel project

- **Context:** The first version kept data in `localStorage`. Several people need to share one database.
- **Decision:** A React 19 / Vite single-page app, an Express 5 API, and MongoDB Atlas. Both are deployed as one Vercel project with services. In development, Vite proxies `/api` to `localhost:4000`.
- **Why:** It's a single language (JavaScript) end to end, the free tiers are enough, and one deploy unit means no CORS problems in production.
- **Trade-offs:** Every developer shares the online database, and row counts change while you work. Agents and tools must treat the database as read-only unless told otherwise.

## D4. One `rows` collection with a `table` field

- **Context:** There are about 11 logical tables (Branches, Sections, Subjects, Teachers, ...).
- **Decision:** All records go in one Mongo collection keyed by `{ dbId, table }` with an index on it. The schema lives in code (`backend/src/schema.js`), not in Mongo.
- **Why:** Adding or changing a table means editing code, with no migrations. "Multiple databases" (workspaces) come almost for free through `dbId`.
- **Trade-offs:** No database-level referential integrity. The server checks references in `validateRow`, and some cascades, such as deleting a teacher's preferences with the teacher, are hand-written.

## D5. The schema is shared by client and server

- **Decision:** `frontend/src/schema.js` re-exports `backend/src/schema.js` (Vite `fs.allow: ['..']`).
- **Why:** Validation runs exactly the same in the form (instant feedback) and on the server (the authority). There's one source of truth.
- **Trade-offs:** The frontend build depends on a file outside its own folder.

## D6. Logins from `.env`, refusing to start with weak secrets

- **Decision:** The admin and feeder usernames and passwords, and `JWT_SECRET`, come from environment variables. The server **refuses to start** if a secret is missing, a password is under 10 characters, the JWT secret is under 32 characters, or the two usernames match.
- **Why:** No demo passwords in the repo. A weak deploy fails loudly instead of running insecurely.
- **Trade-offs:** Setup is less convenient: a new developer can't run the backend without filling in `.env`.

## D7. JWT bearer tokens (12 h), brute-force lockout in Mongo

- **Decision:** Stateless JWTs signed with `JWT_SECRET` and valid for 12 hours. Wrong passwords are counted per key. After 5 failures the key is locked for 15 minutes, stored in an `attempts` collection with a TTL index that clears it automatically.
- **Why:** It works on serverless Vercel, where there is no in-memory session store. The TTL index removes old lockouts without a cron job.
- **Trade-offs:** Tokens can't be revoked before they expire. Signing out only drops the client's copy.

## D8. Big deletes need the admin password again

- **Context:** One click could wipe a table that many people filled in.
- **Decision:** Deleting **more than 10 rows, or a whole table** (more than one row) needs the admin password, even when an admin is already signed in. The server enforces it (`adminPasswordOk`, `BULK_LIMIT = 10`). The same lockout applies to wrong admin passwords.
- **Why:** It's protection against accidents and against a stolen admin session.
- **Trade-offs:** Big clean-ups take an extra step.

## D9. One in-app confirm dialog for every delete (Oct 2026)

- **Context:** Deletes used the browser's native `window.confirm`, then a *second* modal asked for the admin password. The password modal's button also said "Delete" when the action was actually Reject.
- **Decision:** A single `ConfirmDialog`, driven by a promise-based `confirmThen` in `store.jsx`.
  - It explains exactly what will happen.
  - It asks for the admin password **in the same step** when the client can predict the server will want it (same rule as D8).
  - It re-asks with the server's reason if the password was wrong.
  - The button names the action: Delete, Reject, Clear everything, Replace.

  There are no `window.confirm` calls left.
- **Why:** One consistent dialog, one step instead of two, no browser-blocking popups (which also block test automation), and wording that matches the action.
- **Trade-offs:** The client copies the server's `BULK_LIMIT`. If the two drift apart, the server still wins and the dialog just asks a second time.

## D10. Teacher preferences live inside the Teachers form

- **Decision:** Subject preferences (priority 1–5, years of experience) are edited inside the teacher form and saved atomically through `POST /teachers`. At most `MAX_TOP_PRIORITY = 2` subjects can have priority 1.
- **Why:** A preference is meaningless without its teacher, and one form means one approval.
- **Trade-offs:** The Teachers save endpoint is a special case outside the generic rows API.

## D11. Auto-assign by priority, then experience, then tie-breaks

- **Decision:** `assigner.js` ranks teachers for each subject in this order:
  1. The priority the teacher gave it.
  2. Years of experience in the subject (more wins).
  3. On a tie: fewer sections of this subject already held, then a teacher of the subject's branch, then the lower share of their maximum load used, then a stable FNV-1a shuffle per subject.
- **Why:** Priority and experience are the two things a head of department actually weighs, and both are easy to explain. The tie-breaks spread sections between equal teachers and keep loads even. Times taught and research papers were dropped from the form (Oct 2026): they were rarely filled in and made the old 0–100 fit score hard to explain.
- **Trade-offs:** Experience now strictly outranks everything after it, so a teacher with 1 more year wins even when already busy (up to their max load).

## D12. Greedy timetable generator with random restarts

- **Decision:** The generator is greedy: each session goes to the best-scoring legal slot. It runs 30 times with random tie-breaks and keeps the best run.
  - **Hard rules:**
    - No section, teacher or room is double-booked.
    - Only open cells are used.
    - Teachers stay within their weekly load and are never booked when marked unavailable.
    - Labs are 2 back-to-back periods that never cross a break.
    - Walking time between buildings is respected.
  - **Soft rules (scored):** spread each subject across days, balance each section's and teacher's days, and keep teachers in one (home) block.
- **Why:** It's fast enough to run in the browser, easy to explain, and good on realistic data. Exact solving (CP-SAT) lives in the offline Python `ml/` pipeline.
- **Trade-offs:** It's not optimal, it can fail to place sessions that a complete solver would fit, and results differ between runs. Unplaced sessions are reported with a reason.

## D13. Building travel as a hard rule

- **Decision:** Rooms belong to a building block, and `BuildingTravel` stores walking minutes between blocks. A teacher's next class in another block must leave enough gap for the walk plus their extra travel minutes, and they can change blocks at most their daily maximum. A missing travel time counts as 0 minutes and is reported.
- **Why:** On a real campus, back-to-back classes in distant blocks are impossible.
- **Trade-offs:** More data to enter. With missing travel times the result is optimistic.

## D14. Subject dropdowns come from IUL's real syllabi

- **Context:** Typing subjects by hand is slow and error-prone.
- **Decision:** `frontend/src/subjectCatalog.json` holds Integral University's real study & evaluation schemes. You pick Branch → Year (→ Semester) and choose from that year's subjects, grouped by semester and by Core / Electives. **Other** allows a manual entry, which then joins the dropdown with its code.
- **Why:** Correct codes, names, credits and hours with no typing.
- **Trade-offs:** The catalog is a snapshot of IUL's site and goes stale when IUL revises a scheme.

## D15. How the subject catalog was built (Oct 2026)

- **Decision:** All 872 syllabus PDFs from 20 IUL departments were downloaded.
  - **Extraction:** rows were pulled with pdfplumber (scheme tables plus "Course Code / Title" headers), with a fallback that parses the plain text.
  - **Scanned PDFs:** about 40 of them were read by eye from rendered page images, since there's no OCR on the machine.
  - **Merge rules:**
    - Program-to-PDF mapping uses filename and title regexes.
    - Rows with 0 weekly hours are dropped: projects, internships, dissertations.
    - Credits that are higher than the weekly hours are recomputed, because they came from a marks column.
    - Rows listed without hours inherit that semester's usual theory or lab load. They count as electives only when they came from an option list.
    - Yearly programs (D.Pharm, Pharm.D, GNM, ANM, M.Ed) put year N into semester 2N−1.
- **Result:** 940 → 4,709 subjects across 120 programs, with no duplicates and no semester beyond its branch's length.
- **Trade-offs:**
  - Some programs are partial: BA Psychology, BA Political Science, MA Public Administration, B.Des Communication Design.
  - Two are empty because IUL's links return 404: Occupational Therapy and M.AOTT.
  - Some B.Sc semesters list more subjects than students take, because old and NEP schemes appear side by side.

## D16. Degree catalog with per-branch length

- **Decision:** `frontend/src/degreeCatalog.json` lists degrees → branches. The Branches form is Degree → Branch, which fills in years and semesters per year. A branch may carry its own `TotalYears`, for example a 4-year BMLS under a 3-year "B.Sc (Paramedical)". Switching branches falls back to the degree's length.
- **Why:** A paramedical degree has 3- and 4-year programs. Without the override, every branch would need its own degree.
- **Trade-offs:** The year count is a default, and admins can still edit it.

## D17. Dropdowns hide what's already used

- **Decision:**
  - Subjects already added for a branch drop out of the subject dropdown.
  - Section letters already used for a branch and semester are hidden, where before they were shown greyed out as "(already added)".
  - Teaching Assignments hides subjects the chosen section already has.

  When nothing is listed, the dropdown explains why: "No IUL subjects for EEE year 1 — use Other" is different from "All listed subjects added".
- **Why:** Fewer clicks, no duplicate-key errors after saving, and empty lists are no longer confusing.
- **Trade-offs:** You can't see from the dropdown which items exist already. The table view shows that.

## D18. A project skill and driver for agents

- **Decision:** `.claude/skills/run-intellisched/` contains `SKILL.md` and `driver.mjs`, which uses Playwright with the installed Chrome.
  - `ui`: logs in through the real form and takes screenshots.
  - `api`: calls any authenticated route.
  - `gen`: runs the generator against live data without saving anything.

  Logins are read from `.env` and never printed.
- **Why:** It's a repeatable, read-only way to check changes in the real app.
- **Trade-offs:** It needs Chrome, and Git Bash rewrites `/api/...` arguments into Windows paths; the driver undoes that.

---

## Status

| Decisions | State |
|---|---|
| D1–D8, D10–D14 | Committed (`6007834` … `08b9335`) |
| D9, D11 (new order), D15, D16, D17 | Changed on disk on branch `env-logins-and-delete-password`, **not committed** |
| D18 | Files in `.claude/skills/run-intellisched/`, **not committed** |

## Open questions

1. Should the subject catalog be pruned to the current NEP schemes only, so B.Sc semesters aren't over-full?
2. Should the auto-assign weights (D11) be learned from past timetables by the `ml/` pipeline?
3. Token revocation (D7): is a 12-hour non-revocable token acceptable for the final deployment?
