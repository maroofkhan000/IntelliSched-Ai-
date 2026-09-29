import 'dotenv/config'
import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { TABLES, TABLE_ORDER, defaultSettings, recordKey, topPriorityError, validateRow, withDerived } from './schema.js'
import * as store from './db.js'

for (const k of ['MONGODB_URI', 'JWT_SECRET']) if (!process.env[k]) throw new Error(`Missing ${k} (set it in backend/.env locally, or in Vercel's environment variables)`)

const app = express()
app.use(cors({ origin: (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean) }))
app.use(express.json({ limit: '15mb' }))

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const fail = (res, code, message, extra) => res.status(code).json({ error: message, ...extra })

// ---------- auth ----------
const auth = (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), process.env.JWT_SECRET)
    next()
  } catch {
    fail(res, 401, 'Please sign in again.')
  }
}
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : fail(res, 403, 'Admin only.'))
const publicUser = (u) => ({ username: u.username, role: u.role, name: u.name })

app.post('/api/auth/login', wrap(async (req, res) => {
  const { username = '', password = '' } = req.body ?? {}
  const u = await store.users.findOne({ username: String(username).trim().toLowerCase() })
  if (!u || !(await bcrypt.compare(String(password), u.hash))) return fail(res, 401, 'Wrong username or password.')
  const user = publicUser(u)
  res.json({ user, token: jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '12h' }) })
}))

app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }))

app.use('/api', auth)

// ---------- databases ----------
const summary = async (d) => ({ id: d._id, name: d.name, createdAt: d.createdAt, rows: await store.rows.countDocuments({ dbId: d._id }) })

app.get('/api/databases', wrap(async (_req, res) => {
  const list = await store.databases.find().sort({ createdAt: 1 }).toArray()
  res.json(await Promise.all(list.map(summary)))
}))

app.post('/api/databases', adminOnly, wrap(async (req, res) => {
  const d = await store.createDatabase(String(req.body?.name ?? ''))
  res.status(201).json(await summary(d))
}))

app.patch('/api/databases/:id', adminOnly, wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) return fail(res, 400, 'Name is required.')
  const r = await store.databases.updateOne({ _id: req.params.id }, { $set: { name } })
  if (!r.matchedCount) return fail(res, 404, 'Database not found.')
  res.json({ ok: true })
}))

app.delete('/api/databases/:id', adminOnly, wrap(async (req, res) => {
  if ((await store.databases.countDocuments()) < 2) return fail(res, 400, 'Keep at least one database.')
  await store.rows.deleteMany({ dbId: req.params.id })
  await store.databases.deleteOne({ _id: req.params.id })
  res.json({ ok: true })
}))

// everything below is scoped to one database
const withDb = wrap(async (req, res, next) => {
  req.dbDoc = await store.databases.findOne({ _id: req.params.id })
  if (!req.dbDoc) return fail(res, 404, 'Database not found.')
  next()
})
const withTable = (req, res, next) => {
  const t = TABLES[req.params.table]
  if (!t) return fail(res, 404, 'Unknown table.')
  if (t.adminOnly && req.user.role !== 'admin') return fail(res, 403, 'This table is maintained by the admin.')
  req.tbl = t
  next()
}

const columnKeys = (table) => TABLES[table].columns.map((c) => c.key)
const pick = (table, row) => Object.fromEntries(columnKeys(table).filter((k) => row[k] !== undefined).map((k) => [k, row[k]]))
const coerce = (table, row) => {
  const out = { ...row }
  for (const c of TABLES[table].columns) if ((c.type === 'number' || c.numeric) && out[c.key] !== '' && out[c.key] != null) out[c.key] = Number(out[c.key])
  return out
}
// A feeder's rows stay "pending" until an admin approves them.
const stamp = (user, dbId, table, fields, prev) => ({
  ...fields,
  _id: prev?._id ?? randomUUID(),
  dbId,
  table,
  _status: user.role === 'admin' ? 'approved' : 'pending',
  _by: prev?._by ?? user.username,
  _at: new Date().toISOString(),
})

app.get('/api/databases/:id', withDb, wrap(async (req, res) => {
  const d = req.dbDoc
  res.json({ id: d._id, name: d.name, createdAt: d.createdAt, settings: { ...defaultSettings(), ...d.settings }, timetable: d.timetable ?? null, data: await store.loadData(d._id) })
}))

