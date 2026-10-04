import { useState } from 'react'
import { useStore } from '../store'

// Asks for the admin password before a big delete (more than 10 rows, or a whole table).
export default function PasswordPrompt() {
  const { pwAsk, answerPassword } = useStore()
  const [p, setP] = useState('')
  if (!pwAsk) return null

  const done = (v) => { setP(''); answerPassword(v) }

  return (
    <div className="modal-backdrop" onMouseDown={() => done(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h3>Admin password required</h3>
          <button className="icon-btn" onClick={() => done(null)} aria-label="Close">✕</button>
        </header>
        <form onSubmit={(e) => { e.preventDefault(); if (p) done(p) }}>
          <p className="muted">{pwAsk.message}</p>
          <label className="field">
            <span>Admin password</span>
            <input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="off" autoFocus />
          </label>
          <div className="row-gap tight">
            <button className="btn" type="button" onClick={() => done(null)}>Cancel</button>
            <button className="btn danger" type="submit" disabled={!p}>Delete</button>
          </div>
        </form>
      </div>
    </div>
  )
}
