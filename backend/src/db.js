import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { TABLE_ORDER, defaultSettings } from './schema.js'

let client
export let users, databases, rows, attempts

export async function connect() {
  client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  const db = client.db(process.env.MONGODB_DB || 'intellisched')
  users = db.collection('users')
  databases = db.collection('databases')
  rows = db.collection('rows')
  attempts = db.collection('attempts')
  await users.createIndex({ username: 1 }, { unique: true })
  await rows.createIndex({ dbId: 1, table: 1 })
  await attempts.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })
  await seed()
}

export const close = () => client?.close()

// The two accounts take their usernames and passwords from the environment (ADMIN_USERNAME,
// ADMIN_PASSWORD, FEEDER_USERNAME, FEEDER_PASSWORD), never from code. Changing them in .env and
// restarting renames the account / updates the stored hash.
const ACCOUNTS = [
  { seed: 'admin', name: 'Administrator', role: 'admin', userEnv: 'ADMIN_USERNAME', passEnv: 'ADMIN_PASSWORD' },
  { seed: 'feeder', name: 'Data Feeder', role: 'feeder', userEnv: 'FEEDER_USERNAME', passEnv: 'FEEDER_PASSWORD' },
]
async function seed() {
  for (const { userEnv, passEnv, ...account } of ACCOUNTS) {
    const username = process.env[userEnv].trim().toLowerCase()
    const password = process.env[passEnv]
    // older databases created these accounts before `seed` existed, under the default usernames
    const u = await users.findOne({ $or: [{ seed: account.seed }, { seed: { $exists: false }, username: account.seed }] })
    if (u?.seed && u.username === username && (await bcrypt.compare(password, u.hash))) continue
    const fields = { ...account, username, hash: await bcrypt.hash(password, 12) }
    if (u) await users.updateOne({ _id: u._id }, { $set: fields })
    else await users.insertOne(fields)
  }
  if (!(await databases.countDocuments())) await createDatabase('My first database')
}

// Brute-force guard: after MAX_TRIES wrong passwords for one key, it is locked for LOCK_MINUTES.
const MAX_TRIES = 5
const LOCK_MINUTES = 15
export const LOCK_MESSAGE = `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes.`
const live = async (key) => {
  const a = await attempts.findOne({ _id: key })
  return a && a.expireAt > new Date() ? a : null
}
export const isLocked = async (key) => ((await live(key))?.count ?? 0) >= MAX_TRIES
export async function recordFailure(key) {
  const count = ((await live(key))?.count ?? 0) + 1
  await attempts.replaceOne({ _id: key }, { count, expireAt: new Date(Date.now() + LOCK_MINUTES * 60_000) }, { upsert: true })
}
export const clearFailures = (key) => attempts.deleteOne({ _id: key })

export async function createDatabase(name) {
  const doc = { _id: randomUUID(), name: name.trim() || 'Untitled database', createdAt: new Date().toISOString(), settings: defaultSettings() }
  await databases.insertOne(doc)
  return doc
}

// Row documents are stored flat: { _id, dbId, table, ...fields, _status, _by, _at }.
export const toRow = ({ dbId, table, ...row }) => row

export async function loadData(dbId, only) {
  const data = Object.fromEntries(TABLE_ORDER.map((t) => [t, []]))
  const filter = { dbId, ...(only ? { table: { $in: only } } : {}) }
  for (const doc of await rows.find(filter).toArray()) if (data[doc.table]) data[doc.table].push(toRow(doc))
  return data
}