app.put('/api/databases/:id/settings', withDb, wrap(async (req, res) => {
  const base = defaultSettings()
  const settings = Object.fromEntries(Object.keys(base).map((k) => [k, req.body?.[k] ?? base[k]]))
  await store.databases.updateOne({ _id: req.dbDoc._id }, { $set: { settings } })
  res.json({ ok: true })
}))

// the generated timetable is stored with its database (admin only); null clears it
app.put('/api/databases/:id/timetable', adminOnly, withDb, wrap(async (req, res) => {
  const t = req.body?.timetable
  if (t !== null && !(t && Array.isArray(t.entries) && Array.isArray(t.unscheduled))) return fail(res, 400, 'Invalid timetable.')
  await store.databases.updateOne({ _id: req.dbDoc._id }, t === null ? { $unset: { timetable: '' } } : { $set: { timetable: t } })
  res.json({ ok: true })
}))

// Validate + shape one row for a table (derived and generated columns included).
// Returns { errors } or { clean, prev }.
const prepareRow = (table, row, prevId, data) => {
  const prev = prevId ? data[table].find((r) => r._id === prevId) : null
  if (prevId && !prev) return { errors: ['Row no longer exists.'], missing: true }
  // generated columns (e.g. Teacher ID) are always assigned here, never trusted from the client
  const input = { ...row }
  for (const c of TABLES[table].columns) {
    if (c.generated) input[c.key] = prev?.[c.key] ?? ''
    if (c.lockOnEdit && prev?.[c.key]) input[c.key] = prev[c.key]
  }
  const clean = coerce(table, pick(table, withDerived(table, input, data)))
  return { clean, prev, errors: validateRow(table, clean, data, prevId) }
}

app.post('/api/databases/:id/tables/:table/rows', withDb, withTable, wrap(async (req, res) => {
  const { row, prevId } = req.body ?? {}
  if (!row || typeof row !== 'object') return fail(res, 400, 'Missing row.')
  const dbId = req.dbDoc._id
  const data = await store.loadData(dbId)
  const { clean, prev, errors, missing } = prepareRow(req.params.table, row, prevId, data)
  if (missing) return fail(res, 404, errors[0])
  if (errors.length) return fail(res, 400, errors[0], { errors })
  const doc = stamp(req.user, dbId, req.params.table, clean, prev)
  await store.rows.replaceOne({ _id: doc._id }, doc, { upsert: true })
  res.json(store.toRow(doc))
}))

// A teacher and their subject preferences in one save. Everything is validated first;
// nothing is written unless the teacher and every preference are valid.
app.post('/api/databases/:id/teachers', withDb, wrap(async (req, res) => {
  const { row, prevId, preferences = [] } = req.body ?? {}
  if (!row || typeof row !== 'object' || !Array.isArray(preferences)) return fail(res, 400, 'Invalid request.')
  const dbId = req.dbDoc._id
  const isAdmin = req.user.role === 'admin'
  const data = await store.loadData(dbId)

  const t = prepareRow('Teachers', row, prevId, data)
  if (t.missing) return fail(res, 404, t.errors[0])
  if (t.errors.length) return fail(res, 400, t.errors[0], { errors: t.errors })
  const teacherDoc = stamp(req.user, dbId, 'Teachers', t.clean, t.prev)
  const withTeacher = { ...data, Teachers: [...data.Teachers.filter((r) => r._id !== teacherDoc._id), store.toRow(teacherDoc)] }

  const tid = teacherDoc.TeacherID
  const existing = data.TeacherPreferences.filter((r) => r.TeacherID === tid)
  const errors = []
  const seen = new Set()
  const writes = []
  preferences.forEach((p, i) => {
    const n = `Preference ${i + 1}`
    const prevPref = existing.find((r) => r.SubjectCode === p.SubjectCode)
    const c = prepareRow('TeacherPreferences', { ...p, TeacherID: tid, Remarks: p.Remarks ?? prevPref?.Remarks }, prevPref?._id, withTeacher)
    if (c.errors.length) return errors.push(...c.errors.map((e) => `${n}: ${e}`))
    if (seen.has(c.clean.SubjectCode)) return errors.push(`${n}: ${c.clean.SubjectCode} is listed twice`)
    seen.add(c.clean.SubjectCode)
    const same = prevPref && ['Priority', 'ExperienceYears', 'TimesTaught', 'ResearchPapers', 'Remarks'].every((k) => (prevPref[k] ?? '') === (c.clean[k] ?? ''))
    if (!same) writes.push(stamp(req.user, dbId, 'TeacherPreferences', c.clean, prevPref))
  })
  const top = topPriorityError(preferences)
  if (top) errors.push(top)
  // preferences dropped from the form are removed (feeders may only remove their own pending ones)
  const removed = existing.filter((r) => !seen.has(r.SubjectCode))
  if (!isAdmin) for (const r of removed) if (!(r._status === 'pending' && r._by === req.user.username)) errors.push(`Only an admin can remove the approved preference for ${r.SubjectCode}`)
  if (errors.length) return fail(res, 400, errors[0], { errors })

  await store.rows.replaceOne({ _id: teacherDoc._id }, teacherDoc, { upsert: true })
  if (writes.length) await store.rows.bulkWrite(writes.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })))
  if (removed.length) await store.rows.deleteMany({ _id: { $in: removed.map((r) => r._id) } })
  const now = await store.rows.find({ dbId, table: 'TeacherPreferences', TeacherID: tid }).toArray()
  res.json({ teacher: store.toRow(teacherDoc), preferences: now.map(store.toRow) })
}))

