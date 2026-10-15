// One-off clean-up: removes fields the app no longer uses from rows already saved in MongoDB.
// Teacher preferences: TimesTaught, ResearchPapers. Teachers: MaxBuildingChanges, ExtraTravelMinutes.
//   node scripts/drop-removed-fields.mjs          # count only
//   node scripts/drop-removed-fields.mjs apply    # remove them
import 'dotenv/config'
import { MongoClient } from 'mongodb'
import dns from 'node:dns'
dns.setServers(['1.1.1.1', '8.8.8.8'])
const c = new MongoClient(process.env.MONGODB_URI); await c.connect()
const rows = c.db(process.env.MONGODB_DB || 'intellisched').collection('rows')
const q = {
  prefs: { table: 'TeacherPreferences', $or: [{ TimesTaught: { $exists: true } }, { ResearchPapers: { $exists: true } }] },
  teachers: { table: 'Teachers', $or: [{ MaxBuildingChanges: { $exists: true } }, { ExtraTravelMinutes: { $exists: true } }] },
}
for (const [k, f] of Object.entries(q)) console.log(k, await rows.countDocuments(f), 'of', await rows.countDocuments({ table: f.table }))
if (process.argv[2] === 'apply') {
  const a = await rows.updateMany(q.prefs, { $unset: { TimesTaught: '', ResearchPapers: '' } })
  const b = await rows.updateMany(q.teachers, { $unset: { MaxBuildingChanges: '', ExtraTravelMinutes: '' } })
  console.log('updated prefs', a.modifiedCount, 'teachers', b.modifiedCount)
}
await c.close()
