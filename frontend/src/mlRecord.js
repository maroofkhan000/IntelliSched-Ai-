// Numbers that describe one timetable problem, sent with every generated timetable so the
// backend can log it as a training record for the ML pipeline (ml/: `python -m intellisched pull`).
// Same idea as instance_features() in ml/intellisched/pipeline.py: sizes, how full the rooms and
// teachers are, and how much of the input is missing. Approved rows only, limited to the scope.

const approved = (rows = []) => rows.filter((r) => r._status === 'approved')
const num = (v) => Number(v) || 0
const r3 = (x) => Math.round(x * 1000) / 1000

export function problemFeatures(db, settings, scope = {}) {
  const sections = approved(db.Sections).filter((s) => {
    if (scope.branch && s.BranchCode !== scope.branch) return false
    if (scope.term === 'odd') return num(s.Semester) % 2 === 1
    if (scope.term === 'even') return num(s.Semester) % 2 === 0
    return true
  })
  const subjects = approved(db.Subjects)
  const teachers = approved(db.Teachers)
  const rooms = approved(db.Rooms)
  const classrooms = rooms.filter((r) => r.RoomType === 'Classroom')
  const labs = rooms.filter((r) => r.RoomType === 'Lab')
  const assigned = new Set(approved(db.TeacherSubjectMap).map((m) => `${m.SectionID}|${m.SubjectCode}`))
  const openCells = Object.values(settings.avail ?? {}).filter((v) => v === 'on').length

  let theoryHours = 0, labHours = 0, pairs = 0, pairsAssigned = 0
  for (const sec of sections) {
    for (const sub of subjects.filter((x) => x.BranchCode === sec.BranchCode && num(x.Semester) === num(sec.Semester))) {
      pairs++
      if (assigned.has(`${sec.SectionID}|${sub.SubjectCode}`)) pairsAssigned++
      if (sub.Type === 'Lab') labHours += num(sub.WeeklyHours) + (num(sub.WeeklyHours) % 2)
      else theoryHours += num(sub.WeeklyHours)
    }
  }
  const capacity = teachers.reduce((n, t) => n + num(t.MaxWeeklyLoad), 0)
  const strengths = sections.map((s) => num(s.Strength))
  return {
    sections: sections.length, branches: new Set(sections.map((s) => s.BranchCode)).size, subjects_in_scope: pairs ? new Set(subjects.filter((x) => sections.some((s) => s.BranchCode === x.BranchCode && num(s.Semester) === num(x.Semester))).map((x) => `${x.BranchCode}|${x.SubjectCode}`)).size : 0,
    pairs, pairs_assigned: pairsAssigned, teachers: teachers.length, classrooms: classrooms.length, labs: labs.length,
    buildings: approved(db.Buildings).length, days: (settings.schoolDays ?? []).length, periods_per_day: num(settings.periodsPerDay), open_cells: openCells,
    theory_hours: theoryHours, lab_hours: labHours,
    classroom_util: r3(theoryHours / Math.max(1, openCells * classrooms.length)), lab_util: r3(labHours / Math.max(1, openCells * labs.length)),
    teacher_util: r3((theoryHours + labHours) / Math.max(1, capacity)),
    unavailable_rows: approved(db.TeacherAvailability).length, preferences: approved(db.TeacherPreferences).length,
    strength_mean: strengths.length ? r3(strengths.reduce((a, b) => a + b, 0) / strengths.length) : 0, strength_max: Math.max(0, ...strengths),
    largest_classroom: Math.max(0, ...classrooms.map((r) => num(r.Capacity))),
    walk_pairs: approved(db.BuildingTravel).length,
  }
}
