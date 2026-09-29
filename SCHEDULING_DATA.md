# IntelliSched AI — Data Tables for a High-Quality Timetable

This document lists every data table the generator needs to produce a **best** timetable. That means one that is not just clash-free, but also fair to teachers, easy on students, and physically possible to follow, including the time a teacher needs to **walk from one building to another** between classes.

Tables are grouped by status:

- **✅ Exists**: already in the app (`backend/src/schema.js`) and in `timetable_dataset.xlsx`.
- **✅ Added**: now built into the app (not in the original dataset file).
- **🟡 Extend**: exists, but needs extra columns.
- **🆕 New**: not built yet.

Each table is marked **Must** (the timetable can be wrong without it), **Should** (quality drops without it) or **Nice** (polish).

---

## 1. Summary

| # | Table | Status | Priority | Why the scheduler needs it |
|---|---|---|---|---|
| 1 | Branches | ✅ | Must | Groups sections, subjects and teachers by department |
| 2 | Sections | 🟡 | Must | Who needs a timetable, and how many students |
| 3 | Subjects | 🟡 | Must | What is taught, how many hours, theory or lab |
| 4 | Teachers | ✅ + building columns added | Must | Who teaches, their weekly load limit and building-movement rules |
| 5 | TeacherPreferences | ✅ + `TimesTaught` added | Should | Which subjects each teacher wants (used by auto-assign, see §6) |
| 6 | TeacherSubjectMap (Teaching Assignments) | ✅ | Must | Final allotment: teacher × subject × section |
| 7 | Rooms | 🟡 | Must | Where classes can happen, with capacity and type |
| 8 | TimeSlots / General Settings | ✅ | Must | Days, periods, timings and breaks |
| 9 | **Buildings** | ✅ Added | Must* | The list of blocks and campuses |
| 10 | **BuildingTravel** (Travel Between Buildings) | ✅ Added | Must* | Walking minutes between each pair of buildings |
| 11 | **TeacherMobility** | ✅ Added as Teachers columns | Must* | Per-teacher movement rules between buildings |
| 12 | TeacherAvailability (Teacher Unavailability) | ✅ Added | Must | When a teacher cannot teach (leave, other duties) |
| 13 | TeacherTimePreferences | 🆕 | Should | Preferred and disliked periods |
| 14 | SectionBatches | 🆕 | Should | Splits a section into lab batches |
| 15 | CombinedClasses / ElectiveGroups | 🆕 | Should | One class shared by several sections |
| 16 | FixedSessions (Locks) | 🆕 | Should | Slots decided by hand before generation |
| 17 | RoomFeatures | 🆕 | Nice | Matches lab equipment to subject needs |
| 18 | SchedulingRules (Weights) | 🆕 | Nice | How important each soft rule is |

\* Must be present once the campus has **more than one building**. With a single building, the scheduler can skip tables 9–11.

---

## 2. Existing tables (and the columns to add)

### 2.1 Branches ✅
`BranchCode` (PK), `BranchName`, `Degree`, `TotalYears`, `SemestersPerYear`. No changes needed.

### 2.2 Sections 🟡
Existing: `SectionID` (PK, derived), `BranchCode`, `Year`, `Semester`, `Section`, `Strength`.

| New column | Type | Example | Purpose |
|---|---|---|---|
| `HomeBuilding` | ref → Buildings | `A` | Where the section's classes should mainly be. Keeps **students** from walking all day too. |
| `HomeRoom` | ref → Rooms (optional) | `A101` | A fixed classroom for theory, if the college uses one |

### 2.3 Subjects 🟡
Existing: `SubjectCode`, `BranchCode`, `Year`, `Semester`, `SubjectName`, `Type`, `Credits`, `WeeklyHours`.

