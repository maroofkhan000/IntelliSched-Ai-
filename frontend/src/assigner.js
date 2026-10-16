// Teacher ranking + automatic teaching-assignment suggestions, driven by Teacher Preferences.
//
// A teacher's claim on a subject is ordered by:
//   1. Priority they gave it (1 = most wanted; each teacher may have only a few priority-1 subjects)
//   2. More years of experience in the subject
//   and when those are equal:
//   3. Fewer sections of this subject already held, so equals split the sections instead of one taking them all
//   4. Teacher belongs to the subject's branch
//   5. Lower share of their max weekly load used (load / max, not raw hours)
//   6. A fixed per-subject shuffle, so the last tie-break doesn't always favour the same IDs
//   A teacher typed Theory or Lab takes subjects of that type first; when none is free, a teacher
//   of the other type who listed the subject covers it (noted on the suggestion).
// Only approved rows are used. Assignments already in the table are kept and their hours count
// against each teacher's max weekly load.

const approved = (rows = []) => rows.filter((r) => r._status === 'approved')
const num = (v) => Number(v) || 0

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
const byClaim = (a, b) => (a.priority - b.priority) || (b.years - a.years) || (a.held - b.held) || (b.sameBranch - a.sameBranch) || (share(a) - share(b)) || (a.tie - b.tie)

// Everyone who listed `subjectCode` in Preferences, best claim first.
export function rankTeachers(db, subjectCode, loads = teacherLoads(db), counts = sectionCounts(db)) {
  const teachers = new Map(approved(db.Teachers).map((t) => [t.TeacherID, t]))
  const subjectBranch = approved(db.Subjects).find((s) => s.SubjectCode === subjectCode)?.BranchCode
  const out = []
  for (const p of approved(db.TeacherPreferences)) {
    if (p.SubjectCode !== subjectCode) continue
    const teacher = teachers.get(p.TeacherID)
    if (!teacher) continue
    out.push({
      teacher, priority: num(p.Priority) || 9, years: num(p.ExperienceYears), sameBranch: subjectBranch && teacher.BranchCode === subjectBranch ? 1 : 0,
      held: counts.get(`${teacher.TeacherID}|${subjectCode}`) ?? 0, load: loads.get(teacher.TeacherID) ?? 0, max: num(teacher.MaxWeeklyLoad),
      tie: shuffleKey(`${subjectCode}|${teacher.TeacherID}`),
    })
  }
  return out.sort(byClaim)
}

// Why a pair got no teacher, in words the admin can act on.
function whyNot(j, fallback) {
  const type = j.sub.Type === 'Lab' ? 'lab' : 'theory'
  let why
  if (j.wanted.length) why = `Every ${type} teacher who listed it (${j.wanted.map((c) => c.teacher.TeacherID).join(', ')}) is at their max weekly load`
  else if (j.cover.length) why = `Every teacher who listed it (${j.cover.map((c) => c.teacher.TeacherID).join(', ')}) is at their max weekly load`
  else why = 'No teacher listed this subject in Preferences'
  return fallback ? `${why}, and ${j.sec.BranchCode} has no ${type} teacher with free hours` : why
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
      const listed = rankTeachers(db, sub.SubjectCode, loads, counts)
      const wanted = listed.filter((c) => !c.teacher.TeacherType || c.teacher.TeacherType === sub.Type)
      jobs.push({ sec, sub, hours: num(sub.WeeklyHours), wanted, cover: listed.filter((c) => !wanted.includes(c)) })
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
    assignments.push({ SectionID: j.sec.SectionID, SubjectCode: j.sub.SubjectCode, SubjectName: j.sub.SubjectName, hours: j.hours, TeacherID: pick.teacher.TeacherID, TeacherName: pick.teacher.Name, priority: pick.priority, years: pick.years, note })
  }

  // current load and sections held, best claim first, only teachers with room for these hours
  const available = (j, cands) => cands.map((c) => ({ ...c, load: loads.get(c.teacher.TeacherID) ?? 0, held: counts.get(`${c.teacher.TeacherID}|${j.sub.SubjectCode}`) ?? 0 }))
    .sort(byClaim).filter((c) => c.load + j.hours <= num(c.teacher.MaxWeeklyLoad))

  // pass 1: honour preferences with teachers of the subject's type (finishes before any fallback)
  let left = []
  for (const j of jobs) {
    const pick = available(j, j.wanted)[0]
    if (pick) record(j, pick, '')
    else left.push(j)
  }

  // pass 1b: no teacher of the right type is free, so a teacher of the other type who listed the
  // subject covers it (e.g. a theory teacher running a lab their branch has no lab teacher for)
  const stillLeft = []
  for (const j of left) {
    const pick = available(j, j.cover)[0]
    if (pick) record(j, pick, `${pick.teacher.TeacherType === 'Lab' ? 'lab' : 'theory'} teacher covering a ${j.sub.Type === 'Lab' ? 'lab' : 'theory'} subject`)
    else stillLeft.push(j)
  }
  left = stillLeft

  // pass 2: whatever is left goes to the least-loaded teacher of the branch, if allowed
  for (const j of left) {
    if (fallback) {
      const asked = new Set(j.wanted.map((c) => c.teacher.TeacherID))
      const free = teachers
        .filter((t) => !asked.has(t.TeacherID) && (!t.TeacherType || t.TeacherType === j.sub.Type) && t.BranchCode === j.sec.BranchCode && (loads.get(t.TeacherID) ?? 0) + j.hours <= num(t.MaxWeeklyLoad))
        .sort((x, y) => (loads.get(x.TeacherID) ?? 0) - (loads.get(y.TeacherID) ?? 0))
      if (free[0]) { record(j, { teacher: free[0], priority: null, years: 0 }, 'no preference — least-loaded teacher of the branch'); continue }
    }
    unassigned.push({ SectionID: j.sec.SectionID, SubjectCode: j.sub.SubjectCode, SubjectName: j.sub.SubjectName, hours: j.hours, reason: whyNot(j, fallback) })
  }
  assignments.sort((a, b) => a.SectionID.localeCompare(b.SectionID) || a.SubjectCode.localeCompare(b.SubjectCode))
  return { assignments, unassigned, considered: jobs.length }
}
