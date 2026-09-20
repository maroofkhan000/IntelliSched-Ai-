import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import DbManager from './components/DbManager'
import { TABLES, TABLE_ORDER } from './schema'
import { StoreProvider, useStore } from './store'
import Approvals from './pages/Approvals'
import GeneralSettings from './pages/GeneralSettings'
import Login from './pages/Login'
import Overview from './pages/Overview'
import TablePage from './pages/TablePage'
import Timetable from './pages/Timetable'
import './App.css'

function Shell() {
  const { pathname } = useLocation()
  const { user, isAdmin, logout, pendingCount, db, booting, bootError, retry, notice, clearNotice } = useStore()
  if (booting) return <p className="boot">Connecting to the server…</p>
  if (bootError) return <div className="boot"><p className="errors" role="alert">{bootError}</p><button className="btn" onClick={retry}>Try again</button></div>
  if (!user) return <Login />

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Intelli<b>Sched</b> AI</div>
        <DbManager />
        <nav>
          <NavLink to="/" end>📊 Overview</NavLink>
          <NavLink to="/settings">⚙️ General Settings</NavLink>
          <NavLink to="/timetable">🗓️ Timetable</NavLink>
          {isAdmin && <NavLink to="/approvals">✅ Approvals{pendingCount > 0 && <span className="pill">{pendingCount}</span>}</NavLink>}
          <p className="nav-title">Data tables</p>
          {TABLE_ORDER.filter((n) => n !== 'TeacherPreferences').map((n) => (
            // Teachers and Teacher Preferences share one entry (two tabs on the page)
            <NavLink key={n} to={`/table/${n}`} className={({ isActive }) => (isActive || (n === 'Teachers' && pathname === '/table/TeacherPreferences') ? 'active' : '')}>
              {TABLES[n].icon} {TABLES[n].label}
              {TABLES[n].adminOnly && !isAdmin ? <span className="lock">🔒</span> : <span className="cnt">{db[n].length}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="me">
          <div><strong>{user.name}</strong><small>{isAdmin ? 'Admin' : 'Feeder'}</small></div>
          <button className="btn sm" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {notice && <p className="notice" role="alert">{notice} <button className="link" onClick={clearNotice}>Dismiss</button></p>}
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/settings" element={<GeneralSettings />} />
          <Route path="/timetable" element={<Timetable />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/table/:name" element={<TablePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </StoreProvider>
  )
}
