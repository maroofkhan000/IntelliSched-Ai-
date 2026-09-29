// Basic timetable generator.
//
// Inputs come from the database and General Settings:
//   settings  -> school days, periods per day, which day/period cells are open ("available"), breaks
//   sections  -> who needs a timetable (and how many students)
//   subjects  -> what each section studies (branch + semester) and weekly hours / theory or lab
//   teacher assignments -> who teaches which subject to which section
//   teachers  -> weekly load limit
//   rooms     -> classrooms for theory, labs for lab subjects (capacity checked)
//   teacher unavailability -> slots (or whole days) a teacher cannot teach
//   buildings / travel     -> walking minutes between blocks (a room's block is its Building)
//
// Hard rules: a section, teacher or room is never in two places in one period; only open
// cells are used; a teacher never exceeds their weekly load or teaches when marked unavailable;
// lab sessions are 2 back-to-back periods on one day and never straddle a break; when a teacher's
// next class that day is in another block, the gap between the two classes must cover the walk
// (+ the teacher's extra travel minutes), and they never change blocks more than their daily max.
// Soft rules (scored): spread a subject across days, keep each section's and teacher's day balanced,
// keep a teacher in one block (and in their home block) as much as possible.
// It is a greedy search restarted several times with random tie-breaks; the best run wins.
import { WEEK, breakAfter, effectiveTimings, toMin } from './schema'

const approved = (rows = []) => rows.filter((r) => r._status === 'approved')

export const TERMS = { all: 'All semesters', odd: 'Odd semesters (1, 3, 5, 7)', even: 'Even semesters (2, 4, 6, 8)' }