app.post('/api/databases/:id/tables/:table/rows/delete', withDb, withTable, wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
  const filter = { dbId: req.dbDoc._id, table: req.params.table, _id: { $in: ids } }
  if (req.user.role !== 'admin') Object.assign(filter, { _status: 'pending', _by: req.user.username })
  const gone = req.params.table === 'Teachers' ? (await store.rows.find(filter).toArray()).map((t) => t.TeacherID) : []
  const r = await store.rows.deleteMany(filter)
  if (gone.length) await store.rows.deleteMany({ dbId: req.dbDoc._id, table: { $in: ['TeacherPreferences', 'TeacherAvailability'] }, TeacherID: { $in: gone } })
  res.json({ deleted: r.deletedCount })
}))

app.post('/api/databases/:id/tables/:table/status', adminOnly, withDb, withTable, wrap(async (req, res) => {
  const { ids = [], status } = req.body ?? {}
  const filter = { dbId: req.dbDoc._id, table: req.params.table, _id: { $in: ids } }
  if (status !== 'rejected' && status !== 'approved') return fail(res, 400, 'Status must be approved or rejected.')
  // a teacher's preferences are entered with the teacher, so they follow the teacher's decision
  const tids = req.params.table === 'Teachers' ? (await store.rows.find(filter).toArray()).map((t) => t.TeacherID) : []
  const prefFilter = { dbId: req.dbDoc._id, table: 'TeacherPreferences', TeacherID: { $in: tids } }
  if (status === 'rejected') {
    await store.rows.deleteMany(filter)
    if (tids.length) await store.rows.deleteMany(prefFilter)
  } else {
    await store.rows.updateMany(filter, { $set: { _status: 'approved' } })
    if (tids.length) await store.rows.updateMany(prefFilter, { $set: { _status: 'approved' } })
  }
  res.json({ ok: true })
}))

// Merge rows (e.g. from an Excel file). Rows with the same key replace the existing ones.
// With replace, every table present in `data` is emptied first.
app.post('/api/databases/:id/import', adminOnly, withDb, wrap(async (req, res) => {
  const { data: incoming = {}, replace = false } = req.body ?? {}
  const dbId = req.dbDoc._id
  const tables = TABLE_ORDER.filter((t) => Array.isArray(incoming[t]))
  const data = await store.loadData(dbId)
  if (replace) {
    await store.rows.deleteMany({ dbId, table: { $in: tables } })
    for (const t of tables) data[t] = []
  }
  const ops = []
  for (const table of tables) {
    const byKey = new Map(data[table].map((r) => [recordKey(table, r), r]))
    for (const row of incoming[table]) {
      const clean = coerce(table, pick(table, withDerived(table, row, data)))
      const k = recordKey(table, clean)
      const doc = stamp(req.user, dbId, table, clean, byKey.get(k))
      byKey.set(k, store.toRow(doc))
      if (table === 'Teachers') data[table] = [...byKey.values()] // so generated IDs count up within one import
      ops.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })
    }
    data[table] = [...byKey.values()]
  }
  if (ops.length) await store.rows.bulkWrite(ops, { ordered: false })
  res.json({ data })
}))

app.delete('/api/databases/:id/rows', adminOnly, withDb, wrap(async (req, res) => {
  await store.rows.deleteMany({ dbId: req.dbDoc._id })
  res.json({ ok: true })
}))

app.use((err, _req, res, _next) => {
  console.error(err)
  fail(res, 500, 'Server error.')
})

await store.connect()

// On Vercel the exported app runs as a function; locally we listen on a port.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 4000
  app.listen(port, () => console.log(`IntelliSched API on http://localhost:${port}`))
}

export default app
