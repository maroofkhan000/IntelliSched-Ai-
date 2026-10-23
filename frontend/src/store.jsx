import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken, setToken } from './api'
import { suggestAssignments } from './assigner'
import { generateTimetable as buildTimetable } from './generator'
import { problemFeatures } from './mlRecord'
import { TABLES, TABLE_ORDER, WEEK, defaultSettings, effectiveTimings, recordKey, withDerived } from './schema'

const ACTIVE_KEY = 'intellisched.active.v1' // remembers which database you had open
const emptyDb = () => Object.fromEntries(TABLE_ORDER.map((t) => [t, []]))

const remember = (id) => {
  try { localStorage.setItem(ACTIVE_KEY, id) } catch { /* ignore */ }
}
const recall = () => {
  try { return localStorage.getItem(ACTIVE_KEY) } catch { return null }
}

// Same rule as the server (rowsFree): a branch still used by sections, subjects or teachers, or a
// subject a section still has a teacher for, can't be deleted or rejected. Throws the reason.
const checkInUse = (data, table, ids) => {
  const picked = (data[table] ?? []).filter((r) => ids.includes(r._id))
  if (table === 'Branches') {
    const codes = new Set(picked.map((b) => b.BranchCode))
    const using = ['Sections', 'Subjects', 'Teachers'].map((t) => [t, data[t].filter((r) => codes.has(r.BranchCode)).length]).filter(([, n]) => n)
    if (using.length) throw new Error(`Can't delete ${codes.size === 1 ? `branch ${[...codes][0]}` : `these ${codes.size} branches`}: ${using.map(([t, n]) => `${n} ${TABLES[t].label.toLowerCase()}`).join(', ')} still belong to ${codes.size === 1 ? 'it' : 'them'}. Delete or move those first.`)
  }
  if (table === 'Subjects') {
    const keys = new Set(picked.map((s) => `${s.BranchCode}|${s.SubjectCode}`))
    const used = data.TeacherSubjectMap.filter((m) => keys.has(`${m.BranchCode}|${m.SubjectCode}`))
    const codes = [...new Set(used.map((m) => m.SubjectCode))]
    if (used.length) throw new Error(`Can't delete ${codes.length === 1 ? `subject ${codes[0]}` : `subjects ${codes.join(', ')}`}: ${used.length} teaching assignment${used.length === 1 ? '' : 's'} still use${used.length === 1 ? 's' : ''} ${codes.length === 1 ? 'it' : 'them'}. Delete those assignments first.`)
  }
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
  const [dialog, setDialog] = useState(null) // { title, message, confirmLabel, password, error, resolve } while the confirm dialog is open

  const settingsTimer = useRef(null)
  const pendingSettings = useRef(null)

  const guard = useCallback(async (fn) => {
    try {
      return await fn()
    } catch (e) {
      if (e.status === 401) { setToken(null); setUser(null); setActive(null) }
      else if (!e.cancelled) setNotice(e.message)
      throw e
    }
  }, [])

  // Every delete, reject, clear and overwriting import goes through one in-app dialog that asks
  // for the admin password straight away (the server requires it for anything that deletes or
  // overwrites data); if the password was wrong, the dialog asks again with the reason.
  const answerDialog = useCallback((v) => setDialog((d) => { d?.resolve(v); return null }), [])
  const confirmThen = useCallback(async ({ title, message, confirmLabel, password = false, skipConfirm = false }, send) => {
    // one dialog at a time: a new question cancels one still open, so its action ends instead of hanging
    const ask = (opts) => new Promise((resolve) => setDialog((d) => { d?.resolve(null); return { confirmLabel: 'Delete', ...opts, resolve } }))
    const cancelled = () => Object.assign(new Error('Cancelled.'), { cancelled: true })
    let adminPassword
    if (!skipConfirm || password) {
      const a = await ask({ title, message, confirmLabel, password })
      if (a == null) throw cancelled()
      adminPassword = a.password
    }
    for (;;) {
      try {
        return await send(adminPassword)
      } catch (e) {
        if (!e.needsPassword) throw e
        const a = await ask({ title: 'Admin password required', message, confirmLabel, password: true, error: adminPassword ? e.message : '' })
        if (a == null) throw cancelled()
        adminPassword = a.password
      }
    }
  }, [])
  // plain yes/no in the same dialog; resolves to true or false
  const confirm = useCallback((opts) => confirmThen(opts, () => true).catch(() => false), [confirmThen])
  // same rule as the server: deleting or overwriting anything that exists needs the admin password
  const needsPw = (count) => count > 0
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

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
      if (e.network || e.status === 429) setNotice(e.message)
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
    const d = databases.find((x) => x.id === id)
    await confirmThen(
      { title: 'Delete database', message: `Delete "${d?.name}" and all ${plural(d?.rows ?? 0, 'row')} in it? This can't be undone.`, confirmLabel: 'Delete database', password: needsPw(d?.rows ?? 0) },
      (adminPassword) => api(`/databases/${id}`, { method: 'DELETE', body: { adminPassword } }),
    )
    const list = await refreshList()
    if (active?.id === id) await loadDatabase(list[0].id)
  }).catch(() => {}), [guard, confirmThen, databases, refreshList, loadDatabase, active])

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
    checkInUse(active.data, table, ids)
    const whole = ids.length === (active.data[table] ?? []).length
    await confirmThen(
      {
        title: ids.length === 1 ? 'Delete row' : `Delete ${plural(ids.length, 'row')}`,
        message: `${whole && ids.length > 1 ? 'This empties the whole' : `Delete ${ids.length === 1 ? 'this row' : plural(ids.length, 'row')} from`} ${table} table${table === 'Teachers' ? `, along with ${ids.length === 1 ? "this teacher's" : "those teachers'"} preferences and availability` : ''}. This can't be undone.`,
        password: isAdmin && needsPw(ids.length),
      },
      (adminPassword) => api(`/databases/${active.id}/tables/${table}/rows/delete`, { method: 'POST', body: { ids, adminPassword } }),
    )
    const gone = new Set(ids)
    setActive((a) => {
      const tids = table === 'Teachers' ? new Set(a.data.Teachers.filter((r) => gone.has(r._id)).map((r) => r.TeacherID)) : null
      return { ...a, data: { ...a.data, [table]: a.data[table].filter((r) => !gone.has(r._id)), ...(tids ? { TeacherPreferences: a.data.TeacherPreferences.filter((p) => !tids.has(p.TeacherID)) } : {}) } }
    })
    refreshList()
    return true
  }).catch(() => {}), [guard, confirmThen, active, refreshList, isAdmin])

  const setStatus = useCallback((table, ids, status) => guard(async () => {
    const send = (adminPassword) => api(`/databases/${active.id}/tables/${table}/status`, { method: 'POST', body: { ids, status, adminPassword } })
    if (status === 'rejected') {
      checkInUse(active.data, table, ids)
      await confirmThen({ title: 'Reject entries', message: `Rejecting deletes ${plural(ids.length, 'row')} from ${table}.`, confirmLabel: 'Reject', password: needsPw(ids.length), skipConfirm: true }, send)
    } else await send()
    const set = new Set(ids)
    const apply = (rows, hit) => (status === 'rejected' ? rows.filter((r) => !hit(r)) : rows.map((r) => (hit(r) ? { ...r, _status: status } : r)))
    setActive((a) => {
      const tids = table === 'Teachers' ? new Set(a.data.Teachers.filter((r) => set.has(r._id)).map((r) => r.TeacherID)) : null
      return { ...a, data: { ...a.data, [table]: apply(a.data[table], (r) => set.has(r._id)), ...(tids ? { TeacherPreferences: apply(a.data.TeacherPreferences, (p) => tids.has(p.TeacherID)) } : {}) } }
    })
  }).catch(() => {}), [guard, confirmThen, active])

  // Merge rows (e.g. from an Excel file). Rows with the same key are replaced.
  // Into a database that already has data this asks first, with the admin password, saying what
  // will be added and what overwritten (same rule as the server; only brand-new teaching
  // assignments go straight through). `ask` = { title, confirmLabel, intro } for the dialog.
  // Rejects on failure (or { cancelled: true }) so callers can show the message.
  const importRows = useCallback((incoming, { replace = false, ask = {} } = {}) => guard(async () => {
    const data0 = active.data
    const tables = TABLE_ORDER.filter((t) => Array.isArray(incoming[t]))
    const existing = TABLE_ORDER.reduce((n, t) => n + (data0[t]?.length ?? 0), 0)
    const replaced = replace ? tables.reduce((n, t) => n + (data0[t]?.length ?? 0), 0) : 0
    const clash = tables.map((t) => {
      const have = new Set((data0[t] ?? []).map((r) => recordKey(t, r).toUpperCase()))
      return [t, incoming[t].filter((r) => have.has(recordKey(t, withDerived(t, r, data0)).toUpperCase())).length]
    }).filter(([, n]) => n)
    const onlyNewAssignments = tables.every((t) => t === 'TeacherSubjectMap') && !clash.length && !replaced
    const label = (t) => TABLES[t]?.label.toLowerCase() ?? t
    const message = [
      ask.intro,
      replace ? `This replaces the ${plural(replaced, 'row')} now in ${tables.map(label).join(', ')}.`
        : `This adds ${tables.map((t) => `${incoming[t].length} ${label(t)}`).join(', ')} to the ${plural(existing, 'row')} in "${active.name}".`,
      !replace && clash.length ? `It OVERWRITES ${clash.map(([t, n]) => `${n} ${label(t)}`).join(', ')} you already have.` : '',
      'To try data without touching this database, create a new empty one first (the + next to the database name).',
    ].filter(Boolean).join(' ')
    const send = (adminPassword) => api(`/databases/${active.id}/import`, { method: 'POST', body: { data: incoming, replace, adminPassword } })
    const asks = existing > 0 && !onlyNewAssignments
    const { data } = await confirmThen({ title: ask.title ?? `Import into "${active.name}"`, message, confirmLabel: ask.confirmLabel ?? 'Import', password: asks, skipConfirm: !asks }, send)
    setActive((a) => ({ ...a, data }))
    refreshList()
  }), [guard, confirmThen, active, refreshList])

  const clearAll = useCallback(() => guard(async () => {
    const total = Object.values(active.data).reduce((n, rows) => n + rows.length, 0)
    await confirmThen(
      { title: 'Clear everything', message: `Delete all ${plural(total, 'row')} in every table of "${active.name}"? This can't be undone.`, confirmLabel: 'Clear everything', password: needsPw(total) },
      (adminPassword) => api(`/databases/${active.id}/rows`, { method: 'DELETE', body: { adminPassword } }),
    )
    setActive((a) => ({ ...a, data: emptyDb() }))
    refreshList()
  }).catch(() => {}), [guard, confirmThen, active, refreshList])

  // ---------- timetable ----------
  // Builds a timetable from the current database + General Settings and saves it.
  // Teaching assignments are automatic: every section-subject pair in scope without a teacher
  // gets one first (Auto-assign rules, falling back to the least-loaded teacher of the branch),
  // and those assignments are saved. Assignments already in the table are kept, so manual
  // choices still win. The save also logs a training record for the ML pipeline.
  // Resolves to { error } or { timetable, autoAssigned }.
  const generateTimetable = useCallback(async (scope) => {
    await flushSettings()
    try {
      let data = db
      const auto = suggestAssignments({ db, scope, fallback: true }).assignments
      if (auto.length) {
        const rows = auto.map(({ TeacherID, SubjectCode, SectionID }) => ({ TeacherID, SubjectCode, SectionID }))
        data = { ...emptyDb(), ...(await api(`/databases/${active.id}/import`, { method: 'POST', body: { data: { TeacherSubjectMap: rows } } })).data }
        setActive((a) => ({ ...a, data }))
        refreshList()
      }
      const result = buildTimetable({ db: data, settings, scope })
      if (result.error) return result
      const ml = { features: problemFeatures(data, settings, scope), autoAssigned: auto.length }
      await api(`/databases/${active.id}/timetable`, { method: 'PUT', body: { timetable: result, ml } })
      setActive((a) => ({ ...a, timetable: result }))
      return { timetable: result, autoAssigned: auto.length }
    } catch (e) {
      return { error: e.message }
    }
  }, [db, settings, active?.id, flushSettings, refreshList])

  const clearTimetable = useCallback(() => guard(async () => {
    await confirmThen({ title: 'Clear timetable', message: 'Delete the generated timetable? Your tables are kept, so you can generate it again.', confirmLabel: 'Clear timetable', password: true }, (adminPassword) => api(`/databases/${active.id}/timetable`, { method: 'PUT', body: { timetable: null, adminPassword } }))
    setActive((a) => ({ ...a, timetable: null }))
  }).catch(() => {}), [guard, confirmThen, active])

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
  // Resolves to an error message, '' when done, or null when the user cancelled.
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
      await importRows({ TimeSlots: rows }, { replace: true, ask: { title: 'Replace Time Slots', confirmLabel: 'Replace', intro: `The grid below becomes ${plural(rows.length, 'time slot')}.` } })
      return ''
    } catch (e) {
      return e.cancelled ? null : e.message
    }
  }, [settings, importRows])

  const pendingCount = useMemo(() => TABLE_ORDER.reduce((n, t) => n + db[t].filter((r) => r._status === 'pending').length, 0), [db])

  const canEditTable = (table) => isAdmin || !TABLES[table].adminOnly
  const canDeleteRow = (table, row) => isAdmin || (canEditTable(table) && row._status === 'pending' && row._by === user?.username)

  const value = { saveTeacher, db, settings, timetable: active?.timetable ?? null, generateTimetable, clearTimetable, saveSettings, applyTimeSlots, databases, activeDb, createDatabase, switchDatabase, renameDatabase, deleteDatabase, user, isAdmin, login, logout, saveRow, deleteRows, setStatus, importRows, clearAll, pendingCount, canEditTable, canDeleteRow, booting, bootError, retry: boot, dialog, answerDialog, confirm, notice, clearNotice: () => setNotice('') }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
