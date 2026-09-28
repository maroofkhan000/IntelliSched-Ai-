import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken, setToken } from './api'
import { generateTimetable as buildTimetable } from './generator'
import { TABLES, TABLE_ORDER, WEEK, defaultSettings, effectiveTimings } from './schema'

const ACTIVE_KEY = 'intellisched.active.v1' // remembers which database you had open
const emptyDb = () => Object.fromEntries(TABLE_ORDER.map((t) => [t, []]))

const remember = (id) => {
  try { localStorage.setItem(ACTIVE_KEY, id) } catch { /* ignore */ }
}
const recall = () => {
  try { return localStorage.getItem(ACTIVE_KEY) } catch { return null }
}

const Ctx = createContext(null)
export const useStore = () => useContext(Ctx)

// All data lives on the server (MongoDB). This store keeps an in-memory copy of the
// active database and sends every change to the API.
export function StoreProvider({ children }) {
  const [user, setUser] = useState(null)
  const [booting, setBooting] = useState(() => Boolean(getToken()))
  const [bootError, setBootError] = useState('')
  const [notice, setNotice] = useState('') // last failed action, shown as a banner
  const [databases, setDatabases] = useState([])
  const [active, setActive] = useState(null) // { id, name, createdAt, settings, data }

  const settingsTimer = useRef(null)
  const pendingSettings = useRef(null)

  const guard = useCallback(async (fn) => {
    try {
      return await fn()
    } catch (e) {
      if (e.status === 401) { setToken(null); setUser(null); setActive(null) }
      else setNotice(e.message)
      throw e
    }
  }, [])

  const flushSettings = useCallback(async () => {
    clearTimeout(settingsTimer.current)
    const p = pendingSettings.current
    pendingSettings.current = null
    if (p) await api(`/databases/${p.id}/settings`, { method: 'PUT', body: p.settings }).catch((e) => setNotice(e.message))
  }, [])

  const loadDatabase = useCallback(async (id) => {
    const d = await api(`/databases/${id}`)
    remember(id)
    setActive(d)
  }, [])

  const refreshList = useCallback(async () => {
    const list = await api('/databases')
    setDatabases(list)
    return list
  }, [])

  const boot = useCallback(async () => {
    setBooting(true)
    setBootError('')
    try {
      const { user: u } = await api('/auth/me')
      const list = await refreshList()
      const id = list.find((d) => d.id === recall())?.id ?? list[0]?.id
      await loadDatabase(id)
      setUser(u)
    } catch (e) {
      if (e.status === 401) setToken(null)
      else setBootError(e.message)
    } finally {
      setBooting(false)
    }
  }, [refreshList, loadDatabase])

  useEffect(() => { if (getToken()) boot() }, [boot])

  const login = useCallback(async (username, password) => {
    try {
      const { token } = await api('/auth/login', { method: 'POST', body: { username, password } })
      setToken(token)
      await boot()
      return true
    } catch (e) {
      if (e.network) setNotice(e.message)
      return false
    }
  }, [boot])

  const logout = useCallback(async () => {
    await flushSettings()
    setToken(null)
    setUser(null)
    setActive(null)
    setDatabases([])
  }, [flushSettings])

  const db = useMemo(() => ({ ...emptyDb(), ...active?.data }), [active])
  const settings = useMemo(() => ({ ...defaultSettings(), ...active?.settings }), [active])
  const activeDb = { id: active?.id, name: active?.name ?? '' }
  const isAdmin = user?.role === 'admin'

  // ---------- databases ----------
  const createDatabase = useCallback((name) => guard(async () => {
    await flushSettings()
    const d = await api('/databases', { method: 'POST', body: { name } })
    await refreshList()
    await loadDatabase(d.id)
  }), [guard, flushSettings, refreshList, loadDatabase])

  const switchDatabase = useCallback((id) => guard(async () => {
    await flushSettings()
    await loadDatabase(id)
  }), [guard, flushSettings, loadDatabase])

  const renameDatabase = useCallback((id, name) => guard(async () => {
    await api(`/databases/${id}`, { method: 'PATCH', body: { name } })
    await refreshList()
    setActive((a) => (a?.id === id ? { ...a, name: name.trim() || a.name } : a))
  }), [guard, refreshList])

  const deleteDatabase = useCallback((id) => guard(async () => {
    await api(`/databases/${id}`, { method: 'DELETE' })
    const list = await refreshList()
    if (active?.id === id) await loadDatabase(list[0].id)
  }), [guard, refreshList, loadDatabase, active])

  // ---------- rows ----------
  const patchTable = (table, fn) => setActive((a) => ({ ...a, data: { ...a.data, [table]: fn(a.data[table] ?? []) } }))

  // Resolves to a list of error messages (empty = saved).
  const saveRow = useCallback(async (table, row, prevId) => {
    try {
      const saved = await api(`/databases/${active.id}/tables/${table}/rows`, { method: 'POST', body: { row, prevId } })
      patchTable(table, (rows) => (prevId ? rows.map((r) => (r._id === prevId ? saved : r)) : [...rows, saved]))
      refreshList()
      return []
    } catch (e) {
      if (e.status === 400) return e.errors ?? [e.message]
      await guard(() => { throw e }).catch(() => {})
      return [e.message]
    }
  }, [active?.id, guard, refreshList])

  // Save a teacher together with their subject preferences. Resolves to a list of error messages.
  const saveTeacher = useCallback(async (row, prevId, preferences) => {
    try {
      const { teacher, preferences: prefs } = await api(`/databases/${active.id}/teachers`, { method: 'POST', body: { row, prevId, preferences } })
      setActive((a) => ({
        ...a,
        data: {
          ...a.data,
          Teachers: prevId ? a.data.Teachers.map((r) => (r._id === prevId ? teacher : r)) : [...a.data.Teachers, teacher],
          TeacherPreferences: [...a.data.TeacherPreferences.filter((p) => p.TeacherID !== teacher.TeacherID), ...prefs],
        },
      }))
      refreshList()
      return []
    } catch (e) {
      if (e.status === 400) return e.errors ?? [e.message]
      await guard(() => { throw e }).catch(() => {})
      return [e.message]
    }
  }, [active?.id, guard, refreshList])

  const deleteRows = useCallback((table, ids) => guard(async () => {
    await api(`/databases/${active.id}/tables/${table}/rows/delete`, { method: 'POST', body: { ids } })
    const gone = new Set(ids)
    setActive((a) => {
      const tids = table === 'Teachers' ? new Set(a.data.Teachers.filter((r) => gone.has(r._id)).map((r) => r.TeacherID)) : null
      return { ...a, data: { ...a.data, [table]: a.data[table].filter((r) => !gone.has(r._id)), ...(tids ? { TeacherPreferences: a.data.TeacherPreferences.filter((p) => !tids.has(p.TeacherID)) } : {}) } }
    })
    refreshList()
  }).catch(() => {}), [guard, active?.id, refreshList])

  const setStatus = useCallback((table, ids, status) => guard(async () => {
    await api(`/databases/${active.id}/tables/${table}/status`, { method: 'POST', body: { ids, status } })
    const set = new Set(ids)
    const apply = (rows, hit) => (status === 'rejected' ? rows.filter((r) => !hit(r)) : rows.map((r) => (hit(r) ? { ...r, _status: status } : r)))
    setActive((a) => {
      const tids = table === 'Teachers' ? new Set(a.data.Teachers.filter((r) => set.has(r._id)).map((r) => r.TeacherID)) : null
      return { ...a, data: { ...a.data, [table]: apply(a.data[table], (r) => set.has(r._id)), ...(tids ? { TeacherPreferences: apply(a.data.TeacherPreferences, (p) => tids.has(p.TeacherID)) } : {}) } }
    })
  }).catch(() => {}), [guard, active?.id])

  // Merge rows (e.g. from an Excel file). Rows with the same key are replaced.
  // Rejects on failure so callers can show the message.
  const importRows = useCallback((incoming, { replace = false } = {}) => guard(async () => {
    const { data } = await api(`/databases/${active.id}/import`, { method: 'POST', body: { data: incoming, replace } })
    setActive((a) => ({ ...a, data }))
    refreshList()
  }), [guard, active?.id, refreshList])

  const clearAll = useCallback(() => guard(async () => {
    await api(`/databases/${active.id}/rows`, { method: 'DELETE' })
    setActive((a) => ({ ...a, data: emptyDb() }))
    refreshList()
  }).catch(() => {}), [guard, active?.id, refreshList])

  // ---------- timetable ----------
  // Builds a timetable from the current database + General Settings and saves it.
  // Resolves to { error } or { timetable }.
  const generateTimetable = useCallback(async (scope) => {
    await flushSettings()
    const result = buildTimetable({ db, settings, scope })
    if (result.error) return result
    try {
      await api(`/databases/${active.id}/timetable`, { method: 'PUT', body: { timetable: result } })
      setActive((a) => ({ ...a, timetable: result }))
      return { timetable: result }
    } catch (e) {
      return { error: e.message }
    }
  }, [db, settings, active?.id, flushSettings])

  const clearTimetable = useCallback(() => guard(async () => {
    await api(`/databases/${active.id}/timetable`, { method: 'PUT', body: { timetable: null } })
    setActive((a) => ({ ...a, timetable: null }))
  }).catch(() => {}), [guard, active?.id])

  // ---------- general settings ----------
  // Applied locally straight away, then saved to the server shortly after typing stops.
  const saveSettings = useCallback((patch) => {
    setActive((a) => {
      const next = { ...defaultSettings(), ...a.settings, ...patch }
      pendingSettings.current = { id: a.id, settings: next }
      clearTimeout(settingsTimer.current)
      settingsTimer.current = setTimeout(flushSettings, 600)
      return { ...a, settings: next }
    })
  }, [flushSettings])

  // Rebuild the TimeSlots table from General Settings (school days x available periods).
  // Resolves to an error string, or '' on success.
  const applyTimeSlots = useCallback(async () => {
    const periods = Array.from({ length: settings.periodsPerDay }, (_, i) => i + 1)
    const days = WEEK.filter((d) => settings.schoolDays.includes(d))
    const timings = effectiveTimings(settings)
    const rows = []
    for (const Day of days) {
      for (const Period of periods) {
        if (settings.avail[`${Day}|${Period}`] !== 'on') continue
        const t = timings[Period]
        if (!t?.start || !t?.end) return settings.timingMode === 'auto' ? `Period ${Period} has no time: check the start time, period length and breaks (must finish before midnight).` : `Set start and end times for Period ${Period} first.`
        if (t.start >= t.end) return `Period ${Period}: end time must be after start time.`
        rows.push({ Day, Period, StartTime: t.start, EndTime: t.end })
      }
    }
    if (!rows.length) return 'Mark at least one day/period as available first.'
    try {
      await importRows({ TimeSlots: rows }, { replace: true })
      return ''
    } catch (e) {
      return e.message
    }
  }, [settings, importRows])

  const pendingCount = useMemo(() => TABLE_ORDER.reduce((n, t) => n + db[t].filter((r) => r._status === 'pending').length, 0), [db])

  const canEditTable = (table) => isAdmin || !TABLES[table].adminOnly
  const canDeleteRow = (table, row) => isAdmin || (canEditTable(table) && row._status === 'pending' && row._by === user?.username)

  const value = { saveTeacher, db, settings, timetable: active?.timetable ?? null, generateTimetable, clearTimetable, saveSettings, applyTimeSlots, databases, activeDb, createDatabase, switchDatabase, renameDatabase, deleteDatabase, user, isAdmin, login, logout, saveRow, deleteRows, setStatus, importRows, clearAll, pendingCount, canEditTable, canDeleteRow, booting, bootError, retry: boot, notice, clearNotice: () => setNotice('') }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
