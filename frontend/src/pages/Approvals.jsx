import { Link } from 'react-router-dom'
import { TABLES, TABLE_ORDER } from '../schema'
import { useStore } from '../store'

export default function Approvals() {
  const { db, isAdmin, setStatus, pendingCount } = useStore()
  if (!isAdmin) return <p className="notice">Only admins can review entries.</p>

  const approveAll = () => TABLE_ORDER.forEach((t) => {
    const ids = db[t].filter((r) => r._status === 'pending').map((r) => r._id)
    if (ids.length) setStatus(t, ids, 'approved')
  })

  return (
    <>
      <div className="page-head">
        <div>
          <h1>✅ Pending approvals</h1>
          <p className="muted">Entries submitted by feeders. Only approved rows are used for timetable generation and the final export.</p>
        </div>
        {pendingCount > 0 && <button className="btn primary" onClick={approveAll}>Approve all ({pendingCount})</button>}
      </div>

      {pendingCount === 0 && <p className="notice info">Nothing waiting for review. 🎉</p>}

      {TABLE_ORDER.map((name) => {
        const rows = db[name].filter((r) => r._status === 'pending')
        if (!rows.length) return null
        const t = TABLES[name]
        return (
          <section key={name} className="card">
            <h3><Link to={`/table/${name}`}>{t.icon} {t.label}</Link> <span className="badge pending">{rows.length}</span></h3>
            <div className="grid-scroll">
              <table className="grid">
                <thead><tr>{t.columns.map((c) => <th key={c.key}>{c.label}</th>)}<th>By</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r._id}>
                      {t.columns.map((c) => <td key={c.key} className={c.type === 'number' ? 'num' : ''}>{r[c.key] ?? '—'}</td>)}
                      <td className="sub">{r._by}</td>
                      <td className="act">
                        <button className="btn sm primary" onClick={() => setStatus(name, [r._id], 'approved')}>Approve</button>
                        <button className="btn sm danger" onClick={() => setStatus(name, [r._id], 'rejected')}>Reject</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </>
  )
}
