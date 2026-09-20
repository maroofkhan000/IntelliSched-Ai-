import { useState } from 'react'
import { useStore } from '../store'

// Sidebar switcher + modal to create / rename / delete databases.
export default function DbManager() {
  const { databases, activeDb, isAdmin, createDatabase, switchDatabase, renameDatabase, deleteDatabase } = useStore()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  const create = (e) => {
    e.preventDefault()
    createDatabase(name)
    setName('')
    setOpen(false)
  }

  return (
    <div className="dbswitch">
      <span className="nav-title">Database</span>
      <div className="dbrow">
        <select value={activeDb.id} onChange={(e) => switchDatabase(e.target.value)} aria-label="Active database">
          {databases.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button className="btn sm" onClick={() => setOpen(true)} title="Manage databases">{isAdmin ? '＋' : '⚙'}</button>
      </div>

      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h3>Databases</h3>
              <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </header>

            {isAdmin && (
              <form className="newdb" onSubmit={create}>
                <label className="field">
                  <span>Create a new blank database (enter everything manually)</span>
                  <div className="row-gap tight">
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Odd Semester 2026-27" autoFocus />
                    <button className="btn primary" type="submit">Create</button>
                  </div>
                </label>
              </form>
            )}

            <ul className="dblist">
              {databases.map((d) => (
                <li key={d.id} className={d.id === activeDb.id ? 'active' : ''}>
                  <div>
                    <strong>{d.name}</strong>
                    <small>{d.rows} rows · created {new Date(d.createdAt).toLocaleDateString()}</small>
                  </div>
                  <div className="row-gap tight">
                    {d.id !== activeDb.id && <button className="btn sm" onClick={() => { switchDatabase(d.id); setOpen(false) }}>Open</button>}
                    {d.id === activeDb.id && <span className="badge approved">active</span>}
                    {isAdmin && <button className="btn sm" onClick={() => { const n = window.prompt('Rename database', d.name); if (n) renameDatabase(d.id, n) }}>Rename</button>}
                    {isAdmin && databases.length > 1 && (
                      <button className="btn sm danger" onClick={() => window.confirm(`Delete "${d.name}" and all its data?`) && deleteDatabase(d.id)}>Delete</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
