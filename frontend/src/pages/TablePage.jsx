import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import AssignmentTools from '../components/AssignmentTools'
import DataTable from '../components/DataTable'
import RowForm from '../components/RowForm'
import { exportSheet } from '../excel'
import { TABLES } from '../schema'
import { useStore } from '../store'

// tables that live together on one page, shown as tabs
const TAB_GROUPS = [['Teachers', 'TeacherPreferences']]

export default function TablePage() {
  const { name } = useParams()
  const { db, canEditTable, isAdmin } = useStore()
  const [form, setForm] = useState(null) // null | { row? }
  const t = TABLES[name]
  if (!t) return <Navigate to="/" replace />
  const editable = canEditTable(name)

  const tabs = TAB_GROUPS.find((g) => g.includes(name))

  return (
    <>
      {tabs && (
        <div className="seg tabs" role="tablist">
          {tabs.map((k) => <Link key={k} to={`/table/${k}`} role="tab" aria-selected={k === name} className={k === name ? 'on' : ''}>{TABLES[k].icon} {TABLES[k].label} <span className="cnt">{db[k].length}</span></Link>)}
        </div>
      )}
      <div className="page-head">
        <div>
          <h1>{t.icon} {t.label}</h1>
          <p className="muted">{t.hint}</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => exportSheet(name, db[name])}>⬇ Export Excel</button>
          {editable && <button className="btn primary" onClick={() => setForm({})}>＋ Add row</button>}
        </div>
      </div>
      {!editable && <p className="notice">🔒 This table is maintained by the admin. You can view it but not change it.</p>}
      {editable && !isAdmin && <p className="notice info">Rows you add or edit are marked <b>pending</b> until an admin approves them.</p>}
      {name === 'TeacherSubjectMap' && <AssignmentTools />}
      <DataTable key={name} table={name} onEdit={(row) => setForm({ row })} />
      {form && <RowForm key={form.row?._id ?? 'new'} table={name} row={form.row} onClose={() => setForm(null)} />}
    </>
  )
}