| New column | Type | Example | Purpose |
|---|---|---|---|
| `SessionLength` | number (periods) | `2` | Length of one sitting. Today labs are fixed at 2 periods in code. |
| `MaxPerDay` | number | `1` | Stops the same subject from appearing 3 times in one day |
| `RequiredFeatures` | text list | `GPU, Projector` | Matched against RoomFeatures |
| `PreferredBuilding` | ref → Buildings (optional) | `LAB` | For example, all Chemistry labs are in the Science block |

### 2.4 Teachers ✅
`TeacherID` (TT/TL + 4 digits), `TeacherType`, `Name`, `BranchCode`, `Designation`, `MaxWeeklyLoad`, plus the optional building columns `HomeBuilding`, `MaxBuildingChanges` and `ExtraTravelMinutes` (see §3.3).

### 2.5 TeacherPreferences ✅
`TeacherID`, `SubjectCode`, `Priority` (1–5, **at most 2 subjects at priority 1 per teacher**), `ExperienceYears`, `TimesTaught`, `ResearchPapers`, `Remarks`. Used when *allotting* subjects, not when placing them in the week. See §6 for how they are ranked.

### 2.6 TeacherSubjectMap ✅
`TeacherID`, `SubjectCode`, `SectionID` (+ derived `BranchCode`, `Year`, `Semester`, `Section`). This is the list of sessions the generator must place.

### 2.7 Rooms 🟡
Existing: `RoomID` (e.g. `A101` = block A, floor 1, room 01), `RoomType`, `Capacity`, `Building` (Block), `Floor`, `RoomNo`.

| Change | Purpose |
|---|---|
| `Building` becomes a **ref → Buildings** instead of free text | Lets travel time be looked up. `A` and `a` and `Block A` must not be three different buildings. |
| `Accessible` (yes/no) | Lift or ground floor, for teachers or students with mobility needs |

### 2.8 TimeSlots / General Settings ✅
`Day`, `Period`, `StartTime`, `EndTime`, plus the per-database settings (school days, periods per day, breaks, and which day × period cells are open). **Break lengths matter for travel**: a 15-minute break gives a teacher time to change buildings, while back-to-back periods may not.

---

## 3. New tables for moving between buildings

A teacher who has period 2 in Block A and period 3 in Block C needs enough time to get there. If there isn't enough, they arrive late and the class loses time. These three tables let the scheduler prevent that.

### 3.1 Buildings ✅ Added (Must, if there is more than one building)

| Column | Type | Required | Example | Notes |
|---|---|---|---|---|
| `BuildingCode` | text (PK) | ✔ | `A` | The same code used as the first letter of `RoomID` |
| `BuildingName` | text | ✔ | `Academic Block A` | |
| `Campus` | text | | `Main` | Buildings on different campuses usually need a long gap, or none at all on the same day |
| `Floors` | number | | `4` | |
| `HasLift` | yes/no | | `yes` | Used together with TeacherMobility.`NeedsAccessibleRoute` |

### 3.2 BuildingTravel ✅ Added (Must, if there is more than one building)

One row for each pair of buildings, and **one row covers both directions**. The same building is always 0 minutes, so there's no row for it. Built so far: `FromBuilding`, `ToBuilding`, `WalkMinutes`. The `Symmetric` and `AccessibleMinutes` columns below are still to come.

| Column | Type | Required | Example | Notes |
|---|---|---|---|---|
| `FromBuilding` | ref → Buildings | ✔ | `A` | |
| `ToBuilding` | ref → Buildings | ✔ | `C` | |
| `WalkMinutes` | number | ✔ | `8` | Realistic door-to-door time, including stairs |
| `Symmetric` | yes/no | | `yes` (default) | If yes, the scheduler also uses this value for C → A |
| `AccessibleMinutes` | number | | `12` | Time by the step-free route (lifts, ramps), if that's longer |

Example data:

| FromBuilding | ToBuilding | WalkMinutes | AccessibleMinutes |
|---|---|---|---|
| A | B | 3 | 5 |
| A | C | 8 | 12 |
| B | C | 6 | 9 |
| A | LAB | 10 | 10 |

