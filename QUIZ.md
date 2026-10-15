# IntelliSched AI: Hard-Level Engineering Quiz

A test for a **senior software developer** who wants to show they understand this codebase, not just use it. Every question is about a real decision, edge case or bug in IntelliSched. See [DECISIONS.md](DECISIONS.md) and [FLOW.md](FLOW.md) for background.

## Rules

- **20 questions × 5 points = 100 points.** Partial credit is allowed: each answer lists what earns the points.
- **Pass: 70+.** **Distinction: 85+.** Below 70: fail; re-read the files named in the answer and try again in a week.
- Answer in writing **before** opening the hidden answer under each question.
- You may read the code. You may not run it.
- Record your score per question in the [score sheet](#score-sheet) at the end.

---

## Section A: Capacity, scheduling and algorithms

### Q1. The arithmetic of infeasibility (5 pts)

The dataset needs **1,728** session-hours a week. Supply is **18 rooms × 36 slots = 648** room-hours.

(a) What is the minimum number of rooms needed to schedule the whole catalog at once?
(b) Term scoping runs only odd **or** even semesters. Assuming demand splits evenly, is one term feasible with 18 rooms?
(c) Name one reason the true minimum is *higher* than your answer to (a).

<details><summary>Answer</summary>

- **(a)** 1,728 / 36 = **48 rooms** (2 pts).
- **(b)** One term needs about 864 hours against 648 available, so it is **still about 1.33× over**. Term scoping helps but does not make the dataset feasible on its own (2 pts). A candidate who simply says "yes, halving fixes it" gets 0 for (b).
- **(c)** Any one of these (1 pt):
  - Rooms are split by type: lab demand can only use the 6 labs.
  - Labs need 2 consecutive periods that don't cross a break.
  - Teacher, section and building-travel clashes leave slots empty.
  - Not every cell is "open".
  - Room capacity must be at least the section's strength.

</details>

### Q2. Why random restarts? (5 pts)

`generateTimetable` runs a greedy placement **30 times** with `Math.random() * 3` jitter and keeps the best run. Explain:

(a) why a single deterministic greedy pass can fail to place a session even when a full solution exists;
(b) what the jitter buys;
(c) what it can never guarantee, and which part of the repo exists for that.

<details><summary>Answer</summary>

- **(a)** Greedy commits to the locally best slot and never backtracks. An early session can take the only slot or room a later, more constrained session needed (for example a lab that needs 2 free consecutive periods). Order matters (2 pts).
- **(b)** Different tie-breaks give different orders and choices, so it samples several local optima. It's a cheap form of randomised search (1 pt).
- **(c)** It can't guarantee **optimality or completeness**: it may report sessions as unplaced in a feasible instance (1 pt). The offline **`ml/` pipeline uses OR-Tools CP-SAT**, an exact constraint solver (1 pt).

</details>

### Q3. Lab session splitting edge case (5 pts)

```js
const lens = lab ? [...Array(Math.floor(hours / 2)).fill(2), ...(hours % 2 ? [1] : [])] : Array(hours).fill(1)
```

The header comment says "lab sessions are 2 back-to-back periods". What happens for a lab with `WeeklyHours = 3`? Is it a bug, and how would you resolve it?

<details><summary>Answer</summary>

- It produces sessions of **[2, 1]**: one double period plus **one single-period lab** (2 pts).
- That contradicts the documented hard rule, so it's either a documentation bug or a modelling gap (1 pt).
- Any reasonable resolution, with its trade-off, earns the last 2 pts:
  - Round up to 2 + 2 and flag the extra hour.
  - Treat the odd hour as a tutorial or theory period in a classroom.
  - Reject odd lab hours in `validateRow`.
  - Update the comment to say "2 periods, plus 1 for odd hours".

</details>

### Q4. Yearly programs and term scoping (5 pts)

The subject catalog maps yearly programs (D.Pharm, Pharm.D, GNM, ANM, M.Ed) so that **year N → semester 2N − 1**. What happens to these programs when an admin generates an **even-term** timetable, and what is the cleanest fix?

<details><summary>Answer</summary>

- All their subjects sit in **odd** semesters, so an even-term run schedules **none** of them, and an odd-term run schedules **all** of them every term (3 pts).
- Fix (2 pts), any of:
  - Mark subjects or branches as **annual** and include annual programs in both terms.
  - Duplicate annual subjects into both semesters of the year with half the weekly hours.
  - Add a per-branch `SemestersPerYear = 1` and teach the term filter about it.

</details>

### Q5. Auto-assign: compute the fit (5 pts)

Using `fitScore` in `frontend/src/assigner.js`, compute the effective score for this teacher, who **already has 2 sections** of the subject:

| ExperienceYears | TimesTaught | ResearchPapers | Same branch as subject |
|---|---|---|---|
| 10 | 2 | 0 | yes |

Then say why the penalty exists and why the score is capped per component.

<details><summary>Answer</summary>

- Calculation: 40 × (10/20) + 25 × (2/5) + 20 × (log1p(0)/log1p(50)) + 15 × 1 = 20 + 10 + 0 + 15 = **45**. Minus `SHARE_PENALTY` 15 × 2 = **15** (3 pts; 2 pts if only the 45 is right).
- **The penalty** spreads sections across teachers with similar scores instead of giving one teacher all of them (1 pt).
- **The caps and log scale** keep one inflated input (say 200 papers) from dominating the whole ranking (1 pt).

</details>

### Q6. Deterministic shuffle (5 pts)

```js
const shuffleKey = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0 }
```

(a) Which algorithm is this, and why use it rather than `Math.random()` for the **last** tie-break?
(b) Why `Math.imul` instead of `*`?
(c) Why `>>> 0`?

<details><summary>Answer</summary>

- **(a)** **FNV-1a** (32-bit) (1 pt). It's stable and reproducible: the same data gives the same assignment every run, so it can be tested and diffed, while still not always favouring the lowest ID (1 pt).
- **(b)** `*` on large numbers becomes a float and loses the low bits. `Math.imul` does true 32-bit integer multiplication with wrap-around (2 pts).
- **(c)** It converts the signed 32-bit result to an **unsigned** 32-bit number, so the keys sort consistently and aren't negative (1 pt).

</details>

---

## Section B: Security and backend

### Q7. JWTs that outlive their user (5 pts)

Tokens are signed with `JWT_SECRET` and live **12 hours**. The admin password leaks. You change `ADMIN_PASSWORD` in `.env` and redeploy. Is the attacker locked out? If not, what actually works, and what does it cost?

<details><summary>Answer</summary>

- **No** (2 pts). Tokens are stateless. Any token already issued stays valid until it expires, because changing the password doesn't invalidate it.
- **Rotating `JWT_SECRET`** invalidates every token at once (2 pts). The cost is that **everyone** is signed out (1 pt).
- Other acceptable answers: a server-side token version or deny-list checked in `auth`, or shorter token lifetimes with refresh tokens. They trade statelessness for revocation.

</details>

### Q8. Lockout semantics with a TTL index (5 pts)

`attempts` has `createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })`. After 5 failures the key is "locked for 15 minutes".

(a) What does `expireAfterSeconds: 0` mean here?
(b) Can a lock last longer than 15 minutes? Why?
(c) What does `isLocked` have to do so that an expired-but-not-yet-deleted document doesn't keep someone locked out?

<details><summary>Answer</summary>

- **(a)** The document expires **at the time in `expireAt`**, with no extra offset (1 pt).
- **(b)** Yes. Mongo's TTL monitor runs about every **60 seconds**, so deletion can lag by up to roughly a minute, or longer under load (2 pts).
- **(c)** It must check `expireAt > now` itself instead of trusting that the document no longer exists (2 pts). `db.js` does this through `live(key)`.

</details>

### Q9. Brute-forcing the admin password through the delete endpoint (5 pts)

A **feeder** sends `POST /tables/Subjects/rows/delete` with 11 of their own pending row IDs and a guessed `adminPassword`.

(a) Does the endpoint even ask a feeder for the admin password?
(b) How many guesses can they make per hour, and whose account gets locked?
(c) Is this a vulnerability, a usability bug, or both?

<details><summary>Answer</summary>

- **(a)** Yes. `adminPasswordOk` runs for **any** role once the matched count is over 10 or covers the whole table (1 pt).
- **(b)** The key is `adminpw:<feeder username>`, so the **feeder** gets locked, not the admin. That allows 5 guesses per roughly 15 minutes, about 20 per hour (2 pts). Each guess is checked with bcrypt against **every** admin.
- **(c)** **Both** (2 pts):
  - Usability: a feeder can never bulk-delete their own pending rows without knowing the admin password.
  - Security: it gives a slow but real way to guess the admin password.

  A good fix: feeders don't get this path at all (cap their bulk deletes at 10, or let only admins reach it), and lockout is keyed by IP as well as username.

</details>

### Q10. `trust proxy` (5 pts)

`app.set('trust proxy', 1)` is set "so `req.ip` is the client's address behind Vercel's proxy". What goes wrong if this same server is run **directly on the internet** with no proxy in front, and why does the `1` matter?

<details><summary>Answer</summary>

- With no proxy, `req.ip` comes from the **client-controlled `X-Forwarded-For` header** (2 pts).
- Concretely, the login lockout key is `` `login:${name}:${req.ip}` `` in `server.js`. An attacker who sends a new fake IP with each attempt gets a **fresh lockout counter every time**, so the 5-tries / 15-minute guard is bypassed entirely (1 pt).
- `1` means "trust exactly one hop", the nearest proxy. `true` would trust the whole header chain, which is even easier to spoof (2 pts).

</details>

### Q11. Express 5 and `wrap()` (5 pts)

```js
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
```

The app uses **Express 5**. Is `wrap` still necessary? What does it guard against in Express 4, and is there any reason to keep it?

<details><summary>Answer</summary>

- In **Express 4**, a rejected promise from an async handler is **not** passed to error middleware. The request hangs, or the process logs an unhandled rejection. `wrap` forwards it to `next(err)` (2 pts).
- **Express 5 does this itself** for handlers that return promises, so `wrap` is **redundant** (2 pts).
- A reason to keep it (1 pt), either of:
  - It's harmless and makes the intent explicit.
  - It makes downgrading or reusing the code safe.

  Removing it is also a fine answer.

</details>

### Q12. Fail-fast configuration (5 pts)

The server throws on start-up if `JWT_SECRET` is under 32 characters, a password is under 10, or `ADMIN_USERNAME == FEEDER_USERNAME`, compared after `trim().toLowerCase()`. Explain the specific threat behind each of the three checks.

<details><summary>Answer</summary>

- **Short JWT secret:** HS256 tokens can be **brute-forced offline** from any captured token, and a cracked secret lets an attacker forge admin tokens (2 pts).
- **Short passwords:** online guessing becomes realistic, even with the lockout (1 pt).
- **Same username:** login looks users up by username, so a collision would make one account **shadow** the other, for example the feeder logging in with admin rights or one account becoming unreachable. Normalising stops "Admin" and "admin " from bypassing the check (2 pts).

</details>

---

## Section C: Data model and consistency

### Q13. One collection, one index (5 pts)

Every table lives in `rows` with the index `{ dbId: 1, table: 1 }`.

(a) Is `DELETE /databases/:id` (`deleteMany({ dbId })`) covered by that index?
(b) Name a query this design makes slow that a per-table collection wouldn't.
(c) What protects referential integrity, given that Mongo doesn't?

<details><summary>Answer</summary>

- **(a)** **Yes.** `dbId` is the index **prefix**, so a filter on `dbId` alone uses it (1 pt).
- **(b)** Any lookup by a field inside the row, such as finding a teacher by `TeacherID` or every assignment for a `SectionID`. It filters within the `(dbId, table)` range without a field index. Unique keys like `SubjectCode` per branch have no database-level unique constraint (2 pts).
- **(c)** `validateRow` on the server checks references and duplicate keys from the shared schema, plus hand-written cascades, for example deleting a teacher also deletes their preferences and availability (2 pts). Concurrent writes can still race past these checks, because there's no transaction or unique index.

</details>

### Q14. Two admins, one "whole table" (5 pts)

The client predicts that a delete needs a password with:

```js
const whole = ids.length === (active.data[table] ?? []).length
```

The server recomputes `count === countDocuments({ dbId, table })`. Describe a real interleaving between two admins where the client and server disagree, and show the user still ends up safe.

<details><summary>Answer</summary>

- Admin A has a stale copy showing 5 Subjects and selects all 5. The client thinks "whole table" and asks for the password. Meanwhile admin B adds a 6th subject, so the server sees 5 of 6: not the whole table, no password needed. The extra password is harmless (2 pts).
- The reverse: A sees 6 rows and deletes 5, while B deletes the 6th. The client thinks "partial, no password", but the server sees 5 of 5, the whole table, and returns **403 `needsPassword`**. `confirmThen` catches it and **asks again with the server's reason**. The server is the authority, so nothing is deleted without the password (3 pts).

</details>

### Q15. The promise stored in React state (5 pts)

```js
const confirmThen = useCallback(async (opts, send) => {
  const ask = (o) => new Promise((resolve) => setDialog({ ...o, resolve }))
  ...
```

(a) Why is it safe for this `useCallback` to have empty dependencies?
(b) What happens to the **first** caller if a second `confirmThen` starts before the first dialog is answered?
(c) Propose a fix.

<details><summary>Answer</summary>

- **(a)** It only uses `setDialog`, which React guarantees is **stable**, and its own arguments, so there are no stale closures (1 pt).
- **(b)** The second `setDialog` **overwrites** the first dialog's `resolve`. The first promise **never settles**: its `await` hangs forever and leaks, and that operation silently never happens or reports (2 pts).
- **(c)** Any of (2 pts):
  - Reject or resolve with `null` for the previous dialog before replacing it (`setDialog(prev => { prev?.resolve(null); return next })`).
  - Queue dialogs.
  - Disable delete actions while a dialog is open.

</details>

### Q16. Hiding used options without breaking edit (5 pts)

The Sections dropdown now hides letters already used. Two lines make **editing** an existing section still work:

```js
const takenSections = new Set(db.Sections.filter((r) => r._id !== row?._id && ...).map((r) => r.Section))
SECTION_LETTERS.filter((s) => !takenSections.has(s) || s === val)
```

Explain what each guard prevents, and give the bug you'd get without each one.

<details><summary>Answer</summary>

- **`r._id !== row?._id`** keeps the row being edited from counting as "taken" (2 pts). Without it, editing section B would hide **B** itself, the `<select>` would have no matching option, and saving unchanged would fail or blank the field.
- **`|| s === val`** keeps the current value visible even if it is taken, for example a duplicate created by an import or by another user meanwhile (2 pts). Without it, a controlled `<select>` with a value not in its options shows blank.
- Both also matter for "Save & add another" (1 pt): the saved letter disappears and the next free one is offered.

</details>

### Q17. The per-branch length regression (5 pts)

The first version of the per-branch year override was:

```js
setForm((f) => ({ ...f, BranchCode: x.BranchCode, BranchName: x.BranchName, ...(x?.TotalYears ? { TotalYears: x.TotalYears } : {}) }))
```

Testing showed: pick **BMLS** (4 years), then **BMLT** (no override), and the form still says 4 years. Explain the root cause, the fix, and the general lesson.

<details><summary>Answer</summary>

- **Root cause:** spreading `{}` when there's no override **keeps the previous value** in `f`. "Absent" was treated as "unchanged" instead of "use the default" (2 pts).
- **Fix:** `const years = x?.TotalYears ?? degree?.TotalYears` and always set it (2 pts).
- **Lesson:** a derived field should be **recomputed from its sources** on every change, not patched conditionally. Any test of an override must also switch **back** to the non-override case (1 pt).

</details>

---

## Section D: Data engineering and process

### Q18. Credits from a marks column (5 pts)

When the IUL PDFs were parsed, "Communication Skills (2 h/week)" came out with **5 credits**. The fix was: *if the parsed credit is greater than the weekly hours, recompute it as L + T + P/2.* Why is that rule sound for Indian university schemes, and give one valid case it would **wrongly** "fix".

<details><summary>Answer</summary>

- In the L-T-P-C convention, **1 credit = 1 lecture or tutorial hour, or 2 practical hours, per week**. So credits can't exceed weekly contact hours. A higher value almost certainly came from an adjacent **marks** column such as class test 5 or 10 (3 pts).
- Wrongly "fixed" cases (2 pts), any of:
  - Courses that carry credits with little or no contact time: project, seminar, research or self-study credits, MOOCs.
  - Studio subjects where IUL awards more credits than hours.

  In this catalog, rows with 0 hours were dropped anyway.

</details>

### Q19. Electives vs. unparsed core papers (5 pts)

A row extracted **without L-T-P** could be an option in an elective list, or a **core** paper whose hours simply weren't parsed, as with many B.Arch syllabus headers. The first rule marked every hourless row as an elective, so B.Arch's "Architecture Design-I" became an elective. What signal was used in the end, and what's its weakness?

<details><summary>Answer</summary>

- Rule used (3 pts): a row is an elective **only if** it came from a scheme **table** (an option list) **and no copy of that code anywhere had hours**, or its name contains "Elective". Hourless rows from per-course **syllabus headers** are treated as core. NEP codes ending in `T` (theory) or `P` (practical) are treated as core.
- Weakness (2 pts), any of:
  - A core paper listed in a table without hours (some layouts) is still mislabelled as an elective.
  - An elective with its own hours row is labelled core.

  It's a heuristic on layout, not on meaning.

</details>

### Q20. Working against a shared live database (5 pts)

During this work the database's row count changed from 119 to 87 to 92 to 138 while tools were only reading. Give **three** concrete rules a developer or agent should follow in this environment, and explain how the `gen` command in `driver.mjs` follows them.

<details><summary>Answer</summary>

Any three rules (1 pt each):

- **Read-only by default.** Make no writes or deletes through the API without explicit permission.
- Treat counts and IDs as **moving**: re-read before acting, and never act on a cached list of `_id`s.
- Verify with **non-mutating** probes: open a dialog, then cancel, and assert that 0 non-GET requests were sent.
- Use a **separate database** (the app supports several) or a local Mongo for destructive tests.
- Never print secrets read from `.env`.

How `gen` follows them (2 pts): it **loads data through the API and runs `generateTimetable` locally through Vite's `ssrLoadModule`, then prints results without saving**, so the shared timetable is never overwritten.

</details>

---

## Score sheet

| Q | Topic | Max | Your score |
|---|---|---|---|
| 1 | Capacity arithmetic | 5 | |
| 2 | Greedy + restarts | 5 | |
| 3 | Lab splitting | 5 | |
| 4 | Yearly programs | 5 | |
| 5 | Fit score | 5 | |
| 6 | FNV-1a | 5 | |
| 7 | JWT revocation | 5 | |
| 8 | TTL lockout | 5 | |
| 9 | Admin-password brute force | 5 | |
| 10 | trust proxy | 5 | |
| 11 | Express 5 errors | 5 | |
| 12 | Fail-fast config | 5 | |
| 13 | Single collection | 5 | |
| 14 | Concurrent whole-table | 5 | |
| 15 | Promise in state | 5 | |
| 16 | Hiding used options | 5 | |
| 17 | Override regression | 5 | |
| 18 | Credits heuristic | 5 | |
| 19 | Elective heuristic | 5 | |
| 20 | Shared live DB | 5 | |
| | **Total** | **100** | |

**Result:** **≥ 85 Distinction** · **70–84 Pass** · **< 70 Not yet**: re-read the code and files named in the answers you missed and retake it.

> Several answers (Q3, Q4, Q9, Q15) describe **real, still-open issues** in the code. A strong candidate should also say how they would fix and test each one. That's the real hard-level signal.
