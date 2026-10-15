import { useState } from 'react'
import { useStore } from '../store'

// The one dialog every delete goes through: confirms, and asks for the admin password when a
// big delete (more than 10 rows, or a whole table) needs it.
export default function ConfirmDialog() {
  const { dialog, answerDialog } = useStore()
  const [p, setP] = useState('')
  if (!dialog) return null

  const done = (v) => { setP(''); answerDialog(v) }
  const cancel = () => done(null)

  return (
    <div className="modal-backdrop" onMouseDown={cancel} onKeyDown={(e) => e.key === 'Escape' && cancel()}>
      <div className="modal confirm" role="alertdialog" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h3 id="confirm-title">{dialog.title}</h3>
          <button className="icon-btn" onClick={cancel} aria-label="Close">✕</button>
        </header>
        <form onSubmit={(e) => { e.preventDefault(); if (!dialog.password || p) done({ password: dialog.password ? p : undefined }) }}>
          <p>{dialog.message}</p>
          {dialog.password && (
            <label className="field">
              <span>Admin password</span>
              <input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="off" autoFocus />
              <small className="sub">Needed to delete more than 10 rows, or a whole table, at once.</small>
            </label>
          )}
          {dialog.error && <p className="errors">{dialog.error}</p>}
          <footer>
            <button className="btn" type="button" onClick={cancel} autoFocus={!dialog.password}>Cancel</button>
            <button className="btn danger" type="submit" disabled={dialog.password && !p}>{dialog.confirmLabel}</button>
          </footer>
        </form>
      </div>
    </div>
  )
}
