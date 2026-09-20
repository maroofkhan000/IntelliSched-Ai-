# IntelliSched AI — Project Overview

**Title:** IntelliSched AI: A Self-Learning Autonomous University Timetable and Academic Resource Optimization System using Multi-Agent AI and Digital Twin Technology
**Project Code:** PCS26/72 · **Institution:** Integral University Lucknow · **Programme:** B.Tech CSE, 2026–2027
**Team:** Maroof Khan (2300101892), Md Adil (2300101990), Krishn Shankar Sharan (2300101777)
**Supervisor:** Mr. Umar Badr Shafeeque

> This document consolidates the three source reports in `15 day report/` (Synopsis, Research-Gap & Comparative Analysis, SRS) plus a profile of the actual dataset supplied in this project folder (`timetable_dataset.xlsx`), and flags where the dataset differs from what the reports assumed. See `ARCHITECTURE.md` for the full system design built on top of this.

---

## 1. Problem & Motivation

University timetabling is a manually-run, error-prone, combinatorially hard process (an instance of the NP-hard **University Course Timetabling Problem, UCTP**). Existing tools (FET, UniTime, aSc TimeTables, Ad Astra, CollegeNET 25Live) solve *feasibility* reasonably well but leave three things unaddressed:

1. **No proactive what-if simulation** — conflicts are found only after a full solve.
2. **No explainable output** — tools report pass/fail, not *why* a placement was made.
3. **No genuine cross-cycle learning** — soft-constraint weights are set once by an admin and rarely revisited with outcome data.

IntelliSched AI is scoped specifically to close these three gaps at a single-department scale, not to out-optimize existing constraint solvers on raw feasibility.

## 2. Objectives

**Primary**
- **I.** Multi-agent AI framework (Scheduling, Faculty, Section, Room/Resource, Conflict Detection, Optimisation, Learning agents) for conflict-free timetable generation.
- **II.** Digital twin of the academic environment supporting what-if simulation of disruptions without touching the approved baseline.

**Secondary**
- **III.** Self-learning component that adjusts soft-constraint weights cycle-over-cycle from historical performance + feedback.
- **IV.** Role-based web dashboard (Administrator / Faculty / Student) with near-real-time updates.

## 3. Scope

**In scope:** weekly timetable generation (theory + lab) across multiple sections/departments, hard/soft constraint modelling, digital-twin what-if simulation, dashboard with manual override, feedback-driven weight learning between cycles.

**Out of scope (prototype):** examination timetabling, hostel/transport scheduling, live biometric/ERP integration (architecture allows it later), fully autonomous unsupervised operation — **an administrator always approves the final timetable.**

## 4. Constraints

**Hard constraints (must never be violated):**
1. No faculty double-booked in a time slot.
2. No room/lab double-booked in a time slot.
3. No section has two classes at once.
4. Room capacity ≥ section strength.
5. Faculty must be available (not on declared leave).
6. Lab sessions must go to a room of the correct type/equipment.

**Soft constraints (optimised, weighted):**
Faculty time-slot/workload preferences · balanced faculty workload · minimised student idle gaps · even room/lab utilisation · avoidance of excessive consecutive sessions · preference for commonly favoured hours.

## 5. Research Gaps Identified (vs. FET, UniTime, aSc TimeTables, Ad Astra, CollegeNET 25Live)

| # | Gap | Evidence |
|---|-----|----------|
| 1 | Reactive, not proactive, conflict handling | Oude Vrielink et al. (2019) — institutions still resolve conflicts by iterative manual correction |
| 2 | No digital-twin what-if simulation | All 5 reviewed tools are single-working-copy or coarse whole-schedule re-solve at best |
| 3 | No genuine cycle-over-cycle self-learning | Chen et al. (2021) — soft-constraint weights configured once, rarely revisited |
| 4 | Black-box optimisation, no explainability | Tools report feasible/score only, not a human-readable reason |
| 5 | Single-solver architecture, not negotiated multi-agent allocation | Wooldridge (2009) — competing stakeholders are naturally modelled as negotiating agents |
| 6 | Shared-resource contention across departments weakly modelled | Manual coordination outside the tool today |
| 7 | India-specific department-level tooling gap | Commercial tools priced/sized for large US institutions; OSS tools are desktop-first or heavy to self-host |

**Comparison matrix (condensed):**

| Criterion | FET | UniTime | aSc | Ad Astra | **IntelliSched AI** |
|---|---|---|---|---|---|
| Core approach | Heuristic solver | CP solver | Proprietary | AI-assisted analytics + solver | Multi-agent CSP + metaheuristic |
| Digital twin / what-if | None | Limited re-solve | None | Coarse comparison | **Dedicated always-on twin** |
| Cross-cycle learning | None | None | None | Manual, analyst-driven | **Automated per-cycle weight update** |
| Explainable conflicts | Feasibility flag | Feasibility flag | Feasibility flag | Aggregate dashboard | **Typed reason + severity, per conflict** |
| Disruption speed | Manual re-run | Manual re-run | Manual re-run | Planner-driven re-solve | **Simulated on twin before commit** |
| Target scale | Any (manual) | Institution-wide | Schools | Large US universities | **Single department, web-based** |
| Cost | Free | Free (self-host) | Paid | Enterprise paid | Open-source stack |

**Differentiators:** (1) 7 negotiating agents instead of one monolithic solver, (2) a genuine queryable digital twin rather than a re-solve button, (3) typed/severity-ranked conflict output, (4) an auditable weight-adjustment trail per cycle, (5) department-scale/affordable deployment, (6) version-diff rescheduling (shows only what changed after a disruption).

