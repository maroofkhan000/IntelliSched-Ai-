import { useMemo, useState } from 'react'
import { rankTeachers, suggestAssignments, teacherLoads } from '../assigner'
import { TERMS } from '../generator'
import { useStore } from '../store'

// Shown above the Teaching Assignments table: who wants each subject (priority order)
// and an auto-assign that fills the gaps from Teacher Preferences.
export default function AssignmentTools() {
  const { db, isAdmin, importRows } = useStore()
  const [subject, setSubject] = useState('')
  const [auto, setAuto] = useState(null) // null | { scope, fallback, result }
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ text: '', bad: false })

  const loads = useMemo(() => teacherLoads(db), [db])
  const approvedSubjects = db.Subjects.filter((s) => s._status === 'approved')
  const codesWithPrefs = new Set(db.TeacherPreferences.filter((p) => p._status === 'approved').map((p) => p.SubjectCode))
  const subjectChoices = [...new Map(approvedSubjects.filter((s) => codesWithPrefs.has(s.SubjectCode)).map((s) => [s.SubjectCode, s])).values()].sort((a, b) => a.SubjectCode.localeCompare(b.SubjectCode))
  const code = subjectChoices.some((s) => s.SubjectCode === subject) ? subject : subjectChoices[0]?.SubjectCode
  const ranked = code ? rankTeachers(db, code, loads) : []

  const openAuto = () => setAuto({ scope: { term: 'all', branch: '' }, fallback: false, result: null })
  const preview = () => setAuto((a) => ({ ...a, result: suggestAssignments({ db, scope: a.scope, fallback: a.fallback }) }))
  const apply = async () => {
    setBusy(true)
    try {
      const rows = auto.result.assignments.map(({ TeacherID, SubjectCode, SectionID }) => ({ TeacherID, SubjectCode, SectionID }))
      await importRows({ TeacherSubjectMap: rows })
      setMsg({ text: `Assigned ${rows.length} section-subject pairs.`, bad: false })
      setAuto(null)
    } catch (e) {
      setMsg({ text: e.message, bad: true })
    }
    setBusy(false)
  }

  const setScope = (patch) => setAuto((a) => ({ ...a, result: null, scope: { ...a.scope, ...patch } }))
  const r = auto?.result

  return (
    <>
      <section className="card">
        <div className="tools-head">
          <div>
            <h3>Teacher priority order</h3>
            <p className="muted">Who asked to teach a subject, best claim first: their priority, then experience and published papers (entered in Teacher Preferences), then the lighter load.</p>
          </div>
          {isAdmin && <button className="btn primary" onClick={openAuto}>✨ Auto-assign by preference</button>}
        </div>
        {msg.text && <p className={msg.bad ? 'errors' : 'ok'} role="status">{msg.text}</p>}

        {subjectChoices.length ? (
          <>
            <label className="field narrow">
              <span>Subject</span>
              <select value={code} onChange={(e) => setSubject(e.target.value)}>
                {subjectChoices.map((s) => <option key={s.SubjectCode} value={s.SubjectCode}>{s.SubjectCode} — {s.SubjectName}</option>)}
              </select>
            </label>
            <div className="grid-scroll">
              <table className="grid">
                <thead><tr><th>#</th><th>Teacher</th><th>Type</th><th className="num">Priority</th><th className="num">Experience (yrs)</th><th className="num">Papers</th><th className="num">Load</th></tr></thead>
                <tbody>
                  {ranked.map((c, i) => (
                    <tr key={c.teacher._id}>
                      <td>{i + 1}</td>
                      <td>{c.teacher.TeacherID} — {c.teacher.Name}</td>
                      <td>{c.teacher.TeacherType ?? '—'}</td>
                      <td className="num">{c.priority === 9 ? '—' : c.priority}</td>
                      <td className="num">{c.years}</td>
                      <td className="num">{c.papers}</td>
                      <td className="num">{c.load}/{c.max}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : <p className="notice info">No approved teacher preferences yet. Add them under Teacher Preferences to see the priority order here.</p>}
      </section>

      {auto && (
        <div className="modal-backdrop" onMouseDown={() => setAuto(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h3>Auto-assign by preference</h3>
              <button className="icon-btn" onClick={() => setAuto(null)} aria-label="Close">✕</button>
            </header>
            <p className="muted">Fills only the section-subject pairs that have no teacher yet. Existing assignments are kept and count toward each teacher's weekly load. Nothing is saved until you press Apply.</p>
            <div className="gen-controls">
              <label className="field"><span>Semesters</span>
                <select value={auto.scope.term} onChange={(e) => setScope({ term: e.target.value })}>{Object.entries(TERMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <label className="field"><span>Branch</span>
                <select value={auto.scope.branch} onChange={(e) => setScope({ branch: e.target.value })}>
                  <option value="">All branches</option>
                  {db.Branches.filter((b) => b._status === 'approved').map((b) => <option key={b._id} value={b.BranchCode}>{b.BranchCode}</option>)}
                </select>
              </label>
              <button className="btn" onClick={preview}>Preview</button>
            </div>
            <label className="check"><input type="checkbox" checked={auto.fallback} onChange={(e) => setAuto((a) => ({ ...a, result: null, fallback: e.target.checked }))} /> If nobody asked for a subject, use the least-loaded teacher of that branch</label>

            {r && (
              <>
                <p className={r.unassigned.length ? 'notice' : 'ok'}>{r.assignments.length} of {r.considered} pairs can be assigned{r.unassigned.length ? `; ${r.unassigned.length} cannot` : ''}.</p>
                {r.assignments.length > 0 && (
                  <div className="grid-scroll short">
                    <table className="grid">
                      <thead><tr><th>Section</th><th>Subject</th><th>Teacher</th><th className="num">Priority</th><th className="num">Yrs</th><th className="num">Papers</th></tr></thead>
                      <tbody>
                        {r.assignments.slice(0, 300).map((a) => (
                          <tr key={`${a.SectionID}|${a.SubjectCode}`}>
                            <td>{a.SectionID}</td><td>{a.SubjectName} <span className="sub">{a.SubjectCode}</span></td>
                            <td>{a.TeacherID} — {a.TeacherName}{a.note && <span className="sub"> ({a.note})</span>}</td>
                            <td className="num">{a.priority ?? '—'}</td><td className="num">{a.years}</td><td className="num">{a.papers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {r.unassigned.length > 0 && (
                  <details>
                    <summary>{r.unassigned.length} pairs left unassigned</summary>
                    <ul className="errors">{r.unassigned.slice(0, 100).map((u) => <li key={`${u.SectionID}|${u.SubjectCode}`}>{u.SectionID} · {u.SubjectName} ({u.SubjectCode}) — {u.reason}</li>)}</ul>
                  </details>
                )}
              </>
            )}
            <footer>
              <button className="btn ghost" onClick={() => setAuto(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || !r?.assignments.length} onClick={apply}>{busy ? 'Saving…' : `Apply ${r?.assignments.length ?? ''} assignments`}</button>
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
