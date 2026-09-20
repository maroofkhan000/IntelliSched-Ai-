// Teacher ranking + automatic teaching-assignment suggestions, driven by Teacher Preferences.
//
// A teacher's claim on a subject is ordered by:
//   1. Priority they gave it (1 = most wanted)
//   2. Merit = 2 x years of experience + published research papers (both from Teacher Preferences)
//   3. Lower current weekly load (keeps the work balanced)
// Only approved rows are used. Assignments already in the table are kept and their hours count
// against each teacher's max weekly load.

const approved = (rows = []) => rows.filter((r) => r._status === 'approved')
const num = (v) => Number(v) || 0

export const merit = (pref) => num(pref.ExperienceYears) * 2 + num(pref.ResearchPapers)

const subjectFor = (subjects, code, branch) => subjects.find((s) => s.SubjectCode === code && s.BranchCode === branch) ?? subjects.find((s) => s.SubjectCode === code)

// hours already assigned to each teacher
export function teacherLoads(db) {
  const subjects = approved(db.Subjects)
  const loads = new Map()
  for (const m of approved(db.TeacherSubjectMap)) {
    const sub = subjectFor(subjects, m.SubjectCode, m.BranchCode)
    loads.set(m.TeacherID, (loads.get(m.TeacherID) ?? 0) + num(sub?.WeeklyHours))
  }
  return loads
}

const byClaim = (a, b) => (a.priority - b.priority) || (b.merit - a.merit) || (a.load - b.load) || String(a.teacher.TeacherID).localeCompare(String(b.teacher.TeacherID))

// Everyone who listed `subjectCode` in Preferences, best claim first.
export function rankTeachers(db, subjectCode, loads = teacherLoads(db)) {
  const teachers = new Map(approved(db.Teachers).map((t) => [t.TeacherID, t]))
  const out = []
  for (const p of approved(db.TeacherPreferences)) {
    if (p.SubjectCode !== subjectCode) continue
    const teacher = teachers.get(p.TeacherID)
    if (!teacher) continue
    out.push({ teacher, priority: num(p.Priority) || 9, years: num(p.ExperienceYears), papers: num(p.ResearchPapers), merit: merit(p), load: loads.get(teacher.TeacherID) ?? 0, max: num(teacher.MaxWeeklyLoad) })
  }
  return out.sort(byClaim)
}

// Propose a teacher for every section + subject that has no assignment yet.
export function suggestAssignments({ db, scope = {}, fallback = false }) {
  const sections = approved(db.Sections).filter((s) => {
    if (scope.branch && s.BranchCode !== scope.branch) return false
    if (scope.term === 'odd') return num(s.Semester) % 2 === 1
    if (scope.term === 'even') return num(s.Semester) % 2 === 0
    return true
  })
  const subjects = approved(db.Subjects)
  const teachers = approved(db.Teachers)
  const done = new Set(approved(db.TeacherSubjectMap).map((m) => `${m.SectionID}|${m.SubjectCode}`))
  const loads = teacherLoads(db)

  const jobs = []
  for (const sec of sections) {
    for (const sub of subjects.filter((x) => x.BranchCode === sec.BranchCode && num(x.Semester) === num(sec.Semester))) {
      if (done.has(`${sec.SectionID}|${sub.SubjectCode}`)) continue
      const wanted = rankTeachers(db, sub.SubjectCode, loads).filter((c) => !c.teacher.TeacherType || c.teacher.TeacherType === sub.Type)
      jobs.push({ sec, sub, hours: num(sub.WeeklyHours), wanted })
    }
  }
  // fewest interested teachers first, so scarce specialists aren't used up on easy subjects
  jobs.sort((a, b) => (a.wanted.length - b.wanted.length) || (b.hours - a.hours))

  const assignments = []
  const unassigned = []
  const record = (j, pick, note) => {
    loads.set(pick.teacher.TeacherID, (loads.get(pick.teacher.TeacherID) ?? 0) + j.hours)
    assignments.push({ SectionID: j.sec.SectionID, SubjectCode: j.sub.SubjectCode, SubjectName: j.sub.SubjectName, hours: j.hours, TeacherID: pick.teacher.TeacherID, TeacherName: pick.teacher.Name, priority: pick.priority, years: pick.years, papers: pick.papers, note })
  }

  // pass 1: honour preferences (this pass always finishes before any fallback is used)
  const left = []
  for (const j of jobs) {
    const live = j.wanted.map((c) => ({ ...c, load: loads.get(c.teacher.TeacherID) ?? 0 })).sort(byClaim)
      .filter((c) => c.load + j.hours <= num(c.teacher.MaxWeeklyLoad))
    if (live[0]) record(j, live[0], '')
    else left.push(j)
  }

  // pass 2: whatever is left goes to the least-loaded teacher of the branch, if allowed
  for (const j of left) {
    if (fallback) {
      const asked = new Set(j.wanted.map((c) => c.teacher.TeacherID))
      const free = teachers
        .filter((t) => !asked.has(t.TeacherID) && (!t.TeacherType || t.TeacherType === j.sub.Type) && t.BranchCode === j.sec.BranchCode && (loads.get(t.TeacherID) ?? 0) + j.hours <= num(t.MaxWeeklyLoad))
        .sort((x, y) => (loads.get(x.TeacherID) ?? 0) - (loads.get(y.TeacherID) ?? 0))
      if (free[0]) { record(j, { teacher: free[0], priority: null, years: 0, papers: 0 }, 'no preference — least-loaded teacher of the branch'); continue }
    }
    unassigned.push({ SectionID: j.sec.SectionID, SubjectCode: j.sub.SubjectCode, SubjectName: j.sub.SubjectName, hours: j.hours, reason: j.wanted.length ? 'Every teacher who wants this subject is at their max weekly load' : 'No teacher listed this subject in Preferences' })
  }
  assignments.sort((a, b) => a.SectionID.localeCompare(b.SectionID) || a.SubjectCode.localeCompare(b.SubjectCode))
  return { assignments, unassigned, considered: jobs.length }
}
