// Table definitions for the timetable database. Sheet names / column names match
// timetable_dataset.xlsx so import and export round-trip with the original file.
// Extra sheet "TeacherPreferences" holds the subject priorities teachers ask for.

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const WEEK = ['Sunday', ...DAYS]

// Per-database General Settings: which days run, how many periods, their timings,
// and each day/period cell's availability (`Day|Period` -> 'on' | 'off'). Starts empty:
// nothing is preselected, the admin or feeder chooses everything.
export const defaultSettings = () => ({ schoolDays: [], periodsPerDay: 0, timingMode: 'manual', timings: {}, auto: { start: '', duration: '', breaks: [] }, avail: {} })

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// Automatic timings: periods of `duration` minutes from `start`, with a break of
// `minutes` inserted after each period listed in `breaks` ({ after, minutes }).
// Returns { Period: { start, end } }; periods that would run past midnight are omitted.
export function autoTimings({ start, duration, breaks = [] }, periods) {
  const out = {}
  const len = Number(duration)
  if (!start || !len || len < 1) return out
  let t = toMin(start)
  for (let p = 1; p <= periods; p++) {
    if (t + len > 24 * 60) break
    out[p] = { start: toHHMM(t), end: toHHMM(t + len) }
    t += len + breaks.filter((b) => Number(b.after) === p).reduce((n, b) => n + (Number(b.minutes) || 0), 0)
  }
  return out
}

export const effectiveTimings = (s) => (s.timingMode === 'auto' ? autoTimings(s.auto, s.periodsPerDay) : s.timings)

const yearOf = (sem) => Math.ceil(Number(sem) / 2)

