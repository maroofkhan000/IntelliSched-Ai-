import { useMemo, useState } from 'react'
import { TABLES } from '../schema'
import { useStore } from '../store'

const PAGE = 50

// Excel-like read grid with search, filter, sort, paging and row selection.
export default function DataTable({ table, onEdit }) {
  const { db, isAdmin, canEditTable, canDeleteRow, deleteRows, setStatus } = useStore()
  const t = TABLES[table]
  const rows = db[table]
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('')
  const [status, setStatusFilter] = useState('')
  const [sort, setSort] = useState({ key: null, dir: 1 })
  const [page, setPage] = useState(0)
  const [sel, setSel] = useState(new Set())

  const lookup = useMemo(() => {
    const m = {}
    for (const c of t.columns) if (c.type === 'ref' && c.refLabel) m[c.key] = new Map((db[c.ref] || []).map((r) => [String(r[c.refKey]), r[c.refLabel]]))
    return m
  }, [db, t])

  const filterOptions = useMemo(() => (t.filterBy ? [...new Set(rows.map((r) => r[t.filterBy]))].sort() : []), [rows, t])

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let out = rows.filter((r) => (!filter || r[t.filterBy] === filter) && (!status || r._status === status))
    if (needle) {
      out = out.filter((r) => t.columns.some((c) => `${r[c.key] ?? ''} ${lookup[c.key]?.get(String(r[c.key])) ?? ''}`.toLowerCase().includes(needle)))
    }
    if (sort.key) {
      out = [...out].sort((a, b) => {
        const x = a[sort.key] ?? ''
        const y = b[sort.key] ?? ''
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir
      })
    }
    return out
  }, [rows, q, filter, status, sort, t, lookup])

  const pages = Math.max(1, Math.ceil(view.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const slice = view.slice(cur * PAGE, cur * PAGE + PAGE)
  const editable = canEditTable(table)

  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allOnPage = slice.length > 0 && slice.every((r) => sel.has(r._id))
  const togglePage = () => setSel((s) => { const n = new Set(s); slice.forEach((r) => (allOnPage ? n.delete(r._id) : n.add(r._id))); return n })
  const selRows = rows.filter((r) => sel.has(r._id))
  const deletable = selRows.filter((r) => canDeleteRow(table, r))

  const bulkDelete = () => {
    if (!deletable.length || !window.confirm(`Delete ${deletable.length} row(s)?`)) return
    deleteRows(table, deletable.map((r) => r._id))
    setSel(new Set())
  }
  const bulkApprove = () => { setStatus(table, selRows.map((r) => r._id), 'approved'); setSel(new Set()) }

  const cell = (r, c) => {
    const v = r[c.key]
    if (v === '' || v == null) return <span className="empty">—</span>
    const label = lookup[c.key]?.get(String(v))
    return label ? <>{v} <span className="sub">{label}</span></> : v
  }

  const head = (c) => (
    <th key={c.key} onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }))} className={c.type === 'number' ? 'num' : ''}>
      {c.label}
      <i>{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</i>
    </th>
  )

  return (
    <div className="grid-wrap">
      <div className="grid-tools">
        <input className="search" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} />
        {t.filterBy && (
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0) }}>
            <option value="">All {t.columns.find((c) => c.key === t.filterBy).label}s</option>
            {filterOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        <select value={status} onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}>
          <option value="">All status</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
        </select>
        <span className="count">{view.length} of {rows.length} rows</span>
        {sel.size > 0 && (
          <span className="bulk">
            {sel.size} selected
            {isAdmin && <button className="btn sm" onClick={bulkApprove}>Approve</button>}
            <button className="btn sm danger" disabled={!deletable.length} onClick={bulkDelete}>Delete{deletable.length !== sel.size ? ` (${deletable.length})` : ''}</button>
          </span>
        )}
      </div>

      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum"><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select page" /></th>
              {t.columns.map(head)}
              <th>Status</th>
              <th>Entered by</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 && (
              <tr><td colSpan={t.columns.length + 4} className="none">{rows.length ? 'No rows match your filters.' : 'No data yet — add a row or import an Excel file.'}</td></tr>
            )}
            {slice.map((r, i) => (
              <tr key={r._id} className={sel.has(r._id) ? 'selected' : ''}>
                <td className="rownum">
                  <input type="checkbox" checked={sel.has(r._id)} onChange={() => toggle(r._id)} aria-label="Select row" />
                  <span>{cur * PAGE + i + 1}</span>
                </td>
                {t.columns.map((c) => <td key={c.key} className={c.type === 'number' ? 'num' : ''}>{cell(r, c)}</td>)}
                <td><span className={`badge ${r._status}`}>{r._status}</span></td>
                <td className="sub">{r._by}</td>
                {editable && (
                  <td className="act">
                    <button className="link" onClick={() => onEdit(r)}>Edit</button>
                    {canDeleteRow(table, r) && (
                      <button className="link danger" onClick={() => window.confirm('Delete this row?') && deleteRows(table, [r._id])}>Delete</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager">
          <button className="btn sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹ Prev</button>
          <span>Page {cur + 1} / {pages}</span>
          <button className="btn sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next ›</button>
        </div>
      )}
    </div>
  )
}
