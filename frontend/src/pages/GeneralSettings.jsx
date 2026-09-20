import { Fragment, useState } from 'react'
import { WEEK, breakAfter, effectiveTimings } from '../schema'
import { useStore } from '../store'

const ORDERED = (days) => WEEK.filter((d) => days.includes(d))

export default function GeneralSettings() {
  const { settings, saveSettings, applyTimeSlots, isAdmin, activeDb, db } = useStore()
  const [showTimings, setShowTimings] = useState(true)
  const [msg, setMsg] = useState({ text: '', bad: false })
  const { schoolDays, periodsPerDay, timingMode, auto, avail } = settings
  const timings = effectiveTimings(settings)
  const isAuto = timingMode === 'auto'
  const days = ORDERED(schoolDays)
  const daysOff = WEEK.filter((d) => !schoolDays.includes(d))
  const periods = Array.from({ length: periodsPerDay }, (_, i) => i + 1)

  const toggleDay = (d) => saveSettings({ schoolDays: schoolDays.includes(d) ? schoolDays.filter((x) => x !== d) : [...schoolDays, d] })
  const setPeriods = (v) => {
    saveSettings({ periodsPerDay: v === '' ? 0 : Math.min(12, Math.max(1, Math.round(Number(v)) || 1)) })
  }
  const setTime = (p, which, v) => saveSettings({ timings: { ...settings.timings, [p]: { ...settings.timings[p], [which]: v } } })
  const setAuto = (patch) => saveSettings({ auto: { ...auto, ...patch } })
  const setBreak = (i, patch) => setAuto({ breaks: auto.breaks.map((b, j) => (j === i ? { ...b, ...patch } : b)) })
  const addBreak = () => setAuto({ breaks: [...auto.breaks, { after: '', minutes: '' }] })
  const delBreak = (i) => setAuto({ breaks: auto.breaks.filter((_, j) => j !== i) })
  // click cycles: not set -> available -> time off -> not set
  const toggleCell = (d, p) => {
    const k = `${d}|${p}`
    const { [k]: was, ...rest } = avail
    saveSettings({ avail: was === 'on' ? { ...rest, [k]: 'off' } : was === 'off' ? rest : { ...rest, [k]: 'on' } })
  }
  const setAll = (v) => saveSettings({ avail: v ? Object.fromEntries(days.flatMap((d) => periods.map((p) => [`${d}|${p}`, v]))) : {} })

  const apply = async () => {
    if (db.TimeSlots.length && !window.confirm(`Replace the ${db.TimeSlots.length} existing Time Slots with the grid below?`)) return
    const err = await applyTimeSlots()
    setMsg(err ? { text: err, bad: true } : { text: 'Time Slots updated from these settings.', bad: false })
  }

  const available = days.reduce((n, d) => n + periods.filter((p) => avail[`${d}|${p}`] === 'on').length, 0)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>General Settings</h1>
          <p className="muted">Basic timetable parameters for <strong>{activeDb.name}</strong>: which days run, how many periods there are, when they start and which slots are blocked.{!isAdmin && ' Only an admin can apply them to the Time Slots table.'}</p>
        </div>
        {isAdmin && <div className="head-actions"><button className="btn primary" onClick={apply}>Apply to Time Slots</button></div>}
      </div>
      {msg.text && <p className={msg.bad ? 'errors' : 'ok'}>{msg.text}</p>}

      <section className="card">
        <h3>Days</h3>
        <p className="muted">Select which days of the week are school days. The remaining days are days off.</p>
        <div className="day-picker">
          {WEEK.map((d) => {
            const on = schoolDays.includes(d)
            return (
              <button key={d} type="button" aria-pressed={on} className={`day-chip${on ? ' on' : ''}`} onClick={() => toggleDay(d)}>
                <span>{d.slice(0, 3)}</span>
                <i>{on ? '✓' : '☀'}</i>
              </button>
            )
          })}
        </div>
        <div className="day-split">
          <div className="day-box on"><h4>✓ School Days</h4><div>{days.length ? days.map((d) => <span key={d} className="tag">{d}</span>) : <span className="muted">None selected</span>}</div></div>
          <div className="day-box"><h4>☀ Days Off</h4><div>{daysOff.length ? daysOff.map((d) => <span key={d} className="tag">{d}</span>) : <span className="muted">None</span>}</div></div>
        </div>
      </section>

      <section className="card">
        <h3>Periods</h3>
        <label className="field narrow">
          <span>Periods Per Day</span>
          <input type="number" min={1} max={12} value={periodsPerDay || ''} placeholder="Enter number of periods" onChange={(e) => setPeriods(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="Timing mode">
          <button type="button" aria-pressed={!isAuto} className={!isAuto ? 'on' : ''} onClick={() => saveSettings({ timingMode: 'manual' })}>Manual</button>
          <button type="button" aria-pressed={isAuto} className={isAuto ? 'on' : ''} onClick={() => saveSettings({ timingMode: 'auto' })}>Automatic</button>
        </div>
        {isAuto && (
          <div className="auto-box">
            <p className="muted">Give the first period start time and how long each period lasts. Add breaks to push later periods back.</p>
            <div className="fields">
              <label className="field"><span>First period starts</span><input type="time" value={auto.start} onChange={(e) => setAuto({ start: e.target.value })} /></label>
              <label className="field"><span>Period length (minutes)</span><input type="number" min={1} max={240} placeholder="e.g. 50" value={auto.duration} onChange={(e) => setAuto({ duration: e.target.value })} /></label>
            </div>
            <h4 className="sub-h">Breaks</h4>
            {auto.breaks.map((b, i) => (
              <div key={i} className="break-row">
                <label className="field"><span>After period</span>
                  <select value={b.after} onChange={(e) => setBreak(i, { after: e.target.value })}>
                    <option value="">Select…</option>
                    {periods.map((p) => <option key={p} value={p}>Period {p}</option>)}
                  </select>
                </label>
                <label className="field"><span>Break length (minutes)</span><input type="number" min={1} max={180} placeholder="e.g. 15" value={b.minutes} onChange={(e) => setBreak(i, { minutes: e.target.value })} /></label>
                <button type="button" className="link danger" onClick={() => delBreak(i)}>Remove</button>
              </div>
            ))}
            <button type="button" className="btn sm" disabled={!periodsPerDay} onClick={addBreak}>+ Add break</button>
          </div>
        )}
        {periods.length > 0 && (
          <button type="button" className="link toggle" onClick={() => setShowTimings((v) => !v)}>{showTimings ? '⌃ Hide Period Timings' : '⌄ Show Period Timings'}</button>
        )}
        {showTimings && periods.length > 0 && (
          <div className="timings">
            {periods.map((p) => (
              <Fragment key={p}>
              <div className="timing-row">
                <strong>Period {p}</strong>
                {isAuto ? (
                  <>
                    <span className="calc">{timings[p]?.start ?? '--:--'}</span>
                    <span className="calc">{timings[p]?.end ?? '--:--'}</span>
                  </>
                ) : (
                  <>
                    <input type="time" aria-label={`Period ${p} start`} value={timings[p]?.start ?? ''} onChange={(e) => setTime(p, 'start', e.target.value)} />
                    <input type="time" aria-label={`Period ${p} end`} value={timings[p]?.end ?? ''} onChange={(e) => setTime(p, 'end', e.target.value)} />
                  </>
                )}
              </div>
              {breakAfter(settings, p) && (
                <div className="timing-row break">
                  <strong>Break <small>{breakAfter(settings, p).minutes} min</small></strong>
                  <span className="calc">{breakAfter(settings, p).start}</span>
                  <span className="calc">{breakAfter(settings, p).end}</span>
                </div>
              )}
              </Fragment>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h3>Period Availability</h3>
        <p className="muted">Click a cell to mark it available, click again for time off (breaks, assembly, lunch), and once more to clear it. Only cells marked available become Time Slots — {available} of {days.length * periodsPerDay} marked.</p>
        <div className="legend">
          <span><i className="sw ok">✓</i> Available</span>
          <span><i className="sw off">✕</i> Time Off</span>
          <span className="legend-actions"><button className="link" onClick={() => setAll('on')}>All available</button><button className="link" onClick={() => setAll('off')}>All time off</button><button className="link" onClick={() => setAll(null)}>Clear</button></span>
        </div>
        {days.length && periods.length ? (
          <div className="avail-wrap">
            <table className="avail">
              <thead><tr><th>Period/Day</th>{days.map((d) => <th key={d}>{d}</th>)}</tr></thead>
              <tbody>
                {periods.map((p) => (
                  <Fragment key={p}>
                  <tr>
                    <th scope="row">Period {p}{timings[p]?.start && timings[p]?.end && <small>{timings[p].start}–{timings[p].end}</small>}</th>
                    {days.map((d) => {
                      const v = avail[`${d}|${p}`]
                      return (
                        <td key={d}>
                          <button type="button" className={`cell ${v ?? 'unset'}`} aria-label={`${d} period ${p}: ${v === 'on' ? 'available' : v === 'off' ? 'time off' : 'not set'}`} onClick={() => toggleCell(d, p)}>{v === 'on' ? '✓' : v === 'off' ? '✕' : ''}</button>
                        </td>
                      )
                    })}
                  </tr>
                  {breakAfter(settings, p) && (
                    <tr className="break-line"><th scope="row">Break</th><td colSpan={days.length}>{breakAfter(settings, p).start}–{breakAfter(settings, p).end} · {breakAfter(settings, p).minutes} min</td></tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">Select the school days and enter periods per day to set availability.</p>}
      </section>
    </>
  )
}
