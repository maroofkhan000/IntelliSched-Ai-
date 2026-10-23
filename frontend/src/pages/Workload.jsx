import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TERMS } from '../generator'
import { WEEK } from '../schema'
import { useStore } from '../store'

// Two views over the approved rows: which section-subject pairs still have no teacher, and how
// much each teacher (or department) is teaching, as a heatmap by semester or by day.

const approved = (rows = []) => rows.filter((r) => r._status === 'approved')
const num = (v) => Number(v) || 0
const pct = (load, max) => (max ? Math.round((load / max) * 100) : 0)

const SHOW = { all: 'Everyone', over: 'Over max load', high: '80% of max or more', low: 'Under 50% of max', idle: 'No hours yet' }
const SORT = { most: 'Most loaded first', least: 'Least loaded first', id: 'Teacher ID' }

export default function Workload() {
  const { db, settings, timetable } = useStore()
  const [branch, setBranch] = useState('') // '' = every department
  const [mode, setMode] = useState('semester') // semester | day
  const [group, setGroup] = useState('teacher') // teacher | dept
  const [show, setShow] = useState('all')
  const [sort, setSort] = useState('most')
  const [profile, setProfile] = useState(null) // TeacherID whose profile is open

  const branches = approved(db.Branches).map((b) => b.BranchCode).sort()
  const days = WEEK.filter((d) => settings.schoolDays.includes(d))
  const byDay = mode === 'day' && timetable

  const data = useMemo(() => {
    const sections = approved(db.Sections)
    const subjects = approved(db.Subjects)
    const map = approved(db.TeacherSubjectMap)
    const prefs = approved(db.TeacherPreferences)
    const subjectFor = (code, br) => subjects.find((s) => s.SubjectCode === code && s.BranchCode === br) ?? subjects.find((s) => s.SubjectCode === code)
    const sectionById = new Map(sections.map((s) => [s.SectionID, s]))

    // section-subject pairs nobody teaches yet
    const taken = new Set(map.map((m) => `${m.SectionID}|${m.SubjectCode}`))
    const askedBy = new Map()
    for (const p of prefs) askedBy.set(p.SubjectCode, (askedBy.get(p.SubjectCode) ?? 0) + 1)
    const unassigned = []
    for (const s of sections) {
      for (const sub of subjects) {
        if (sub.BranchCode !== s.BranchCode || num(sub.Semester) !== num(s.Semester) || taken.has(`${s.SectionID}|${sub.SubjectCode}`)) continue
        unassigned.push({ SectionID: s.SectionID, BranchCode: s.BranchCode, Semester: num(s.Semester), SubjectCode: sub.SubjectCode, SubjectName: sub.SubjectName, Type: sub.Type, hours: num(sub.WeeklyHours), asked: askedBy.get(sub.SubjectCode) ?? 0 })
      }
    }
    unassigned.sort((a, b) => a.SectionID.localeCompare(b.SectionID) || a.SubjectCode.localeCompare(b.SubjectCode))

    // assigned hours per teacher, split by the semester of the section
    const perTeacher = new Map(approved(db.Teachers).map((t) => [t.TeacherID, { t, total: 0, sections: 0, sem: new Map(), day: new Map(), items: [] }]))
    const semesters = new Set()
    const orphans = [] // assignments whose subject is no longer an approved Subjects row (counted as 0 hours)
    for (const m of map) {
      const row = perTeacher.get(m.TeacherID)
      if (!row) continue
      const sec = sectionById.get(m.SectionID)
      const sub = subjectFor(m.SubjectCode, sec?.BranchCode ?? m.BranchCode)
      const h = num(sub?.WeeklyHours)
      const sem = num(sec?.Semester ?? m.Semester)
      row.items.push({ SectionID: m.SectionID, BranchCode: sec?.BranchCode ?? m.BranchCode, Semester: sem, SubjectCode: m.SubjectCode, SubjectName: sub?.SubjectName ?? '', Type: sub?.Type ?? '', hours: h, missing: !sub })
      if (!sub) orphans.push(`${m.SubjectCode} → ${m.SectionID}`)
      row.total += h
      row.sections += 1
      row.sem.set(sem, (row.sem.get(sem) ?? 0) + h)
      semesters.add(sem)
    }
    // periods per day in the saved timetable (each entry is one period)
    for (const e of timetable?.entries ?? []) {
      const row = perTeacher.get(e.TeacherID)
      if (row) row.day.set(e.Day, (row.day.get(e.Day) ?? 0) + 1)
    }
    return { unassigned, orphans, teachers: [...perTeacher.values()], semesters: [...semesters].filter(Boolean).sort((a, b) => a - b) }
  }, [db, timetable])

  const unassigned = data.unassigned.filter((u) => !branch || u.BranchCode === branch)
  const unassignedHours = unassigned.reduce((n, u) => n + u.hours, 0)

  // heatmap rows: one per teacher, or one per department (sums of its teachers)
  const cols = byDay ? days : data.semesters
  const cell = (r, c) => (byDay ? r.day.get(c) : r.sem.get(c)) ?? 0
  let rows = data.teachers
    .filter((r) => !branch || r.t.BranchCode === branch)
    .map((r) => ({ key: r.t.TeacherID, label: `${r.t.TeacherID} — ${r.t.Name}`, dept: r.t.BranchCode, total: r.total, max: num(r.t.MaxWeeklyLoad), sections: r.sections, people: 1, cells: cols.map((c) => cell(r, c)) }))
  rows = rows.filter((r) => {
    const p = pct(r.total, r.max)
    return show === 'over' ? r.total > r.max : show === 'high' ? p >= 80 : show === 'low' ? p < 50 : show === 'idle' ? r.total === 0 : true
  })
  if (group === 'dept') {
    const depts = new Map()
    for (const r of rows) {
      const d = depts.get(r.dept) ?? { key: r.dept, label: r.dept, total: 0, max: 0, sections: 0, people: 0, cells: cols.map(() => 0) }
      d.total += r.total
      d.max += r.max
      d.sections += r.sections
      d.people += 1
      r.cells.forEach((v, i) => { d.cells[i] += v })
      depts.set(r.dept, d)
    }
    rows = [...depts.values()]
  }
  rows.sort(sort === 'id' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => (sort === 'most' ? 1 : -1) * (pct(b.total, b.max) - pct(a.total, a.max)) || a.key.localeCompare(b.key))

  // colour scale: a day is full at periodsPerDay per person; a semester column is scaled to the busiest cell shown
  const top = byDay ? null : Math.max(1, ...rows.flatMap((r) => r.cells))
  const heat = (v, r) => Math.min(100, Math.round((v / (byDay ? num(settings.periodsPerDay) * r.people || 1 : top)) * 100))
  const sum = rows.reduce((a, r) => ({ total: a.total + r.total, max: a.max + r.max }), { total: 0, max: 0 })

  return (
    <>
      <div className="page-head">
        <div>
          <h1>📈 Workload</h1>
          <p className="muted">Subjects that still need a teacher, and how many hours each teacher and department carries. Approved rows only.</p>
        </div>
        <label className="field dept-pick"><span>Department</span>
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">All departments</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
      </div>

      <section className="card">
        <div className="tools-head">
          <div>
            <h3>Subjects without a teacher</h3>
            <p className="muted">{unassigned.length ? `${unassigned.length} section-subject pairs (${unassignedHours} hours a week) have no teacher${branch ? ` in ${branch}` : ''}.` : `Every section-subject pair${branch ? ` in ${branch}` : ''} has a teacher.`} Generating a timetable assigns these automatically when someone can take them.</p>
          </div>
          <Link className="btn" to="/table/TeacherSubjectMap">Open Teaching Assignments</Link>
        </div>
        {unassigned.length > 0 && (
          <div className="grid-scroll spaced short">
            <table className="grid">
              <thead><tr><th>Section</th><th>Dept</th><th className="num">Sem</th><th>Subject</th><th>Type</th><th className="num">Hours/wk</th><th>Who asked for it</th></tr></thead>
              <tbody>
                {unassigned.map((u) => (
                  <tr key={`${u.SectionID}|${u.SubjectCode}`}>
                    <td>{u.SectionID}</td><td>{u.BranchCode}</td><td className="num">{u.Semester}</td>
                    <td>{u.SubjectName} <span className="sub">{u.SubjectCode}</span></td><td>{u.Type}</td><td className="num">{u.hours}</td>
                    <td className={u.asked ? '' : 'bad-text'}>{u.asked ? `${u.asked} teacher${u.asked === 1 ? '' : 's'}` : 'Nobody listed it'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Teacher load heatmap</h3>
        {data.orphans.length > 0 && (
          <p className="notice">{data.orphans.length} teaching assignment{data.orphans.length === 1 ? '' : 's'} point to a subject that is not in Subjects (or not approved), so {data.orphans.length === 1 ? 'it counts' : 'they count'} as 0 hours and won't be scheduled: {data.orphans.slice(0, 6).join(', ')}{data.orphans.length > 6 ? ` and ${data.orphans.length - 6} more` : ''}. Add the subject back, or delete these assignments.</p>
        )}
        <p className="muted">
          {byDay
            ? `Periods per day in the saved timetable (${TERMS[timetable.scope.term]}${timetable.scope.branch ? ` · ${timetable.scope.branch}` : ''}). A cell is darkest when the day is full.`
            : 'Weekly hours assigned in each semester, from Teaching Assignments. Darker cells carry more hours.'}
          {' '}The last column is the week's assigned hours against the max load. {group === 'teacher' ? 'Click a teacher to see their profile.' : 'Click a department to see its teachers.'}
        </p>
        <div className="gen-controls">
          <div className="field"><span>Columns</span>
            <div className="seg" role="group" aria-label="Columns">
              <button className={mode === 'semester' ? 'on' : ''} onClick={() => setMode('semester')}>By semester</button>
              <button className={mode === 'day' ? 'on' : ''} onClick={() => setMode('day')} disabled={!timetable} title={timetable ? '' : 'Generate a timetable first'}>By day</button>
            </div>
          </div>
          <div className="field"><span>Rows</span>
            <div className="seg" role="group" aria-label="Rows">
              <button className={group === 'teacher' ? 'on' : ''} onClick={() => setGroup('teacher')}>Teachers</button>
              <button className={group === 'dept' ? 'on' : ''} onClick={() => setGroup('dept')}>Departments</button>
            </div>
          </div>
          <label className="field"><span>Show</span>
            <select value={show} onChange={(e) => setShow(e.target.value)}>{Object.entries(SHOW).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <label className="field"><span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>{Object.entries(SORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
        </div>

        {rows.length ? (
          <div className="grid-scroll spaced">
            <table className="grid heat">
              <thead>
                <tr>
                  <th>{group === 'dept' ? 'Department' : 'Teacher'}</th>
                  {group === 'teacher' ? <th>Dept</th> : <th className="num">Teachers</th>}
                  <th className="num">Sections</th>
                  {cols.map((c) => <th key={c} className="num">{byDay ? c.slice(0, 3) : `Sem ${c}`}</th>)}
                  <th className="num">Load</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const p = pct(r.total, r.max)
                  // a teacher row opens their profile; a department row drills down to its teachers
                  const open = group === 'teacher' ? () => setProfile(r.key) : () => { setBranch(r.key); setGroup('teacher') }
                  return (
                    <tr key={r.key} className="click" onClick={open}>
                      <td><button className="link name" onClick={(e) => { e.stopPropagation(); open() }}>{r.label}</button></td>
                      {group === 'teacher' ? <td>{r.dept}</td> : <td className="num">{r.people}</td>}
                      <td className="num">{r.sections}</td>
                      {r.cells.map((v, i) => {
                        const h = heat(v, r)
                        return <td key={cols[i]} className={`num h${h >= 60 ? ' dark' : ''}`} style={{ '--h': h }}>{v || ''}</td>
                      })}
                      <td className={`num h load${r.total > r.max ? ' over' : p >= 60 ? ' dark' : ''}`} style={{ '--h': Math.min(100, p) }}>{r.total}/{r.max}h · {p}%</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr><td colSpan={3 + cols.length}>{rows.length} {group === 'dept' ? 'departments' : 'teachers'} shown</td><td className="num">{sum.total}/{sum.max}h · {pct(sum.total, sum.max)}%</td></tr>
              </tfoot>
            </table>
          </div>
        ) : <p className="notice info">No teachers match these filters.</p>}
        {!cols.length && rows.length > 0 && <p className="muted">{byDay ? 'The saved timetable has no school days set.' : 'No teaching assignments yet, so there are no semester columns.'}</p>}
      </section>

      {profile && <TeacherProfile row={data.teachers.find((r) => r.t.TeacherID === profile)} days={days} timetable={timetable} onClose={() => setProfile(null)} />}
    </>
  )
}

// Everything about one teacher: who they are, what they teach, what they asked for, their week.
function TeacherProfile({ row, days, timetable, onClose }) {
  const { db } = useStore()
  if (!row) return null
  const { t, items, total, day } = row
  const max = num(t.MaxWeeklyLoad)
  const p = pct(total, max)
  const names = new Map(approved(db.Subjects).map((s) => [s.SubjectCode, s.SubjectName]))
  const held = new Map()
  for (const i of items) held.set(i.SubjectCode, (held.get(i.SubjectCode) ?? 0) + 1)
  const prefs = approved(db.TeacherPreferences).filter((x) => x.TeacherID === t.TeacherID).sort((a, b) => num(a.Priority) - num(b.Priority) || num(b.ExperienceYears) - num(a.ExperienceYears))
  const away = approved(db.TeacherAvailability).filter((x) => x.TeacherID === t.TeacherID)
  const teaching = [...items].sort((a, b) => a.SubjectCode.localeCompare(b.SubjectCode) || a.SectionID.localeCompare(b.SectionID))
  const otherDept = items.filter((i) => i.BranchCode !== t.BranchCode).length

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h3>{t.Name} <span className="sub">{t.TeacherID}</span></h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <dl className="facts">
          <div><dt>Department</dt><dd>{t.BranchCode}</dd></div>
          <div><dt>Type</dt><dd>{t.TeacherType ?? '—'}</dd></div>
          <div><dt>Designation</dt><dd>{t.Designation ?? '—'}</dd></div>
          <div><dt>Home building</dt><dd>{t.HomeBuilding || 'Any'}</dd></div>
          <div><dt>Load</dt><dd className={total > max ? 'bad-text' : ''}>{total}/{max}h · {p}%</dd></div>
          <div><dt>Sections</dt><dd>{items.length}{otherDept ? ` (${otherDept} in other departments)` : ''}</dd></div>
        </dl>

        <h4 className="sub-h">Teaching</h4>
        {teaching.length ? (
          <div className="grid-scroll short">
            <table className="grid">
              <thead><tr><th>Subject</th><th>Section</th><th>Dept</th><th className="num">Sem</th><th>Type</th><th className="num">Hours/wk</th></tr></thead>
              <tbody>
                {teaching.map((i) => (
                  <tr key={`${i.SubjectCode}|${i.SectionID}`}>
                    <td>{i.missing ? <span className="bad-text">Not in Subjects</span> : i.SubjectName} <span className="sub">{i.SubjectCode}</span></td>
                    <td>{i.SectionID}</td>
                    <td>{i.BranchCode}{i.BranchCode !== t.BranchCode && <span className="sub"> (other dept)</span>}</td>
                    <td className="num">{i.Semester}</td><td>{i.Type || '—'}</td><td className="num">{i.missing ? '?' : i.hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No teaching assignments yet.</p>}

        <h4 className="sub-h">Subjects they asked for</h4>
        {prefs.length ? (
          <div className="grid-scroll short">
            <table className="grid">
              <thead><tr><th>Subject</th><th className="num">Priority</th><th className="num">Experience (yrs)</th><th className="num">Sections given</th></tr></thead>
              <tbody>
                {prefs.map((x) => (
                  <tr key={x.SubjectCode}>
                    <td>{names.get(x.SubjectCode) ?? ''} <span className="sub">{x.SubjectCode}</span></td>
                    <td className="num">{x.Priority}</td><td className="num">{num(x.ExperienceYears)}</td><td className="num">{held.get(x.SubjectCode) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No approved preferences.</p>}

        <h4 className="sub-h">Week</h4>
        {timetable
          ? <p className="muted">Periods in the saved timetable: {days.map((d) => `${d.slice(0, 3)} ${day.get(d) ?? 0}`).join(' · ')}</p>
          : <p className="muted">No timetable generated yet.</p>}
        <p className="muted">Unavailable: {away.length ? away.map((a) => `${a.Day.slice(0, 3)}${a.Period ? ` P${a.Period}` : ' (all day)'}${a.Reason ? `, ${a.Reason}` : ''}`).join(' · ') : 'never'}</p>

        <footer><button className="btn" onClick={onClose}>Close</button></footer>
      </div>
    </div>
  )
}
