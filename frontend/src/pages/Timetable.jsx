import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TERMS } from '../generator'
import { WEEK, breakAfter, effectiveTimings } from '../schema'
import { useStore } from '../store'

const VIEWS = { section: 'Section', teacher: 'Teacher', room: 'Room' }

export default function Timetable() {
  const { db, settings, timetable, generateTimetable, clearTimetable, isAdmin, activeDb } = useStore()
  const [term, setTerm] = useState('all')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ text: '', bad: false })
  const [view, setView] = useState('section')
  const [pick, setPick] = useState('')

  const days = WEEK.filter((d) => settings.schoolDays.includes(d))
  const periods = Array.from({ length: Number(settings.periodsPerDay) || 0 }, (_, i) => i + 1)
  const timings = effectiveTimings(settings)
  const approvedBranches = db.Branches.filter((b) => b._status === 'approved')

  const generate = async () => {
    setBusy(true)
    setMsg({ text: '', bad: false })
    await new Promise((r) => setTimeout(r, 30)) // let the button repaint before the search runs
    const res = await generateTimetable({ term, branch })
    setBusy(false)
    if (res.error) return setMsg({ text: res.error, bad: true })
    const s = res.timetable.stats
    setMsg({ text: `Placed ${s.scheduled} of ${s.demand} weekly periods for ${s.sections} sections.`, bad: false })
    setPick('')
  }

  // choices for the view selector, based on what actually got scheduled
  const options = useMemo(() => {
    if (!timetable) return []
    const key = { section: 'SectionID', teacher: 'TeacherID', room: 'RoomID' }[view]
    const names = view === 'teacher' ? new Map(timetable.entries.map((e) => [e.TeacherID, e.TeacherName])) : null
    return [...new Set(timetable.entries.map((e) => e[key]))].sort().map((v) => ({ value: v, label: names ? `${v} — ${names.get(v)}` : v }))
  }, [timetable, view])
  const selected = options.some((o) => o.value === pick) ? pick : options[0]?.value

  const cells = useMemo(() => {
    const map = new Map()
    if (!timetable || !selected) return map
    const key = { section: 'SectionID', teacher: 'TeacherID', room: 'RoomID' }[view]
    for (const e of timetable.entries) if (e[key] === selected) map.set(`${e.Day}|${e.Period}`, e)
    return map
  }, [timetable, view, selected])

  const detail = (e) => (view === 'section' ? `${e.TeacherName} · ${e.RoomID}` : view === 'teacher' ? `${e.SectionID} · ${e.RoomID}` : `${e.SectionID} · ${e.TeacherName}`)
  const busyCount = timetable ? timetable.entries.length : 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1>🗓️ Timetable</h1>
          <p className="muted">Generated for <strong>{activeDb.name}</strong> from General Settings, Sections, Subjects, Teaching Assignments, Teachers and Rooms. Only approved rows are used.</p>
        </div>
      </div>

      {isAdmin ? (
        <section className="card">
          <h3>Generate</h3>
          <div className="gen-controls">
            <label className="field"><span>Semesters</span>
              <select value={term} onChange={(e) => setTerm(e.target.value)}>{Object.entries(TERMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <label className="field"><span>Branch</span>
              <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">All branches</option>
                {approvedBranches.map((b) => <option key={b._id} value={b.BranchCode}>{b.BranchCode}</option>)}
              </select>
            </label>
            <button className="btn primary" disabled={busy} onClick={generate}>{busy ? 'Generating…' : timetable ? 'Regenerate timetable' : 'Generate timetable'}</button>
            {timetable && <button className="btn danger" disabled={busy} onClick={() => window.confirm('Delete the generated timetable?') && clearTimetable()}>Clear</button>}
          </div>
          <p className="muted">Scoping matters: if there are more classes than room-hours (see Data readiness on Overview), pick odd or even semesters or one branch, otherwise some classes will be reported as unscheduled.</p>
          {msg.text && <p className={msg.bad ? 'errors' : 'ok'} role="status">{msg.text}</p>}
        </section>
      ) : !timetable && <p className="notice">No timetable has been generated yet. An admin can generate one.</p>}

      {timetable && (
        <>
          <div className="tiles gen-stats">
            <div className="tile"><strong>{timetable.stats.scheduled}</strong><span>periods scheduled</span></div>
            <div className="tile"><strong>{timetable.stats.unscheduled}</strong><span>periods not placed</span></div>
            <div className="tile"><strong>{timetable.stats.sections}</strong><span>sections</span></div>
            <div className="tile"><strong>{new Set(timetable.entries.map((e) => e.TeacherID)).size}</strong><span>teachers used</span></div>
          </div>
          <p className="muted gen-meta">Generated {new Date(timetable.generatedAt).toLocaleString()} · {TERMS[timetable.scope.term]}{timetable.scope.branch ? ` · ${timetable.scope.branch}` : ''}{timetable.stats.undersizedLabs ? ` · ${timetable.stats.undersizedLabs} lab session(s) use a lab smaller than the section (batches assumed)` : ''}{timetable.stats.blockChanges ? ` · ${timetable.stats.blockChanges} building change(s) for teachers across the week` : ''}</p>
          {timetable.stats.missingWalk?.length > 0 && (
            <p className="notice">🚶 No travel time entered for {timetable.stats.missingWalk.join(', ')}, so those moves were treated as 0 minutes. Add them under Travel Between Buildings and generate again.</p>
          )}

          <section className="card">
            <div className="view-bar">
              <div className="seg" role="group" aria-label="View by">
                {Object.entries(VIEWS).map(([k, v]) => <button key={k} type="button" aria-pressed={view === k} className={view === k ? 'on' : ''} onClick={() => { setView(k); setPick('') }}>{v}</button>)}
              </div>
              <select value={selected ?? ''} onChange={(e) => setPick(e.target.value)} aria-label={`Choose ${VIEWS[view].toLowerCase()}`}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="count">{busyCount ? `${cells.size} periods per week` : ''}</span>
            </div>

            {options.length ? (
              <div className="avail-wrap">
                <table className="avail tt">
                  <thead><tr><th>Period</th>{days.map((d) => <th key={d}>{d}</th>)}</tr></thead>
                  <tbody>
                    {periods.map((p) => (
                      <Fragment key={p}>
                        <tr>
                          <th scope="row">Period {p}{timings[p]?.start && timings[p]?.end && <small>{timings[p].start}–{timings[p].end}</small>}</th>
                          {days.map((d) => {
                            const e = cells.get(`${d}|${p}`)
                            if (e) {
                              const lab = e.Type === 'Lab'
                              return (
                                <td key={d} className={`slot ${lab ? 'lab' : 'theory'}${e.cont ? ' cont' : ''}`}>
                                  {e.cont ? <small>↑ lab continues</small> : <><b>{e.SubjectName}</b><small>{e.SubjectCode}{lab ? ' · Lab' : ''}</small><small>{detail(e)}</small></>}
                                </td>
                              )
                            }
                            return <td key={d} className={settings.avail[`${d}|${p}`] === 'on' ? 'slot free' : 'slot off'}>{settings.avail[`${d}|${p}`] === 'on' ? '' : '—'}</td>
                          })}
                        </tr>
                        {breakAfter(settings, p) && (
                          <tr className="break-line"><th scope="row">Break</th><td colSpan={days.length}>{breakAfter(settings, p).start}–{breakAfter(settings, p).end}</td></tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">Nothing was scheduled.</p>}
          </section>

          {timetable.unscheduled.length > 0 && (
            <section className="card">
              <h3>Not placed <span className="badge pending">{timetable.unscheduled.length}</span></h3>
              <p className="muted">These classes could not be scheduled. Fix the cause (usually a missing <Link to="/table/TeacherSubjectMap">teaching assignment</Link>, too few rooms or open periods) and regenerate.</p>
              <div className="grid-scroll">
                <table className="grid">
                  <thead><tr><th>Section</th><th>Subject</th><th className="num">Periods</th><th>Reason</th></tr></thead>
                  <tbody>
                    {timetable.unscheduled.slice(0, 200).map((u, i) => (
                      <tr key={i}><td>{u.SectionID}</td><td>{u.SubjectName} <span className="sub">{u.SubjectCode}</span></td><td className="num">{u.periods}</td><td>{u.reason}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {timetable.unscheduled.length > 200 && <p className="muted">Showing the first 200 of {timetable.unscheduled.length}.</p>}
            </section>
          )}
        </>
      )}
    </>
  )
}