// Teacher IDs are generated: TT0001, TT0002... for theory teachers, TL0001... for lab teachers.
export const TEACHER_PREFIX = { Theory: 'TT', Lab: 'TL' }
export function nextTeacherId(teachers, type) {
  const prefix = TEACHER_PREFIX[type]
  if (!prefix) return ''
  const re = new RegExp(`^${prefix}(\\d{4})$`)
  const max = teachers.reduce((m, t) => Math.max(m, Number(re.exec(String(t.TeacherID))?.[1] ?? 0)), 0)
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

// Column kinds: text | number | select | ref (dropdown from another table's key)
export const TABLES = {
  Branches: {
    label: 'Branches',
    icon: '🏛️',
    hint: 'Departments / programmes offered',
    key: ['BranchCode'],
    adminOnly: true,
    columns: [
      { key: 'BranchCode', label: 'Branch Code', required: true, upper: true },
      { key: 'BranchName', label: 'Branch Name', required: true },
      { key: 'Degree', label: 'Degree', type: 'select', options: ['B.Tech', 'M.Tech', 'BCA', 'MCA', 'MBA'], required: true },
      { key: 'TotalYears', label: 'Total Years', type: 'number', min: 1, max: 6, required: true },
      { key: 'SemestersPerYear', label: 'Sem / Year', type: 'number', min: 1, max: 4, required: true },
    ],
    defaults: { Degree: 'B.Tech', TotalYears: 4, SemestersPerYear: 2 },
  },

  Sections: {
    label: 'Sections',
    icon: '👥',
    hint: 'Class groups and their student strength',
    key: ['SectionID'],
    filterBy: 'BranchCode',
    columns: [
      { key: 'SectionID', label: 'Section ID', auto: true },
      { key: 'BranchCode', label: 'Branch', type: 'ref', ref: 'Branches', refKey: 'BranchCode', required: true },
      { key: 'Year', label: 'Year', auto: true, type: 'number' },
      { key: 'Semester', label: 'Semester', type: 'number', min: 1, max: 12, required: true },
      { key: 'Section', label: 'Section', required: true, upper: true },
      { key: 'Strength', label: 'Students', type: 'number', min: 1, max: 300, required: true },
    ],
    defaults: { Strength: 60 },
    derive: (r) => ({
      Year: r.Semester ? yearOf(r.Semester) : '',
      SectionID: r.BranchCode && r.Semester && r.Section ? `${r.BranchCode}-Y${yearOf(r.Semester)}S${r.Semester}-${r.Section}` : '',
    }),
  },

  Subjects: {
    label: 'Subjects',
    icon: '📚',
    hint: 'Course catalog: type, credits and weekly teaching hours',
    key: ['BranchCode', 'SubjectCode'],
    filterBy: 'BranchCode',
    columns: [
      { key: 'SubjectCode', label: 'Subject Code', required: true, upper: true },
      { key: 'BranchCode', label: 'Branch', type: 'ref', ref: 'Branches', refKey: 'BranchCode', required: true },
      { key: 'Year', label: 'Year', auto: true, type: 'number' },
      { key: 'Semester', label: 'Semester', type: 'number', min: 1, max: 12, required: true },
      { key: 'SubjectName', label: 'Subject Name', required: true },
      { key: 'Type', label: 'Type', type: 'select', options: ['Theory', 'Lab'], required: true },
      { key: 'Credits', label: 'Credits', type: 'number', min: 0, max: 10, required: true },
      { key: 'WeeklyHours', label: 'Weekly Hours', type: 'number', min: 1, max: 12, required: true },
    ],
    defaults: { Type: 'Theory', Credits: 4, WeeklyHours: 4 },
    derive: (r) => ({ Year: r.Semester ? yearOf(r.Semester) : (r.Year ?? '') }),
  },

  Teachers: {
    label: 'Teachers',
    icon: '🧑‍🏫',
    hint: 'Faculty and their maximum weekly teaching load',
    key: ['TeacherID'],
    filterBy: 'BranchCode',
    columns: [
      { key: 'TeacherID', label: 'Teacher ID', auto: true, generated: true },
      { key: 'TeacherType', label: 'Teacher Type', type: 'select', options: ['Theory', 'Lab'], required: true, lockOnEdit: true },
      { key: 'Name', label: 'Name', required: true },
      { key: 'BranchCode', label: 'Branch', type: 'ref', ref: 'Branches', refKey: 'BranchCode', required: true },
      { key: 'Designation', label: 'Designation', type: 'select', options: ['Professor', 'Associate Professor', 'Assistant Professor', 'Lecturer', 'Visiting Faculty'], required: true },
      { key: 'MaxWeeklyLoad', label: 'Max Weekly Load (hrs)', type: 'number', min: 1, max: 40, required: true },
    ],
    defaults: { Designation: 'Assistant Professor', MaxWeeklyLoad: 18 },
    // a new teacher gets the next free ID for their type; existing IDs never change
    derive: (r, db) => (r.TeacherID || !r.TeacherType ? {} : { TeacherID: nextTeacherId(db.Teachers || [], r.TeacherType) }),
  },

  TeacherPreferences: {
    label: 'Teacher Preferences',
    icon: '⭐',
    hint: 'Which subjects each teacher wants to teach, ranked by priority (1 = most wanted), with their experience and published papers in that area. Auto-assign uses all of these.',
    key: ['TeacherID', 'SubjectCode'],
    filterBy: 'TeacherID',
    columns: [
      { key: 'TeacherID', label: 'Teacher', type: 'ref', ref: 'Teachers', refKey: 'TeacherID', refLabel: 'Name', required: true },
      { key: 'SubjectCode', label: 'Subject', type: 'ref', ref: 'Subjects', refKey: 'SubjectCode', refLabel: 'SubjectName', required: true },
      { key: 'Priority', label: 'Priority (1 = highest)', type: 'select', options: [1, 2, 3, 4, 5], numeric: true, required: true },
      { key: 'ExperienceYears', label: 'Experience (years)', type: 'number', min: 0, max: 60 },
      { key: 'ResearchPapers', label: 'Published research papers', type: 'number', min: 0, max: 1000 },
      { key: 'Remarks', label: 'Remarks' },
    ],
    defaults: { Priority: 1 },
  },

  TeacherSubjectMap: {
    label: 'Teaching Assignments',
    icon: '🔗',
    hint: 'Final allotment: who teaches which subject to which section',
    key: ['TeacherID', 'SubjectCode', 'SectionID'],
    filterBy: 'TeacherID',
    adminOnly: true,
    columns: [
      { key: 'TeacherID', label: 'Teacher', type: 'ref', ref: 'Teachers', refKey: 'TeacherID', refLabel: 'Name', required: true },
      { key: 'SubjectCode', label: 'Subject', type: 'ref', ref: 'Subjects', refKey: 'SubjectCode', refLabel: 'SubjectName', required: true },
      { key: 'SectionID', label: 'Section', type: 'ref', ref: 'Sections', refKey: 'SectionID', required: true },
      { key: 'BranchCode', label: 'Branch', auto: true },
      { key: 'Year', label: 'Year', auto: true, type: 'number' },
      { key: 'Semester', label: 'Semester', auto: true, type: 'number' },
      { key: 'Section', label: 'Sec', auto: true },
    ],
    derive: (r, db) => {
      const s = (db.Sections || []).find((x) => x.SectionID === r.SectionID)
      return s ? { BranchCode: s.BranchCode, Year: s.Year, Semester: s.Semester, Section: s.Section } : {}
    },
  },

  Rooms: {
    label: 'Rooms & Labs',
    icon: '🏫',
    hint: 'Classrooms and labs with seating capacity',
    key: ['RoomID'],
    columns: [
      { key: 'RoomID', label: 'Room ID', auto: true },
      { key: 'RoomType', label: 'Type', type: 'select', options: ['Classroom', 'Lab'], required: true },
      { key: 'Capacity', label: 'Capacity', type: 'number', min: 1, max: 500, required: true },
      { key: 'Building', label: 'Block', required: true, upper: true },
      { key: 'Floor', label: 'Floor', type: 'number', min: 0, max: 9 },
      { key: 'RoomNo', label: 'Room No', type: 'number', min: 1, max: 99 },
    ],
    defaults: { RoomType: 'Classroom', Capacity: 60 },
    // Room ID = block + floor + 2-digit room number, e.g. A101 = block A, floor 1, room 01.
    // Rooms saved earlier without floor / room no keep the ID they already have.
    derive: (r) => {
      const has = (v) => v !== '' && v !== undefined && v !== null
      return r.Building && has(r.Floor) && has(r.RoomNo) ? { RoomID: `${String(r.Building).trim().toUpperCase()}${Number(r.Floor)}${String(Number(r.RoomNo)).padStart(2, '0')}` } : {}
    },
  },

  TimeSlots: {
    label: 'Time Slots',
    icon: '🕘',
    hint: 'Weekly period grid: days, periods and timings',
    key: ['Day', 'Period'],
    adminOnly: true,
    columns: [
      { key: 'Day', label: 'Day', type: 'select', options: WEEK, required: true },
      { key: 'Period', label: 'Period', type: 'number', min: 1, max: 12, required: true },
      { key: 'StartTime', label: 'Start', type: 'time', required: true },
      { key: 'EndTime', label: 'End', type: 'time', required: true },
    ],
    defaults: { Day: 'Monday' },
  },
}

export const TABLE_ORDER = ['Branches', 'Sections', 'Subjects', 'Teachers', 'TeacherPreferences', 'TeacherSubjectMap', 'Rooms', 'TimeSlots']

export const recordKey = (name, row) => TABLES[name].key.map((k) => String(row[k] ?? '')).join('|')

export const withDerived = (name, row, db) => {
  const t = TABLES[name]
  return t.derive ? { ...row, ...t.derive(row, db) } : row
}

// Returns a list of error strings for a row (empty = valid).
export function validateRow(name, row, db, selfId) {
  const t = TABLES[name]
  const errs = []
  for (const c of t.columns) {
    if (c.auto) continue
    const v = row[c.key]
    const empty = v === undefined || v === null || String(v).trim() === ''
    if (c.required && empty) { errs.push(`${c.label} is required`); continue }
    if (empty) continue
    if (c.type === 'number' || c.numeric) {
      const n = Number(v)
      if (Number.isNaN(n)) errs.push(`${c.label} must be a number`)
      else if (c.min !== undefined && n < c.min) errs.push(`${c.label} must be ≥ ${c.min}`)
      else if (c.max !== undefined && n > c.max) errs.push(`${c.label} must be ≤ ${c.max}`)
    }
    if (c.type === 'ref') {
      const ok = (db[c.ref] || []).some((r) => String(r[c.refKey]) === String(v))
      if (!ok) errs.push(`${c.label} "${v}" not found in ${TABLES[c.ref].label}`)
    }
  }
  if (name === 'TimeSlots' && row.StartTime && row.EndTime && row.StartTime >= row.EndTime) errs.push('End time must be after start time')
  if (name === 'Rooms' && !row.RoomID) errs.push('Pick a block, floor and room number to generate the Room ID')
  if (name === 'Subjects' && row.Type === 'Lab' && Number(row.WeeklyHours) % 2 === 1) errs.push('Lab hours should be even (labs run as 2-period blocks)')
  const k = recordKey(name, row)
  if (!errs.length && (db[name] || []).some((r) => r._id !== selfId && recordKey(name, r) === k)) {
    errs.push(`Duplicate: ${t.key.join(' + ')} "${k.replaceAll('|', ' / ')}" already exists`)
  }
  return errs
}

// The break sitting after period `p` in automatic mode: { start, end, minutes } or null.
export function breakAfter(s, p) {
  if (s.timingMode !== 'auto') return null
  const end = autoTimings(s.auto, s.periodsPerDay)[p]?.end
  const minutes = (s.auto.breaks || []).filter((b) => Number(b.after) === p).reduce((n, b) => n + (Number(b.minutes) || 0), 0)
  if (!end || !minutes || p >= s.periodsPerDay) return null
  const e = toMin(end) + minutes
  return e > 24 * 60 ? null : { start: end, end: toHHMM(e), minutes }
}
