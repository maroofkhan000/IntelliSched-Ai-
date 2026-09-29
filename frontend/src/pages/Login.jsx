import { useState } from 'react'
import SlabStack from '../components/SlabStack'
import { useStore } from '../store'

export default function Login() {
  const { login } = useStore()
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState('')

  const [busy, setBusy] = useState(false)

  const attempt = async (name, pass) => {
    setBusy(true)
    setErr('')
    const ok = await login(name, pass)
    if (!ok) setErr('Could not sign in. Check the username and password, and that the backend is running.')
    setBusy(false)
  }
  const submit = (e) => {
    e.preventDefault()
    attempt(u, p)
  }

  return (
    <div className="login-page">
      <section className="login-hero">
        <div className="brand big">Intelli<b>Sched</b> AI</div>
        <h1>Build the timetable database, one table at a time.</h1>
        <p>Enter branches, teachers, subjects, rooms and sections. Check them, then export a clean Excel file.</p>
        <SlabStack />
      </section>

      <form className="login-card" onSubmit={submit}>
        <h2>Sign in</h2>
        <label className="field"><span>Username</span><input value={u} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" /></label>
        <label className="field"><span>Password</span><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
        {err && <p className="errors" role="alert">{err}</p>}
        <button className="btn primary wide" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
