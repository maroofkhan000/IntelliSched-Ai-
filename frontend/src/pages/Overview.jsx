import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Tilt from '../components/Tilt'
import { exportJson, exportWorkbook, parseWorkbook } from '../excel'
import { computeHealth } from '../health'
import { TABLES, TABLE_ORDER } from '../schema'
import { useStore } from '../store'

const SETUP = ['Branches', 'TimeSlots', 'Rooms', 'Subjects', 'Sections', 'Teachers', 'TeacherSubjectMap']

export default function Overview() {
  const { db, settings, isAdmin, importRows, clearAll, activeDb, confirm } = useStore()
  const fileRef = useRef(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const h = computeHealth(db)
  const total = TABLE_ORDER.reduce((n, t) => n + db[t].length, 0)

  // An import merges into the open database: new rows are added and any row with the same key
  // (a teacher ID, a time slot's day + period…) is overwritten. On a database that already has
  // data, say so and ask first.
  const runImport = async (getBuffer, replace, what) => {
    setBusy(true)
    setMsg('')
    try {
      const { data, report } = await parseWorkbook(await getBuffer())
      if (!Object.keys(report).length) throw new Error('No recognised sheets found (expected Branches, Sections, Subjects, Teachers, Rooms, TimeSlots…)')
      if (total > 0) {
        const keyOf = (t, r) => TABLES[t].key.map((k) => String(r[k] ?? '').trim().toUpperCase()).join('|')
        const clash = Object.entries(data).map(([t, rows]) => {
          const have = new Set(db[t].map((r) => keyOf(t, r)))
          return [t, rows.filter((r) => have.has(keyOf(t, r))).length]
        }).filter(([, n]) => n)
        const ok = await confirm({
          title: `Import ${what} into "${activeDb.name}"?`,
          message: `This adds ${Object.entries(report).map(([k, v]) => `${v} ${TABLES[k]?.label.toLowerCase() ?? k}`).join(', ')} to your ${total} existing rows.${clash.length ? ` It also OVERWRITES ${clash.map(([t, n]) => `${n} ${TABLES[t].label.toLowerCase()}`).join(', ')} that you already have.` : ''} To try it without touching your data, create a new empty database first (the + next to the database name).`,
          confirmLabel: 'Import anyway',
        })
        if (!ok) return
      }
      await importRows(data, { replace })
      setMsg(`Imported: ${Object.entries(report).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
    } catch (e) {
      setMsg(`Import failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const onFile = (e) => {
    const f = e.target.files[0]
    e.target.value = ''
    if (f) runImport(() => f.arrayBuffer(), false, `"${f.name}"`)
  }
  const loadSample = () => runImport(async () => {
    const res = await fetch('/timetable_dataset.xlsx')
    if (!res.ok) throw new Error('sample file not found')
    return res.arrayBuffer()
  }, false, 'the sample dataset')

  const checks = [
    { ok: h.counts.sections > 0 && h.counts.subjects > 0 && h.counts.teachers > 0 && h.counts.rooms > 0 && h.counts.slots > 0, label: 'Core tables have data', detail: 'Sections, Subjects, Teachers, Rooms and Time Slots must each have at least one approved row.' },
    { ok: h.unassigned.length === 0 && h.counts.sections > 0, label: `Every section-subject has a teacher`, detail: h.unassigned.length ? `${h.unassigned.length} section-subject pairs unassigned, e.g. ${h.unassigned.slice(0, 3).map((u) => `${u.section}/${u.subject}`).join(', ')}` : 'All covered.' },
    { ok: h.overloaded.length === 0, label: 'No teacher exceeds max weekly load', detail: h.overloaded.length ? h.overloaded.slice(0, 4).map((o) => `${o.id} ${o.load}/${o.max}h`).join(', ') : 'All within limits.' },
    { ok: h.tooBig.length === 0, label: 'Every section fits in the largest classroom', detail: h.tooBig.length ? `${h.tooBig.length} sections larger than ${h.maxClass} seats` : 'All fit.' },
    { ok: !h.hasLab || h.labRooms > 0, label: 'Lab rooms exist for lab subjects', detail: h.hasLab && !h.labRooms ? 'Lab subjects exist but no Lab room is defined.' : 'OK.' },
    { ok: h.demand <= h.supply || h.supply === 0, warn: true, label: 'Room-hours cover weekly demand', detail: `Demand ${h.demand} session-hours vs. supply ${h.supply} room-hours (${h.supply ? (h.demand / h.supply).toFixed(2) : '–'}×). ${h.demand > h.supply ? 'Scope the term (e.g. odd or even semesters only) before generating.' : ''}` },
    { ok: h.unknownBlocks.length === 0, warn: true, label: 'Every room is in a listed building', detail: !h.blocks.length ? 'No buildings listed yet: walking time between blocks is not checked.' : h.unknownBlocks.length ? `Rooms use block(s) ${h.unknownBlocks.join(', ')} that are not in Buildings.` : 'All rooms are in listed buildings.' },
    { ok: h.missingWalk.length === 0, warn: true, label: 'Walking time entered between every pair of buildings', detail: h.missingWalk.length ? `Missing: ${h.missingWalk.slice(0, 6).join(', ')}${h.missingWalk.length > 6 ? ` and ${h.missingWalk.length - 6} more` : ''}. Missing pairs count as 0 minutes.` : h.blocks.length > 1 ? 'All pairs entered.' : 'Only one building (or none): nothing to walk between.' },
    { ok: h.noPrefs.length === 0, warn: true, label: 'Teachers have submitted subject priorities', detail: h.noPrefs.length ? `${h.noPrefs.length} teachers have no preferences yet.` : 'All teachers have preferences.' },
  ]

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{activeDb.name}</h1>
          <p className="muted">{isAdmin ? 'Admin console — manage every table, review feeder entries and export the final Excel database.' : 'Enter data table by table. An admin reviews your entries before they are used.'}</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => exportWorkbook(db, { name: activeDb.name })} disabled={!total}>⬇ Export full database (.xlsx)</button>
          <button className="btn" onClick={() => exportJson(db, settings, { name: activeDb.name })} disabled={!total} title="Same data with settings and number types kept — the input format for the ML pipeline">⬇ Export for ML (.json)</button>
        </div>
      </div>

      <div className="tiles">
        {TABLE_ORDER.filter((n) => n !== 'TeacherPreferences').map((n) => {
          const pend = db[n].filter((r) => r._status === 'pending').length
          return (
            <Tilt key={n} to={`/table/${n}`} className="tile">
              <span className="ico">{TABLES[n].icon}</span>
              <strong>{db[n].length}</strong>
              <span>{TABLES[n].label}</span>
              {pend > 0 && <span className="badge pending">{pend} pending</span>}
              {TABLES[n].adminOnly && !isAdmin && <span className="lock" title="Admin only">🔒</span>}
            </Tilt>
          )
        })}
      </div>

      <section className="card guide">
        <h3>Set up by hand</h3>
        <p className="muted">Fill the tables in this order. Each one depends on the ones before it.</p>
        <ol className="steps">
          {SETUP.map((n, i) => {
            const c = db[n].length
            return (
              <li key={n} className={c ? 'done' : ''}>
                <Link to={`/table/${n}`}>
                  <span className="num">{c ? '✓' : i + 1}</span>
                  <span>{TABLES[n].label}</span>
                  <small>{c ? `${c} rows` : 'empty'}</small>
                </Link>
              </li>
            )
          })}
        </ol>
      </section>

      {isAdmin && (
        <section className="card">
          <h3>Import / reset</h3>
          <p className="muted">Import an Excel workbook whose sheet names match the tables (same layout as <code>timetable_dataset.xlsx</code>). Rows with the same key are updated.</p>
          <div className="row-gap">
            <button className="btn" disabled={busy} onClick={loadSample}>Load sample dataset</button>
            <button className="btn" disabled={busy} onClick={() => fileRef.current.click()}>Import .xlsx…</button>
            <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={onFile} />
            <button className="btn danger" disabled={!total} onClick={clearAll}>Clear everything</button>
          </div>
          {msg && <p className={msg.startsWith('Import failed') ? 'errors' : 'ok'}>{msg}</p>}
        </section>
      )}

      <section className="card">
        <h3>Data readiness</h3>
        <p className="muted">Checked against approved rows only.</p>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? 'pass' : c.warn ? 'warn' : 'fail'}>
              <span className="mark">{c.ok ? '✓' : c.warn ? '!' : '✕'}</span>
              <div><strong>{c.label}</strong><small>{c.detail}</small></div>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
