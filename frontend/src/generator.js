// Basic timetable generator.
//
// Inputs come from the database and General Settings:
//   settings  -> school days, periods per day, which day/period cells are open ("available"), breaks
//   sections  -> who needs a timetable (and how many students)
//   subjects  -> what each section studies (branch + semester) and weekly hours / theory or lab
//   teacher assignments -> who teaches which subject to which section
//   teachers  -> weekly load limit
//   rooms     -> classrooms for theory, labs for lab subjects (capacity checked)
//
// Hard rules: a section, teacher or room is never in two places in one period; only open
// cells are used; a teacher never exceeds their weekly load; lab sessions are 2 back-to-back
// periods on one day and never straddle a break.
// Soft rules (scored): spread a subject across days, keep each section's and teacher's day balanced.
// It is a greedy search restarted several times with random tie-breaks; the best run wins.
import { WEEK, breakAfter, effectiveTimings } from './schema'

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
    let small = 0

    const order = jobs.map((j) => ({ j, r: Math.random() })).sort((a, b) =>
      (b.j.lab - a.j.lab) || (b.j.len - a.j.len) || (teacherDemand.get(b.j.teacher.TeacherID) - teacherDemand.get(a.j.teacher.TeacherID)) || (jitter ? a.r - b.r : 0)).map((x) => x.j)

    for (const j of order) {
      const { sec, sub, teacher, len, lab, pool, strength } = j
      const load = get(`load|${teacher.TeacherID}`)
      if (load + len > Number(teacher.MaxWeeklyLoad)) { notPlaced.push({ ...j.base, periods: len, reason: `Teacher ${teacher.TeacherID} would exceed max weekly load (${teacher.MaxWeeklyLoad}h)` }); continue }
      let best = null
      for (const d of days) {
        for (let p = 1; p + len - 1 <= P; p++) {
          let ok = true
          for (let i = 0; i < len && ok; i++) {
            const q = p + i
            if (!isOpen(d, q) || secBusy.has(`${sec.SectionID}|${d}|${q}`) || teaBusy.has(`${teacher.TeacherID}|${d}|${q}`)) ok = false
            if (i > 0 && breakAfter(settings, q - 1)) ok = false // never run one session across a break
          }
          if (!ok) continue
          // a room free for every period of the session: smallest one that seats the section
          const free = pool.filter((r) => Array.from({ length: len }, (_, i) => !roomBusy.has(`${r.RoomID}|${d}|${p + i}`)).every(Boolean))
          let room = free.find((r) => Number(r.Capacity) >= strength)
          let undersized = false
          if (!room && lab && free.length) { room = free[free.length - 1]; undersized = true } // labs assume batches
          if (!room) continue
          const score = get(`sd|${sec.SectionID}|${sub.SubjectCode}|${d}`) * 10 + get(`s|${sec.SectionID}|${d}`) * 2 + get(`t|${teacher.TeacherID}|${d}`) + (jitter ? Math.random() * 3 : 0)
          if (!best || score < best.score) best = { d, p, room, score, undersized }
        }
      }
      if (!best) { notPlaced.push({ ...j.base, periods: len, reason: 'No free slot (clashes with other classes, or the teacher or rooms are fully booked)' }); continue }
      const { d, p, room, undersized } = best
      for (let i = 0; i < len; i++) {
        secBusy.add(`${sec.SectionID}|${d}|${p + i}`)
        teaBusy.add(`${teacher.TeacherID}|${d}|${p + i}`)
        roomBusy.add(`${room.RoomID}|${d}|${p + i}`)
        placed.push({ SectionID: sec.SectionID, Day: d, Period: p + i, SubjectCode: sub.SubjectCode, SubjectName: sub.SubjectName, Type: sub.Type, TeacherID: teacher.TeacherID, TeacherName: teacher.Name, RoomID: room.RoomID, ...(i > 0 ? { cont: true } : {}) })
      }
      if (undersized) small++
      bump(`sd|${sec.SectionID}|${sub.SubjectCode}|${d}`, len)
      bump(`s|${sec.SectionID}|${d}`, len)
      bump(`t|${teacher.TeacherID}|${d}`, len)
      bump(`load|${teacher.TeacherID}`, len)
    }
    return { placed, notPlaced, small }
  }

  let best = null
  for (let i = 0; i < tries; i++) {
    const r = run(i > 0)
    if (!best || r.placed.length > best.placed.length) best = r
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
    stats: { sections: sections.length, demand, scheduled: best.placed.length, unscheduled: notDone, undersizedLabs: best.small, timings: effectiveTimings(settings) },
  }
}