**How a missing pair is handled (as built):** it counts as 0 minutes, so the generator never fails because data is incomplete. The Overview page lists every missing pair under *Data readiness*, and the Timetable page names each missing pair the teachers actually had to cross.

### 3.3 TeacherMobility ✅ Added as Teachers columns (Must, if there is more than one building)

Built as optional columns on the Teachers form: `HomeBuilding`, `MaxBuildingChanges` (blank means no limit, 0 means one block all day) and `ExtraTravelMinutes`. `NeedsAccessibleRoute`, `MinBufferMinutes` and the college-wide defaults below are still to come.

| Column | Type | Default | Example | Meaning |
|---|---|---|---|---|
| `TeacherID` | ref → Teachers (PK) | | `TT0004` | |
| `HomeBuilding` | ref → Buildings | Branch's usual block | `A` | Where their cabin or staff room is. Classes there are preferred. |
| `CanChangeBuildings` | yes/no | `yes` | `no` | **No** means all of this teacher's classes on a given day must be in one building |
| `MaxBuildingChangesPerDay` | number | `2` | `1` | Hard limit on how many times they switch buildings in a day |
| `ExtraTravelMinutes` | number | `0` | `5` | Added to every WalkMinutes, for teachers who walk slowly or carry lab equipment |
| `NeedsAccessibleRoute` | yes/no | `no` | `yes` | Use `AccessibleMinutes`, and only allow rooms where `Accessible = yes` |
| `MinBufferMinutes` | number | `0` | `5` | Extra settling-in time wanted before a class in a new building |

**College-wide defaults** (new fields in General Settings):
- `DefaultMaxBuildingChangesPerDay` = 2
- `AllowBackToBackBuildingChange` = no. If no, a building change always needs a real gap between the classes.

---

## 4. Other new tables

### 4.1 TeacherAvailability ✅ Added (Must)
Built as **Teacher Unavailability**: each row is a slot the teacher *cannot* teach. `TeacherID`, `Day`, `Period` (blank means the whole day), `Reason` (`Leave`, `Admin duty`, `Exam duty`, `Other campus`). This is hard constraint **HC5** in `ARCHITECTURE.md` §7. It is not in the dataset today.

### 4.2 TeacherTimePreferences 🆕 (Should)
`TeacherID`, `Day`, `Period`, `Score` (−2 avoid … +2 prefer). Example: "no first period on Mondays", "prefer mornings".

### 4.3 SectionBatches 🆕 (Should)
`SectionID`, `Batch` (`B1`, `B2`), `Strength`. Lets a 60-student section use two 30-seat labs at the same time, or the same lab one after the other, instead of the current "labs assume batches" shortcut.

### 4.4 CombinedClasses / ElectiveGroups 🆕 (Should)
`GroupID`, `SubjectCode`, `TeacherID`, `SectionIDs` (list). All listed sections must be free in the same period, and the room must seat their combined strength.

### 4.5 FixedSessions 🆕 (Should)
`SectionID`, `SubjectCode`, `TeacherID`, `Day`, `Period`, `RoomID`, `Locked` (yes/no). Placed first. The generator builds the rest of the timetable around them (seminars, sports, library hours, visiting faculty).

### 4.6 RoomFeatures 🆕 (Nice)
`RoomID`, `Feature` (`Projector`, `GPU`, `Chemistry benches`, `Smart board`). Must match Subjects.`RequiredFeatures` (hard constraint HC6, refined).

### 4.7 SchedulingRules 🆕 (Nice)
`RuleName`, `Weight`, `UpdatedAt`, `PreviousWeight`. These are the soft-rule weights from `ARCHITECTURE.md` §7, saved so the admin can tune them and every change is logged.

---

## 5. How the scheduler uses the building tables

### 5.1 New hard constraint: **HC7 travel-feasible**

For every teacher, day, and pair of **consecutive classes** *X → Y* in that day:

