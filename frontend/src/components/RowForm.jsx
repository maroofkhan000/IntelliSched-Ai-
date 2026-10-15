import { useMemo, useState } from 'react'
import degreeCatalog from '../degreeCatalog.json'
import catalog from '../subjectCatalog.json'
import { rankTeachers, teacherLoads } from '../assigner'
import { MAX_TOP_PRIORITY, TABLES, topPriorityError, validateRow, withDerived } from '../schema'
import { useStore } from '../store'

// Branches: each degree lists only its own branches. A degree without branches (B.Arch, BCA...)
// offers itself as its single branch.
const DEGREES = new Map(degreeCatalog.map((d) => [d.Degree, d]))
const DEGREE_LEVELS = [...new Set(degreeCatalog.map((d) => d.Level))]
const branchesOf = (d) => (!d ? [] : d.Branches.length ? d.Branches : [{ BranchCode: d.Code, BranchName: d.Name }])

// Modal form for adding / editing one row of a table.
export default function RowForm({ table, row, onClose }) {
  const { db, saveRow, saveTeacher } = useStore()
  const t = TABLES[table]
  const editing = Boolean(row)
  const [form, setForm] = useState(() => ({ ...t.defaults, ...(row ?? {}) }))
  const [errors, setErrors] = useState([])
  const [saved, setSaved] = useState(0)
  const [busy, setBusy] = useState(false)
  const isSubjects = table === 'Subjects'
  // Dropdown list = built-in catalog + subjects typed in manually earlier (any branch, same semester),
  // so a manual subject shows up in the dropdowns with its code from then on.
  const subjectPool = useMemo(() => {
    const builtIn = (r) => catalog.some((s) => s.SubjectCode === r.SubjectCode && (s.BranchCode === r.BranchCode || s.BranchCode === 'ALL'))
    const seen = new Set()
    const custom = []
    for (const r of db.Subjects) {
      if (builtIn(r) || seen.has(r.SubjectCode)) continue
      seen.add(r.SubjectCode)
      custom.push({ SubjectCode: r.SubjectCode, BranchCode: 'ALL', Semester: r.Semester, SubjectName: r.SubjectName, Type: r.Type, Credits: r.Credits, WeeklyHours: r.WeeklyHours })
    }
    return [...catalog, ...custom]
  }, [db.Subjects])
  const isBranches = table === 'Branches'
  const isTeachers = table === 'Teachers'
  // a teacher's subject preferences are edited right inside the teacher form
  const [prefs, setPrefs] = useState(() => (isTeachers && row
    ? db.TeacherPreferences.filter((p) => p.TeacherID === row.TeacherID).map((p) => ({ SubjectCode: p.SubjectCode, Priority: p.Priority, ExperienceYears: p.ExperienceYears ?? '' }))
    : []))
  const setPref = (i, patch) => setPrefs((l) => l.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const isRooms = table === 'Rooms'
  const isSections = table === 'Sections'
  const SECTION_LETTERS = 'ABCDEFGHIJ'.split('')
  const [otherSection, setOtherSection] = useState(() => isSections && editing && Boolean(row.Section) && !SECTION_LETTERS.includes(row.Section))
  // blocks come from the Buildings table once it has rows; until then, the usual A–F
  const BLOCKS = db.Buildings.length ? [...new Set(db.Buildings.map((b) => b.BuildingCode))].sort() : ['A', 'B', 'C', 'D', 'E', 'F']
  const [otherBlock, setOtherBlock] = useState(() => isRooms && editing && Boolean(row.Building) && !BLOCKS.includes(row.Building))
  const [otherRoomNo, setOtherRoomNo] = useState(() => isRooms && editing && Number(row.RoomNo) > 20)
  const [otherDegree, setOtherDegree] = useState(() => isBranches && editing && Boolean(row.Degree) && !DEGREES.has(row.Degree))
  const [otherBranch, setOtherBranch] = useState(() => isBranches && editing && !branchesOf(DEGREES.get(row.Degree)).some((x) => x.BranchCode === row.BranchCode))
  const inCatalog = (r) => subjectPool.some((s) => s.SubjectCode === r.SubjectCode && (s.BranchCode === r.BranchCode || s.BranchCode === 'ALL') && Number(s.Semester) === Number(r.Semester))
  // "Other": the subject isn't in the catalog, so code and name are typed in
  const [other, setOther] = useState(() => isSubjects && editing && !inCatalog(row))

  const preview = useMemo(() => withDerived(table, form, db), [table, form, db])
  // changing branch/semester invalidates a subject picked from the catalog, and a section's
  // year/semester (the new branch may have fewer years)
  const set = (k, v) => setForm((f) => ({
    ...f,
    [k]: v,
    ...(isSubjects && !other && (k === 'BranchCode' || k === 'Semester') ? { SubjectCode: '', SubjectName: '' } : {}),
    ...(isSections && k === 'BranchCode' ? { Year: '', Semester: '' } : {}),
  }))

  const submit = (another) => async (e) => {
    e.preventDefault()
    const data = { ...preview }
    for (const c of t.columns) if ((c.type === 'number' || c.numeric) && data[c.key] !== '' && data[c.key] != null) data[c.key] = Number(data[c.key])
    const errs = validateRow(table, data, db, row?._id)
    if (isTeachers && topPriorityError(prefs)) errs.push(topPriorityError(prefs))
    setErrors(errs)
    if (errs.length) return
    setBusy(true)
    const serverErrs = isTeachers ? await saveTeacher(data, row?._id, prefs) : await saveRow(table, data, row?._id)
    setBusy(false)
    if (serverErrs.length) return setErrors(serverErrs)
    if (another && !editing) {
      // keep context fields (branch, semester...) so consecutive rows are quick to enter
      const keep = { ...t.defaults }
      for (const c of t.columns) if (['BranchCode', 'Semester', 'TeacherID', 'Building', 'Floor', 'RoomType', 'Day'].includes(c.key) && !c.auto) keep[c.key] = data[c.key]
      setForm(keep)
      setPrefs([])
      setSaved((n) => n + 1)
    } else onClose()
  }

  // Subjects: Year narrows Semester; Branch + Semester narrow the catalog dropdowns.
  const branch = db.Branches.find((b) => b.BranchCode === form.BranchCode)
  const yearCount = Number(branch?.TotalYears) || 4
  const perYear = Number(branch?.SemestersPerYear) || 2
  const semesterOptions = () => {
    const y = Number(preview.Year)
    if (y) return Array.from({ length: perYear }, (_, i) => (y - 1) * perYear + i + 1)
    return Array.from({ length: yearCount * perYear }, (_, i) => i + 1)
  }
  const setYear = (y) => setForm((f) => {
    const sem = Number(f.Semester)
    const ok = y && sem && Math.ceil(sem / perYear) === Number(y)
    return { ...f, Year: y, Semester: ok ? f.Semester : '', ...(isSubjects && !ok && !other ? { SubjectCode: '', SubjectName: '' } : {}) }
  })
  const taken = new Set(db.Subjects.filter((r) => r._id !== row?._id && r.BranchCode === form.BranchCode).map((r) => r.SubjectCode))
  // Branch + Year is enough to list subjects: the year's semesters are offered, grouped, and
  // picking one fills the semester. A chosen semester narrows the list to just that semester.
  const pickedYear = Number(preview.Year)
  const catalogListed = isSubjects && form.BranchCode && (form.Semester || pickedYear)
    ? subjectPool.filter((s) => (s.BranchCode === form.BranchCode || s.BranchCode === 'ALL') &&
        (form.Semester ? Number(s.Semester) === Number(form.Semester) : Math.ceil(Number(s.Semester) / perYear) === pickedYear))
    : []
  const catalogOptions = catalogListed.filter((s) => !taken.has(s.SubjectCode))
  const catalogGroups = []
  for (const s of catalogOptions) {
    const label = `Semester ${s.Semester} · ${s.Elective ? 'Electives' : 'Core'}`
    const g = catalogGroups.find((x) => x.label === label) ?? catalogGroups[catalogGroups.push({ label, sem: Number(s.Semester), elective: Boolean(s.Elective), items: [] }) - 1]
    g.items.push(s)
  }
  catalogGroups.sort((a, b) => a.sem - b.sem || a.elective - b.elective)
  const pickCatalog = (code) => {
    if (code === OTHER) { setOther(true); setForm((f) => ({ ...f, SubjectCode: '', SubjectName: '' })); return }
    const s = catalogOptions.find((x) => x.SubjectCode === code)
    setForm((f) => (s
      ? { ...f, Semester: s.Semester, SubjectCode: s.SubjectCode, SubjectName: s.SubjectName, Type: s.Type, Credits: s.Credits, WeeklyHours: s.WeeklyHours }
      : { ...f, SubjectCode: '', SubjectName: '' }))
  }

  const OTHER = '__other__'

  // Branches: degree first (fills years / semesters), then one of that degree's branches, or type your own.
  const takenBranches = new Set(db.Branches.filter((r) => r._id !== row?._id).map((r) => r.BranchCode))
  const degree = DEGREES.get(form.Degree)
  const branchOptions = branchesOf(degree).filter((x) => !takenBranches.has(x.BranchCode))
  const pickDegree = (v) => {
    setOtherBranch(v === OTHER)
    if (v === OTHER) { setOtherDegree(true); setForm((f) => ({ ...f, Degree: '', BranchCode: '', BranchName: '' })); return }
    const d = DEGREES.get(v)
    const options = branchesOf(d).filter((x) => !takenBranches.has(x.BranchCode))
    // a degree without branches has just one option, so it is picked straight away
    const only = d && !d.Branches.length && options.length === 1 ? options[0] : { BranchCode: '', BranchName: '' }
    setForm((f) => ({ ...f, Degree: v, ...(d ? { TotalYears: d.TotalYears, SemestersPerYear: d.SemestersPerYear } : {}), ...only }))
  }
  const pickBranch = (code) => {
    if (code === OTHER) { setOtherBranch(true); setForm((f) => ({ ...f, BranchCode: '', BranchName: '' })); return }
    const x = branchOptions.find((y) => y.BranchCode === code)
    // a branch may run longer or shorter than its degree's usual length (e.g. 4-year paramedical B.Sc)
    const years = x?.TotalYears ?? degree?.TotalYears
    setForm((f) => ({ ...f, BranchCode: x?.BranchCode ?? '', BranchName: x?.BranchName ?? '', ...(years ? { TotalYears: years } : {}) }))
  }

  // Subjects are entered top-down: branch, year, semester, then the subject itself.
  const SUBJECT_ORDER = ['BranchCode', 'Year', 'Semester', 'SubjectName', 'SubjectCode']
  const ROOM_ORDER = ['Building', 'Floor', 'RoomNo', 'RoomID']
  const SECTION_ORDER = ['BranchCode', 'Year', 'Semester', 'Section', 'Strength', 'SectionID']
  // section letters already used for this branch + semester
  const takenSections = new Set(db.Sections.filter((r) => r._id !== row?._id && r.BranchCode === form.BranchCode && Number(r.Semester) === Number(form.Semester)).map((r) => r.Section))
  // Branch dropdowns (Sections, Subjects, Teachers) are grouped by degree and show the branch name
  const branchGroups = [...new Set(db.Branches.map((b) => b.Degree || 'Other'))].map((deg) => ({ deg, items: db.Branches.filter((b) => (b.Degree || 'Other') === deg) }))
  const isAssign = table === 'TeacherSubjectMap'
  const ASSIGN_ORDER = ['SectionID', 'SubjectCode', 'TeacherID']
  // teachers who asked for the chosen subject, best claim first (priority, fit score, load share)
  const ranked = useMemo(() => (isAssign && form.SubjectCode ? rankTeachers(db, form.SubjectCode, teacherLoads(db)) : []), [isAssign, form.SubjectCode, db])
  const formColumns = isAssign
    ? [...ASSIGN_ORDER.map((k) => t.columns.find((c) => c.key === k)), ...t.columns.filter((c) => !ASSIGN_ORDER.includes(c.key))]
    : isRooms
    ? [...ROOM_ORDER.map((k) => t.columns.find((c) => c.key === k)), ...t.columns.filter((c) => !ROOM_ORDER.includes(c.key))]
    : isSections
    ? SECTION_ORDER.map((k) => t.columns.find((c) => c.key === k))
    : isSubjects
    ? [...SUBJECT_ORDER.map((k) => t.columns.find((c) => c.key === k)), ...t.columns.filter((c) => !SUBJECT_ORDER.includes(c.key))]
    : t.columns

  const refOptions = (c) => {
    let rows = db[c.ref] || []
    // narrow long dropdowns using what's already chosen
    if (c.key === 'SubjectCode' && form.TeacherID) {
      const teacher = db.Teachers.find((x) => x.TeacherID === form.TeacherID)
      if (teacher && table === 'TeacherPreferences') rows = rows.filter((s) => s.BranchCode === teacher.BranchCode || form.SubjectCode === s.SubjectCode)
    }
    if (c.key === 'SubjectCode' && table === 'TeacherSubjectMap' && form.SectionID) {
      const sec = db.Sections.find((x) => x.SectionID === form.SectionID)
      if (sec) rows = rows.filter((s) => s.BranchCode === sec.BranchCode && Number(s.Semester) === Number(sec.Semester))
      // a subject already given to this section drops out of the list
      const assigned = new Set(db.TeacherSubjectMap.filter((a) => a._id !== row?._id && a.SectionID === form.SectionID).map((a) => a.SubjectCode))
      rows = rows.filter((s) => !assigned.has(s.SubjectCode) || s.SubjectCode === form.SubjectCode)
    }
    return rows
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className={`modal${isTeachers ? ' wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} onSubmit={submit(false)}>
        <header>
          <h3>{editing ? 'Edit' : 'Add'} — {t.label}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="fields">
          {formColumns.map((c) => {
            const val = preview[c.key] ?? ''
            if ((isSubjects || isSections) && c.key === 'Year') {
              return (
                <label key={c.key} className="field">
                  <span>Year</span>
                  <select value={val} disabled={isSections && !form.BranchCode} onChange={(e) => setYear(e.target.value)}>
                    <option value="">{isSections && !form.BranchCode ? 'Pick a branch first' : 'Select…'}</option>
                    {Array.from({ length: yearCount }, (_, i) => i + 1).map((y) => <option key={y} value={y}>Year {y}</option>)}
                  </select>
                </label>
              )
            }
            if ((isSubjects || isSections) && c.key === 'Semester') {
              return (
                <label key={c.key} className="field">
                  <span>{c.label}<b> *</b></span>
                  <select value={val} disabled={isSections && !form.BranchCode} onChange={(e) => set(c.key, e.target.value)}>
                    <option value="">{isSections && !form.BranchCode ? 'Pick a branch first' : 'Select…'}</option>
                    {semesterOptions().map((n) => <option key={n} value={n}>Semester {n}</option>)}
                  </select>
                </label>
              )
            }
            if (isSections && c.key === 'Section') {
              return (
                <label key={c.key} className="field">
                  <span>Section<b> *</b></span>
                  {otherSection ? (
                    <input value={val} placeholder="e.g. K" onChange={(e) => set(c.key, e.target.value.toUpperCase())} />
                  ) : (
                    <select value={val} onChange={(e) => (e.target.value === OTHER ? (setOtherSection(true), set(c.key, '')) : set(c.key, e.target.value))}>
                      <option value="">Select…</option>
                      {SECTION_LETTERS.filter((s) => !takenSections.has(s) || s === val).map((s) => <option key={s} value={s}>{s}</option>)}
                      <option value={OTHER}>Other (enter manually)</option>
                    </select>
                  )}
                  {otherSection && <button type="button" className="link" onClick={() => { setOtherSection(false); set(c.key, '') }}>← Choose from the list instead</button>}
                </label>
              )
            }
            if (isSubjects && !other && (c.key === 'SubjectCode' || c.key === 'SubjectName')) {
              const ready = form.BranchCode && (form.Semester || pickedYear)
              const isCode = c.key === 'SubjectCode'
              const picked = form.SubjectCode
              const scope = form.Semester ? `semester ${form.Semester}` : `year ${pickedYear}`
              // nothing listed = IUL publishes no timetabled subjects there (new batch, project-only
              // semester, or a branch IUL doesn't run); everything listed may also be added already
              const empty = !catalogListed.length ? `No IUL subjects for ${form.BranchCode} ${scope} — use Other` : 'All listed subjects added — use Other'
              return (
                <label key={c.key} className="field">
                  <span>{c.label}<b> *</b></span>
                  <select value={picked} disabled={!ready} onChange={(e) => pickCatalog(e.target.value)}>
                    <option value="">{!ready ? 'Pick branch & year first' : catalogOptions.length ? 'Select…' : empty}</option>
                    {picked && !catalogOptions.some((s) => s.SubjectCode === picked) && <option value={picked}>{isCode ? picked : form.SubjectName}</option>}
                    {catalogGroups.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.items.map((s) => <option key={s.SubjectCode} value={s.SubjectCode}>{isCode ? `${s.SubjectCode} — ${s.SubjectName}` : `${s.SubjectName} (${s.SubjectCode})`}</option>)}
                      </optgroup>
                    ))}
                    <option value={OTHER}>Other (enter manually)</option>
                  </select>
                  {isCode && ready && <small className="sub">{catalogListed.length
                    ? `${catalogOptions.length} subject${catalogOptions.length === 1 ? '' : 's'} left to add for ${scope}`
                    : `IUL's syllabus lists no timetabled subjects for ${form.BranchCode} ${scope}. Pick Other to type one in.`}</small>}
                </label>
              )
            }
            if (isAssign && c.key === 'TeacherID') {
              const rankedIds = new Set(ranked.map((r) => r.teacher.TeacherID))
              const others = db.Teachers.filter((x) => !rankedIds.has(x.TeacherID))
              return (
                <label key={c.key} className="field">
                  <span>Teacher<b> *</b></span>
                  <select value={val} onChange={(e) => set(c.key, e.target.value)}>
                    <option value="">Select…</option>
                    {ranked.length > 0 && (
                      <optgroup label="Asked for this subject — best claim first">
                        {ranked.map((r, i) => (
                          <option key={r.teacher._id} value={r.teacher.TeacherID}>
                            {i + 1}. {r.teacher.TeacherID} — {r.teacher.Name} · priority {r.priority === 9 ? '–' : r.priority} · {r.years} yrs · {r.held} sections held · load {r.load}/{r.max}h
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label={ranked.length ? 'Did not ask for this subject' : 'All teachers'}>
                      {others.map((x) => <option key={x._id} value={x.TeacherID}>{x.TeacherID} — {x.Name}</option>)}
                    </optgroup>
                  </select>
                  {form.SubjectCode && !ranked.length && <small className="sub">No teacher has listed this subject in Preferences.</small>}
                </label>
              )
            }
            if (isRooms && c.key === 'Building') {
              return (
                <label key={c.key} className="field">
                  <span>Block<b> *</b></span>
                  {otherBlock ? (
                    <input value={val} placeholder="e.g. G" onChange={(e) => set(c.key, e.target.value.toUpperCase())} />
                  ) : (
                    <select value={val} onChange={(e) => (e.target.value === OTHER ? (setOtherBlock(true), set(c.key, '')) : set(c.key, e.target.value))}>
                      <option value="">Select…</option>
                      {val && !BLOCKS.includes(val) && <option value={val}>{val}</option>}
                      {BLOCKS.map((b) => <option key={b} value={b}>{b}</option>)}
                      <option value={OTHER}>Other (enter manually)</option>
                    </select>
                  )}
                  {otherBlock && <button type="button" className="link" onClick={() => { setOtherBlock(false); set(c.key, '') }}>← Choose from the list instead</button>}
                </label>
              )
            }
            if (isRooms && c.key === 'Floor') {
              return (
                <label key={c.key} className="field">
                  <span>Floor<b> *</b></span>
                  <select value={val} onChange={(e) => set(c.key, e.target.value)}>
                    <option value="">Select…</option>
                    {Array.from({ length: 10 }, (_, i) => <option key={i} value={i}>{i === 0 ? 'Ground floor (0)' : `Floor ${i}`}</option>)}
                  </select>
                </label>
              )
            }
            if (isRooms && c.key === 'RoomNo') {
              return (
                <label key={c.key} className="field">
                  <span>Room No<b> *</b></span>
                  {otherRoomNo ? (
                    <input type="number" min={1} max={99} value={val} placeholder="21 – 99" onChange={(e) => set(c.key, e.target.value)} />
                  ) : (
                    <select value={val} onChange={(e) => (e.target.value === OTHER ? (setOtherRoomNo(true), set(c.key, '')) : set(c.key, e.target.value))}>
                      <option value="">Select…</option>
                      {Array.from({ length: 20 }, (_, i) => <option key={i} value={i + 1}>{String(i + 1).padStart(2, '0')}</option>)}
                      <option value={OTHER}>Other (enter manually)</option>
                    </select>
                  )}
                  {otherRoomNo && <button type="button" className="link" onClick={() => { setOtherRoomNo(false); set(c.key, '') }}>← Choose from the list instead</button>}
                </label>
              )
            }
            if (isBranches && c.key === 'Degree') {
              return (
                <label key={c.key} className="field">
                  <span>Degree<b> *</b></span>
                  {otherDegree ? (
                    <input value={val} placeholder="e.g. B.Voc" onChange={(e) => set(c.key, e.target.value)} />
                  ) : (
                    <select value={val} onChange={(e) => pickDegree(e.target.value)}>
                      <option value="">Select…</option>
                      {DEGREE_LEVELS.map((level) => (
                        <optgroup key={level} label={level}>
                          {degreeCatalog.filter((d) => d.Level === level).map((d) => <option key={d.Degree} value={d.Degree}>{d.Degree} — {d.Name}</option>)}
                        </optgroup>
                      ))}
                      <option value={OTHER}>Other (enter manually)</option>
                    </select>
                  )}
                  {otherDegree && <button type="button" className="link" onClick={() => { setOtherDegree(false); setOtherBranch(false); setForm((f) => ({ ...f, Degree: '', BranchCode: '', BranchName: '' })) }}>← Choose from the list instead</button>}
                </label>
              )
            }
            if (isBranches && !otherBranch && (c.key === 'BranchCode' || c.key === 'BranchName')) {
              const isCode = c.key === 'BranchCode'
              const picked = form.BranchCode
              return (
                <label key={c.key} className="field">
                  <span>{c.label}<b> *</b></span>
                  <select value={picked} disabled={!degree} onChange={(e) => pickBranch(e.target.value)}>
                    <option value="">{!degree ? 'Pick a degree first' : branchOptions.length ? 'Select…' : `All ${form.Degree} branches added — use Other`}</option>
                    {picked && !branchOptions.some((x) => x.BranchCode === picked) && <option value={picked}>{isCode ? picked : form.BranchName}</option>}
                    {branchOptions.map((x) => <option key={x.BranchCode} value={x.BranchCode}>{isCode ? `${x.BranchCode} — ${x.BranchName}` : x.BranchName}</option>)}
                    <option value={OTHER}>Other (enter manually)</option>
                  </select>
                  {isCode && degree && <small className="sub">{branchOptions.length} {form.Degree} branch{branchOptions.length === 1 ? '' : 'es'} left to add</small>}
                </label>
              )
            }
            if (c.auto) {
              return (
                <label key={c.key} className="field auto">
                  <span>{c.label} <em>auto</em></span>
                  <input value={val} readOnly tabIndex={-1} placeholder={c.generated ? 'generated when you pick a type' : isRooms ? 'e.g. A101' : 'generated'} />
                </label>
              )
            }
            let input
            if (c.type === 'select') {
              input = (
                <select value={val} disabled={editing && c.lockOnEdit} onChange={(e) => set(c.key, e.target.value)}>
                  <option value="">Select…</option>
                  {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )
            } else if (c.type === 'ref' && c.ref === 'Branches') {
              input = (
                <select value={val} onChange={(e) => set(c.key, e.target.value)}>
                  <option value="">{db.Branches.length ? 'Select…' : 'Add branches first'}</option>
                  {branchGroups.map((g) => (
                    <optgroup key={g.deg} label={g.deg}>
                      {g.items.map((b) => <option key={b._id} value={b.BranchCode}>{b.BranchCode} — {b.BranchName}</option>)}
                    </optgroup>
                  ))}
                </select>
              )
            } else if (c.type === 'ref') {
              input = (
                <select value={val} onChange={(e) => set(c.key, e.target.value)}>
                  <option value="">Select…</option>
                  {refOptions(c).map((r) => (
                    <option key={r._id} value={r[c.refKey]}>{r[c.refKey]}{c.refLabel ? ` — ${r[c.refLabel]}` : ''}</option>
                  ))}
                </select>
              )
            } else {
              input = (
                <input
                  type={c.type === 'number' ? 'number' : c.type === 'time' ? 'time' : 'text'}
                  min={c.min}
                  max={c.max}
                  value={val}
                  onChange={(e) => set(c.key, c.upper ? e.target.value.toUpperCase() : e.target.value)}
                />
              )
            }
            return (
              <label key={c.key} className="field">
                <span>{c.label}{c.required && <b> *</b>}</span>
                {input}
                {isBranches && otherBranch && !otherDegree && c.key === 'BranchName' && (
                  <button type="button" className="link" onClick={() => { setOtherBranch(false); setForm((f) => ({ ...f, BranchCode: '', BranchName: '' })) }}>← Choose from the list instead</button>
                )}
                {isSubjects && other && c.key === 'SubjectName' && (
                  <button type="button" className="link" onClick={() => { setOther(false); setForm((f) => ({ ...f, SubjectCode: '', SubjectName: '' })) }}>← Choose from the list instead</button>
                )}
              </label>
            )
          })}
        </div>

        {isTeachers && (
          <div className="prefs">
            <h4 className="sub-h">Subject preferences <span className="sub">— subjects this teacher wants to teach, ranked (1 = most wanted, at most {MAX_TOP_PRIORITY} subjects at priority 1)</span></h4>
            {prefs.map((p, i) => {
              const chosen = new Set(prefs.filter((_, j) => j !== i).map((x) => x.SubjectCode))
              const choices = [...new Map(db.Subjects.filter((s) => (!form.BranchCode || s.BranchCode === form.BranchCode) && !chosen.has(s.SubjectCode)).map((s) => [s.SubjectCode, s])).values()].sort((a, b) => a.SubjectCode.localeCompare(b.SubjectCode))
              return (
                <div key={i} className="pref-row">
                  <label className="field"><span>Subject</span>
                    <select value={p.SubjectCode} onChange={(e) => setPref(i, { SubjectCode: e.target.value })}>
                      <option value="">Select…</option>
                      {p.SubjectCode && !choices.some((s) => s.SubjectCode === p.SubjectCode) && <option value={p.SubjectCode}>{p.SubjectCode}</option>}
                      {choices.map((s) => <option key={s.SubjectCode} value={s.SubjectCode}>{s.SubjectCode} — {s.SubjectName} (Sem {s.Semester})</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Priority</span>
                    <select value={p.Priority} onChange={(e) => setPref(i, { Priority: e.target.value })}>
                      <option value="">Select…</option>
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Experience (yrs)</span><input type="number" min={0} max={60} value={p.ExperienceYears} onChange={(e) => setPref(i, { ExperienceYears: e.target.value })} /></label>
                  <button type="button" className="link danger" onClick={() => setPrefs((l) => l.filter((_, j) => j !== i))}>Remove</button>
                </div>
              )
            })}
            <button type="button" className="btn sm" onClick={() => setPrefs((l) => [...l, { SubjectCode: '', Priority: '', ExperienceYears: '' }])}>+ Add subject preference</button>
            {!form.BranchCode && <p className="sub">Pick the teacher's branch first to see its subjects.</p>}
          </div>
        )}

        {errors.length > 0 && (
          <ul className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        {saved > 0 && !errors.length && <p className="ok">✓ {saved} row{saved > 1 ? 's' : ''} saved this session</p>}

        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          {!editing && <button type="button" className="btn" disabled={busy} onClick={submit(true)}>Save & add another</button>}
          <button type="submit" className="btn primary" disabled={busy}>{editing ? 'Save changes' : 'Save'}</button>
        </footer>
      </form>
    </div>
  )
}