## 6. SRS Summary

**Layers:** data/digital-twin (MongoDB + live snapshots) · agent-coordination (7 agents) · optimisation (CP solver + metaheuristic) · presentation (React dashboard).

**User classes:** Administrator (full control, override, approval), Faculty (availability/preferences, view own schedule), Student/Section (read-only view of approved timetable).

**Functional requirements (16, grouped):**

| Group | IDs | Summary |
|---|---|---|
| Scheduling & constraint enforcement | FR-01–FR-04 | Generate full timetable, reject hard-constraint violations, report unscheduled-session reasons, compute weighted soft-constraint score |
| Conflict detection | FR-05–FR-06 | Classify every violation by type + severity; support ≥10 named conflict types |
| Digital twin & what-if | FR-07–FR-09 | Live independent state snapshot; simulate disruption without touching baseline; propose a hard-constraint-safe reschedule |
| Self-learning / feedback | FR-10–FR-12 | Record stakeholder feedback per version; log weight/score history per cycle; feed updated weights into next cycle's objective |
| Dashboard & interaction | FR-13–FR-16 | Role-based views; faculty preference submission; admin manual override; version-diff view |

**Non-functional requirements:** Performance (full schedule in minutes at prototype scale), Reliability (zero hard-constraint violations in any APPROVED timetable, automated integrity check), Usability (non-technical admin can review/simulate/approve), Scalability (up to ~150 courses / ~100 faculty without schema redesign), Maintainability (each agent independently testable behind a message contract), Security (role-restricted data access), Auditability (every override/weight change timestamped with previous value), Portability (Node.js + Python + MongoDB, OS-agnostic).

**Traceability:** every FR traces back to one of the four synopsis objectives (I→FR-01…06, II→FR-07…09, III→FR-10…12, IV→FR-13…16) — no requirement exists without a stated project goal.

## 7. Actual Dataset Profile (`timetable_dataset.xlsx`)

The dataset supplied in this project directory is **larger and structured differently** than the "small test dataset" quoted in the Synopsis/Comparative-Analysis reports (2 departments, 13 faculty, 18 courses, 7 sections, 10 rooms, 35 slots). It is effectively a **full-institute master-data catalog**:

| Sheet | Rows (excl. header) | Notes |
|---|---|---|
| `Branches` | 4 | CSE, IT, ECE, EEE — all B.Tech, 4 years, 2 semesters/year |
| `Sections` | 96 | 4 branches × 8 semesters × 3 sections (A/B/C), strength 60 each |
| `Subjects` | 160 | 128 Theory (4 credits/4 weekly hrs typical) + 32 Lab (1 credit/2 weekly hrs) |
| `Teachers` | 24 | 6 per branch: even split of Assistant/Associate/Professor, `MaxWeeklyLoad` 18 |
| `TeacherSubjectMap` | 480 | Pre-assigned (teacher, subject, section) offerings — i.e. WHO teaches WHAT to WHOM is already fixed; the system's job is WHEN/WHERE |
| `Rooms` | 18 | 12 Classrooms (cap. 60, Main Block) + 6 Labs (cap. 30, Lab Block) |
| `TimeSlots` | 36 | Mon–Sat × 6 periods/day |

**Key finding — the catalog is not directly schedulable as one block.** Total weekly session-hours implied by `TeacherSubjectMap` × `Subjects.WeeklyHours` = **1,728 hours**, but total room-slot capacity is only 18 rooms × 36 slots = **648 room-hours/week** — a ~2.7× oversubscription. This confirms the dataset represents *all 8 semesters of all 4 branches at once* (a full academic-year catalog), not one live scheduling cycle. In any real term, only the semesters currently in session per year (typically half of the 8, i.e. ~48 of the 96 sections) run concurrently, which still requires **scoping every scheduling run to an explicit "active term" subset** — see `ARCHITECTURE.md` §3 and §7 for how the data-ingestion layer handles this.

**Gaps vs. what the SRS data model (§4.4) requires, not present in this file** — the system must generate/collect these itself, they are not part of the static import:
- Faculty availability / leave records (HC-5 needs this at runtime)
- Faculty time-slot preferences (soft constraint input)
- Lab equipment requirements (dataset only has `RoomType: Classroom|Lab`, no equipment list — HC-6 is approximated as a room-*type* match, not equipment match, until richer data is provided)
- Timetable versions / approval history
- Disruption scenarios & rescheduling records
- Historical scheduling cycles + stakeholder feedback
- Learning/weight-adjustment log

These become live-generated MongoDB collections in the running system rather than seed data (see `ARCHITECTURE.md` §6).

## 8. References

- M. Wooldridge, *An Introduction to MultiAgent Systems*, 2nd ed., Wiley, 2009.
- Oude Vrielink, R.A. et al. (2019). Practices in timetabling in higher education institutions: A systematic review. *Annals of Operations Research*, 275, 145–160.
- Chen, M.C. et al. (2021). A Survey of University Course Timetabling Problem. *IEEE Access*, 9, 106515–106529.
- IEEE Std 830-1998, IEEE Recommended Practice for SRS.
- Google OR-Tools documentation, developers.google.com/optimization.
- FET (lalescu.ro/liviu/fet), UniTime (unitime.org), aSc TimeTables (asctimetables.com), Ad Astra (aais.com).