export function generateTimetable({ db, settings, scope = {}, tries = 30 }) {
  const days = WEEK.filter((d) => settings.schoolDays.includes(d))
  const P = Number(settings.periodsPerDay) || 0
  const open = new Set(Object.entries(settings.avail).filter(([, v]) => v === 'on').map(([k]) => k))
  if (!days.length || !P || !days.some((d) => Array.from({ length: P }, (_, i) => open.has(`${d}|${i + 1}`)).some(Boolean))) {
    return { error: 'Set the school days, periods per day and mark available cells in General Settings first.' }
  }
  const isOpen = (d, p) => open.has(`${d}|${p}`)

  const sections = approved(db.Sections).filter((s) => {
    if (scope.branch && s.BranchCode !== scope.branch) return false
    if (scope.term === 'odd') return Number(s.Semester) % 2 === 1
    if (scope.term === 'even') return Number(s.Semester) % 2 === 0
    return true
  })
  const subjects = approved(db.Subjects)
  const teachers = new Map(approved(db.Teachers).map((t) => [t.TeacherID, t]))
  const rooms = approved(db.Rooms)
  const assignments = approved(db.TeacherSubjectMap)
  if (!sections.length) return { error: 'No approved sections match this scope.' }

  // ---- teacher unavailability: "TeacherID|Day|Period", or "TeacherID|Day|*" for the whole day ----
  const away = new Set(approved(db.TeacherAvailability).map((a) => `${a.TeacherID}|${a.Day}|${a.Period === '' || a.Period == null ? '*' : Number(a.Period)}`))
  const unavailable = (tid, d, p) => away.has(`${tid}|${d}|*`) || away.has(`${tid}|${d}|${p}`)

  // ---- moving between buildings ----
  const blockOf = (room) => String(room.Building ?? '').trim().toUpperCase()
  const walk = new Map()
  for (const t of approved(db.BuildingTravel)) {
    walk.set(`${t.FromBuilding}|${t.ToBuilding}`, Number(t.WalkMinutes) || 0)
    walk.set(`${t.ToBuilding}|${t.FromBuilding}`, Number(t.WalkMinutes) || 0)
  }
  const timings = effectiveTimings(settings)
  // minutes between the end of period a and the start of period b (b > a) on any day;
  // without timings, assume 50-minute periods with no breaks
  const gapMinutes = (a, b) => {
    const e = timings[a]?.end, st = timings[b]?.start
    return e && st ? toMin(st) - toMin(e) : (b - a - 1) * 50
  }
  const walkNeed = (teacher, x, y) => {
    if (x === y) return 0
    return (walk.get(`${x}|${y}`) ?? 0) + (Number(teacher.ExtraTravelMinutes) || 0)
  }
  const maxChanges = (teacher) => (teacher.MaxBuildingChanges === '' || teacher.MaxBuildingChanges == null ? Infinity : Number(teacher.MaxBuildingChanges))

  // ---- turn the syllabus into sessions to place ----
  const jobs = []
  const failed = [] // couldn't even be attempted
  let demand = 0
  for (const sec of sections) {
    const strength = Number(sec.Strength) || 0
    for (const sub of subjects.filter((x) => x.BranchCode === sec.BranchCode && Number(x.Semester) === Number(sec.Semester))) {
      const hours = Number(sub.WeeklyHours) || 0
      demand += hours
      const lab = sub.Type === 'Lab'
      const base = { SectionID: sec.SectionID, SubjectCode: sub.SubjectCode, SubjectName: sub.SubjectName, periods: hours }
      const assign = assignments.find((a) => a.SectionID === sec.SectionID && a.SubjectCode === sub.SubjectCode)
      const teacher = assign && teachers.get(assign.TeacherID)
      if (!teacher) { failed.push({ ...base, reason: 'No teacher assigned' }); continue }
      const pool = rooms.filter((r) => r.RoomType === (lab ? 'Lab' : 'Classroom')).sort((a, b) => Number(a.Capacity) - Number(b.Capacity))
      if (!pool.length) { failed.push({ ...base, reason: `No ${lab ? 'lab' : 'classroom'} rooms defined` }); continue }
      if (!lab && !pool.some((r) => Number(r.Capacity) >= strength)) { failed.push({ ...base, reason: `No classroom seats ${strength} students` }); continue }
      const lens = lab ? [...Array(Math.floor(hours / 2)).fill(2), ...(hours % 2 ? [1] : [])] : Array(hours).fill(1)
      for (const len of lens) jobs.push({ sec, sub, teacher, len, lab, pool, strength, base })
    }
  }
  const teacherDemand = new Map()
  for (const j of jobs) teacherDemand.set(j.teacher.TeacherID, (teacherDemand.get(j.teacher.TeacherID) ?? 0) + j.len)

  // ---- one greedy run ----
  const run = (jitter) => {
    const secBusy = new Set(), teaBusy = new Set(), roomBusy = new Set()
    const cnt = new Map()
    const bump = (k, n = 1) => cnt.set(k, (cnt.get(k) ?? 0) + n)
    const get = (k) => cnt.get(k) ?? 0
    const placed = [], notPlaced = []
    const dayPlan = new Map() // "TeacherID|Day" -> [{ from, to, block }] classes already placed that day
    let small = 0

    // would a class in `block` over periods p..q fit the teacher's walking between blocks that day?
    // returns the number of block changes that day if it fits, or -1 if it doesn't
    const travelCheck = (teacher, d, p, q, block) => {
      const seq = [...(dayPlan.get(`${teacher.TeacherID}|${d}`) ?? []), { from: p, to: q, block }].sort((a, b) => a.from - b.from)
      let changes = 0
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1], b = seq[i]
        if (a.block === b.block) continue
        changes++
        if (gapMinutes(a.to, b.from) < walkNeed(teacher, a.block, b.block)) return -1
      }
      return changes > maxChanges(teacher) ? -1 : changes
    }

    const order = jobs.map((j) => ({ j, r: Math.random() })).sort((a, b) =>
      (b.j.lab - a.j.lab) || (b.j.len - a.j.len) || (teacherDemand.get(b.j.teacher.TeacherID) - teacherDemand.get(a.j.teacher.TeacherID)) || (jitter ? a.r - b.r : 0)).map((x) => x.j)

    for (const j of order) {
      const { sec, sub, teacher, len, lab, pool, strength } = j
      const load = get(`load|${teacher.TeacherID}`)
      if (load + len > Number(teacher.MaxWeeklyLoad)) { notPlaced.push({ ...j.base, periods: len, reason: `Teacher ${teacher.TeacherID} would exceed max weekly load (${teacher.MaxWeeklyLoad}h)` }); continue }
      let best = null
      let walkBlocked = false
      const home = String(teacher.HomeBuilding ?? '').trim().toUpperCase()
      for (const d of days) {
        for (let p = 1; p + len - 1 <= P; p++) {
          let ok = true
          for (let i = 0; i < len && ok; i++) {
            const q = p + i
            if (!isOpen(d, q) || unavailable(teacher.TeacherID, d, q) || secBusy.has(`${sec.SectionID}|${d}|${q}`) || teaBusy.has(`${teacher.TeacherID}|${d}|${q}`)) ok = false
            if (i > 0 && breakAfter(settings, q - 1)) ok = false // never run one session across a break
          }
          if (!ok) continue
          // a room free for every period of the session that seats the section (labs may fall back
          // to the largest free lab: batches assumed) and that the teacher can walk to in time;
          // fewest block changes first, then the home block, then the smallest room
          const free = pool.filter((r) => Array.from({ length: len }, (_, i) => !roomBusy.has(`${r.RoomID}|${d}|${p + i}`)).every(Boolean))
          const fits = free.filter((r) => Number(r.Capacity) >= strength)
          const undersized = !fits.length && lab && free.length > 0
          const candidates = fits.length ? fits : undersized ? [free[free.length - 1]] : []
          if (!candidates.length) continue
          const byBlock = new Map()
          const options = []
          for (const r of candidates) {
            const b = blockOf(r)
            if (!byBlock.has(b)) byBlock.set(b, travelCheck(teacher, d, p, p + len - 1, b))
            const changes = byBlock.get(b)
            if (changes >= 0) options.push({ r, changes, away: home && b !== home ? 1 : 0 })
          }
          if (!options.length) { walkBlocked = true; continue }
          options.sort((a, b) => (a.changes - b.changes) || (a.away - b.away) || (Number(a.r.Capacity) - Number(b.r.Capacity)))
          const { r: room, changes, away: notHome } = options[0]
          const score = get(`sd|${sec.SectionID}|${sub.SubjectCode}|${d}`) * 10 + get(`s|${sec.SectionID}|${d}`) * 2 + get(`t|${teacher.TeacherID}|${d}`) + changes * 4 + notHome + (jitter ? Math.random() * 3 : 0)
          if (!best || score < best.score) best = { d, p, room, score, undersized }
        }
      }
      if (!best) {
        const reason = walkBlocked
          ? `No slot where teacher ${teacher.TeacherID} has time to walk between buildings (or they'd exceed their daily building changes)`
          : 'No free slot (clashes with other classes, the teacher is unavailable, or the teacher or rooms are fully booked)'
        notPlaced.push({ ...j.base, periods: len, reason })
        continue
      }
      const { d, p, room, undersized } = best
      for (let i = 0; i < len; i++) {
        secBusy.add(`${sec.SectionID}|${d}|${p + i}`)
        teaBusy.add(`${teacher.TeacherID}|${d}|${p + i}`)
        roomBusy.add(`${room.RoomID}|${d}|${p + i}`)
        placed.push({ SectionID: sec.SectionID, Day: d, Period: p + i, SubjectCode: sub.SubjectCode, SubjectName: sub.SubjectName, Type: sub.Type, TeacherID: teacher.TeacherID, TeacherName: teacher.Name, RoomID: room.RoomID, ...(i > 0 ? { cont: true } : {}) })
      }
      const plan = dayPlan.get(`${teacher.TeacherID}|${d}`) ?? []
      plan.push({ from: p, to: p + len - 1, block: blockOf(room) })
      dayPlan.set(`${teacher.TeacherID}|${d}`, plan)
      if (undersized) small++
      bump(`sd|${sec.SectionID}|${sub.SubjectCode}|${d}`, len)
      bump(`s|${sec.SectionID}|${d}`, len)
      bump(`t|${teacher.TeacherID}|${d}`, len)
      bump(`load|${teacher.TeacherID}`, len)
    }
    let blockChanges = 0
    const missingWalk = new Set() // block changes with no travel time entered (treated as 0 minutes)
    for (const plan of dayPlan.values()) {
      const seq = [...plan].sort((a, b) => a.from - b.from)
      for (let i = 1; i < seq.length; i++) {
        const x = seq[i - 1].block, y = seq[i].block
        if (x === y) continue
        blockChanges++
        if (walk.size && !walk.has(`${x}|${y}`)) missingWalk.add([x, y].sort().join(' ↔ '))
      }
    }
    return { placed, notPlaced, small, blockChanges, missingWalk: [...missingWalk].sort() }
  }

  let best = null
  for (let i = 0; i < tries; i++) {
    const r = run(i > 0)
    if (!best || r.placed.length > best.placed.length || (r.placed.length === best.placed.length && r.blockChanges < best.blockChanges)) best = r
    if (!best.notPlaced.length) break
  }

  // merge unscheduled items per section + subject + reason
  const merged = new Map()
  for (const u of [...failed, ...best.notPlaced]) {
    const k = `${u.SectionID}|${u.SubjectCode}|${u.reason}`
    merged.set(k, merged.has(k) ? { ...merged.get(k), periods: merged.get(k).periods + (best.notPlaced.includes(u) ? u.periods : 0) } : u)
  }
  const unscheduled = [...merged.values()]
  const notDone = unscheduled.reduce((n, u) => n + u.periods, 0)

  return {
    generatedAt: new Date().toISOString(),
    scope: { term: scope.term || 'all', branch: scope.branch || '' },
    entries: best.placed,
    unscheduled,
    stats: { sections: sections.length, demand, scheduled: best.placed.length, unscheduled: notDone, undersizedLabs: best.small, blockChanges: best.blockChanges, missingWalk: best.missingWalk, timings },
  }
}