```
if building(X.room) ≠ building(Y.room):
    gap     = start(Y) − end(X)                  // minutes, from TimeSlots (includes breaks)
    travel  = WalkMinutes(bX, bY)                // or AccessibleMinutes if NeedsAccessibleRoute
              + ExtraTravelMinutes(teacher)
              + MinBufferMinutes(teacher)
    reject if  gap < travel
    reject if  CanChangeBuildings = no
    reject if  building changes today > MaxBuildingChangesPerDay
    reject if  no travel row exists for (bX, bY)
```

Classes that are not consecutive (a free period in between) are checked the same way. The gap is just longer, so they almost always pass.

**Worked example.** Periods are 50 minutes, with a 10-minute break after P2.

| Teacher TT0004 | Period | Time | Room | Result |
|---|---|---|---|---|
| Class X | P2 | 09:50–10:40 | A101 | |
| Class Y | P3 | 10:50–11:40 | C204 | gap 10 min, A→C = 8 min + 5 min buffer = 13 → **rejected** |
| Class Y | P3 | 10:50–11:40 | B105 | gap 10 min, A→B = 3 + 5 = 8 → ✅ allowed |

### 5.2 New soft goals (scored, not required)

| Goal | Score |
|---|---|
| Fewer building changes per teacher per day | −1 for each change |
| Teach in the teacher's `HomeBuilding` | +1 for each class there |
| Keep each section in its `HomeBuilding` | +1 for each class there (students walk less too) |
| Place labs in the subject's `PreferredBuilding` | +1 |

### 5.3 How it is built (`frontend/src/generator.js`)
- For each candidate slot, every free room that seats the section is tested with the travel rule. The generator adds the class to that teacher's classes for the day and checks each block change against the gap from the period timings (General Settings).
- Rooms are tried with the **fewest block changes first**, then rooms in the teacher's **home block**, then the smallest room.
- The score adds 4 for each block change and 1 for each class outside the home block. Among runs that place the same number of classes, the run with fewer block changes wins.
- If a class can't be placed only because of walking time, its *Not placed* reason says so.
- With no timings set, the generator assumes 50-minute periods with no breaks.

---

## 6. Ranking teachers for a subject (auto-assign, as built)

`frontend/src/assigner.js` orders everyone who asked for a subject by:

1. **Priority** (1 first). A teacher can have **at most 2 subjects at priority 1**; saving a third is refused.
2. **Score**, calculated as the fit score (0–100) minus 15 for each section of this subject the teacher already has:

   | Part of the fit score | Points | Scaling |
   |---|---|---|
   | Experience in the area | 40 | capped at 20 years |
   | Times taught this subject | 25 | capped at 5 |
   | Research papers in the area | 20 | log scale, capped at 50 |
   | Teacher is from the subject's branch | 15 | yes/no |

   The −15 per section already held makes teachers with similar scores **share** the sections. Before, the top-merit teacher took every section until they hit their max load.
3. **Lower share of max load used** (load ÷ max, not raw hours).
4. A fixed shuffle per subject as the last tie-break, instead of always favouring the lowest Teacher ID.

The ranking table and the auto-assign preview show *Fit*, *Sections held* and *Taught*, so the admin can see why each teacher was picked.

**Still worth collecting later:** specialisation/qualification, student feedback per subject, past pass rates, admin duties that reduce real load, and whether last term's preferences were met.

## 7. Minimum set to start with

If only a few tables can be added now, add them in this order:

1. ✅ **Buildings**. The Rooms form now offers these blocks, and the Overview page flags rooms whose block isn't listed.
2. ✅ **BuildingTravel**
3. ✅ **Teacher building rules** (`HomeBuilding`, `MaxBuildingChanges`, `ExtraTravelMinutes`)
4. ✅ **Teacher Unavailability**
5. 🆕 `Subjects.SessionLength` and **SectionBatches**: next up

With these five, the timetable is clash-free, respects walking time between buildings, respects leave, and handles labs properly. The remaining tables improve quality on top of that.
