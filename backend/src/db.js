import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { TABLE_ORDER, defaultSettings } from '../../frontend/src/schema.js'

let client
export let users, databases, rows

export async function connect() {
  client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  const db = client.db(process.env.MONGODB_DB || 'intellisched')
  users = db.collection('users')
  databases = db.collection('databases')
  rows = db.collection('rows')
  await users.createIndex({ username: 1 }, { unique: true })
  await rows.createIndex({ dbId: 1, table: 1 })
  await seed()
}

export const close = () => client?.close()

// Demo accounts (same logins the frontend has always shown) plus a first database.
async function seed() {
  if (!(await users.countDocuments())) {
    await users.insertMany([
      { username: 'admin', name: 'Administrator', role: 'admin', hash: await bcrypt.hash('admin123', 10) },
      { username: 'feeder', name: 'Data Feeder', role: 'feeder', hash: await bcrypt.hash('feeder123', 10) },
    ])
  }
  if (!(await databases.countDocuments())) await createDatabase('My first database')
}

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
