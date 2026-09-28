import { useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import AssignmentTools from '../components/AssignmentTools'
import DataTable from '../components/DataTable'
import RowForm from '../components/RowForm'
import { exportSheet } from '../excel'
import { TABLES } from '../schema'
import { useStore } from '../store'

export default function TablePage() {
  const { name } = useParams()
  const { db, canEditTable, isAdmin } = useStore()
  const [form, setForm] = useState(null) // null | { row? }
  const t = TABLES[name]
  // preferences are entered inside the teacher form, so there is no separate page for them
  if (name === 'TeacherPreferences') return <Navigate to="/table/Teachers" replace />
  if (!t) return <Navigate to="/" replace />
  const editable = canEditTable(name)

  return (
    <>
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
