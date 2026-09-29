// Teacher ranking + automatic teaching-assignment suggestions, driven by Teacher Preferences.
//
// A teacher's claim on a subject is ordered by:
//   1. Priority they gave it (1 = most wanted; each teacher may have only a few priority-1 subjects)
//   2. Fit score 0-100 from Teacher Preferences, each part capped so no single number dominates:
//        40  experience in the area (capped at 20 years)
//        25  times taught this subject before (capped at 5)
//        20  research papers in the area (log scale, capped at 50)
//        15  teacher belongs to the subject's branch
//      minus SHARE_PENALTY for every section of this subject the teacher already has, so teachers
//      with similar scores split the sections instead of one taking them all
//   3. Lower share of their max weekly load used (load / max, not raw hours)
//   4. A fixed per-subject shuffle, so the last tie-break doesn't always favour the same IDs
// Only approved rows are used. Assignments already in the table are kept and their hours count
// against each teacher's max weekly load.

const approved = (rows = []) => rows.filter((r) => r._status === 'approved')
const num = (v) => Number(v) || 0

export const SHARE_PENALTY = 15

export function fitScore(pref, teacher, subjectBranch) {
  const years = Math.min(num(pref.ExperienceYears), 20) / 20
  const taught = Math.min(num(pref.TimesTaught), 5) / 5
  const papers = Math.log1p(Math.min(num(pref.ResearchPapers), 50)) / Math.log1p(50)
  const home = subjectBranch && teacher.BranchCode === subjectBranch ? 1 : 0
  return Math.round(40 * years + 25 * taught + 20 * papers + 15 * home)
}

// stable pseudo-random order per subject (FNV-1a hash), used only as the very last tie-break
const shuffleKey = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0 }

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

// how many sections of each subject each teacher already teaches: Map("TeacherID|SubjectCode" -> n)
export function sectionCounts(db) {
  const out = new Map()
  for (const m of approved(db.TeacherSubjectMap)) out.set(`${m.TeacherID}|${m.SubjectCode}`, (out.get(`${m.TeacherID}|${m.SubjectCode}`) ?? 0) + 1)
  return out
}

const share = (c) => (c.max ? c.load / c.max : 1)
const byClaim = (a, b) => (a.priority - b.priority) || (b.score - a.score) || (share(a) - share(b)) || (a.tie - b.tie)

// Everyone who listed `subjectCode` in Preferences, best claim first.
export function rankTeachers(db, subjectCode, loads = teacherLoads(db), counts = sectionCounts(db)) {
  const teachers = new Map(approved(db.Teachers).map((t) => [t.TeacherID, t]))
  const subjectBranch = approved(db.Subjects).find((s) => s.SubjectCode === subjectCode)?.BranchCode
  const out = []
  for (const p of approved(db.TeacherPreferences)) {
    if (p.SubjectCode !== subjectCode) continue
    const teacher = teachers.get(p.TeacherID)
    if (!teacher) continue
    const fit = fitScore(p, teacher, subjectBranch)
    const held = counts.get(`${teacher.TeacherID}|${subjectCode}`) ?? 0
    out.push({
      teacher, priority: num(p.Priority) || 9, years: num(p.ExperienceYears), taught: num(p.TimesTaught), papers: num(p.ResearchPapers),
      fit, held, score: fit - SHARE_PENALTY * held, load: loads.get(teacher.TeacherID) ?? 0, max: num(teacher.MaxWeeklyLoad),
      tie: shuffleKey(`${subjectCode}|${teacher.TeacherID}`),
    })
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
  const counts = sectionCounts(db)

  const jobs = []
  for (const sec of sections) {
    for (const sub of subjects.filter((x) => x.BranchCode === sec.BranchCode && num(x.Semester) === num(sec.Semester))) {
      if (done.has(`${sec.SectionID}|${sub.SubjectCode}`)) continue
      const wanted = rankTeachers(db, sub.SubjectCode, loads, counts).filter((c) => !c.teacher.TeacherType || c.teacher.TeacherType === sub.Type)
      jobs.push({ sec, sub, hours: num(sub.WeeklyHours), wanted })
    }
  }
  // fewest interested teachers first, so scarce specialists aren't used up on easy subjects
  jobs.sort((a, b) => (a.wanted.length - b.wanted.length) || (b.hours - a.hours))

  const assignments = []
  const unassigned = []
  const record = (j, pick, note) => {
    loads.set(pick.teacher.TeacherID, (loads.get(pick.teacher.TeacherID) ?? 0) + j.hours)
    const k = `${pick.teacher.TeacherID}|${j.sub.SubjectCode}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
    assignments.push({ SectionID: j.sec.SectionID, SubjectCode: j.sub.SubjectCode, SubjectName: j.sub.SubjectName, hours: j.hours, TeacherID: pick.teacher.TeacherID, TeacherName: pick.teacher.Name, priority: pick.priority, years: pick.years, taught: pick.taught, papers: pick.papers, fit: pick.fit, note })
  }

  // pass 1: honour preferences (this pass always finishes before any fallback is used)
  const left = []
  for (const j of jobs) {
    const live = j.wanted.map((c) => {
      const held = counts.get(`${c.teacher.TeacherID}|${j.sub.SubjectCode}`) ?? 0
      return { ...c, load: loads.get(c.teacher.TeacherID) ?? 0, held, score: c.fit - SHARE_PENALTY * held }
    }).sort(byClaim)
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
      if (free[0]) { record(j, { teacher: free[0], priority: null, years: 0, taught: 0, papers: 0, fit: null }, 'no preference — least-loaded teacher of the branch'); continue }
    }
    unassigned.push({ SectionID: j.sec.SectionID, SubjectCode: j.sub.SubjectCode, SubjectName: j.sub.SubjectName, hours: j.hours, reason: j.wanted.length ? 'Every teacher who wants this subject is at their max weekly load' : 'No teacher listed this subject in Preferences' })
  }
  assignments.sort((a, b) => a.SectionID.localeCompare(b.SectionID) || a.SubjectCode.localeCompare(b.SubjectCode))
  return { assignments, unassigned, considered: jobs.length }
}
