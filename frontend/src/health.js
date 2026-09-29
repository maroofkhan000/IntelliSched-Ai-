// Data-readiness checks that run over the approved database rows.
export function computeHealth(db) {
  const ok = (rows) => rows.filter((r) => r._status === 'approved')
  const sections = ok(db.Sections)
  const subjects = ok(db.Subjects)
  const teachers = ok(db.Teachers)
  const rooms = ok(db.Rooms)
  const slots = ok(db.TimeSlots)
  const map = ok(db.TeacherSubjectMap)
  const prefs = ok(db.TeacherPreferences)

  const subjectsFor = (s) => subjects.filter((x) => x.BranchCode === s.BranchCode && Number(x.Semester) === Number(s.Semester))

  let demand = 0
  const unassigned = []
  for (const s of sections) {
    for (const sub of subjectsFor(s)) {
      demand += Number(sub.WeeklyHours) || 0
      if (!map.some((m) => m.SectionID === s.SectionID && m.SubjectCode === sub.SubjectCode)) unassigned.push({ section: s.SectionID, subject: sub.SubjectCode })
    }
  }
  const supply = rooms.length * slots.length

  const hours = new Map()
  for (const m of map) {
    const sub = subjects.find((x) => x.SubjectCode === m.SubjectCode)
    hours.set(m.TeacherID, (hours.get(m.TeacherID) ?? 0) + (Number(sub?.WeeklyHours) || 0))
  }
  const overloaded = teachers.filter((t) => (hours.get(t.TeacherID) ?? 0) > Number(t.MaxWeeklyLoad)).map((t) => ({ id: t.TeacherID, name: t.Name, load: hours.get(t.TeacherID), max: t.MaxWeeklyLoad }))

  const maxClass = Math.max(0, ...rooms.filter((r) => r.RoomType === 'Classroom').map((r) => Number(r.Capacity)))
  const tooBig = maxClass ? sections.filter((s) => Number(s.Strength) > maxClass).map((s) => s.SectionID) : []
  const noPrefs = teachers.filter((t) => !prefs.some((p) => p.TeacherID === t.TeacherID)).map((t) => t.TeacherID)

  const hasLab = subjects.some((s) => s.Type === 'Lab')
  const labRooms = rooms.filter((r) => r.RoomType === 'Lab').length

  // buildings: every room's block should be listed, and every pair of listed blocks needs a walking time
  const blocks = [...new Set(ok(db.Buildings).map((b) => b.BuildingCode))].sort()
  const unknownBlocks = blocks.length ? [...new Set(rooms.map((r) => String(r.Building ?? '').trim().toUpperCase()).filter((b) => b && !blocks.includes(b)))].sort() : []
  const walks = new Set(ok(db.BuildingTravel).flatMap((t) => [`${t.FromBuilding}|${t.ToBuilding}`, `${t.ToBuilding}|${t.FromBuilding}`]))
  const missingWalk = []
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) if (!walks.has(`${blocks[i]}|${blocks[j]}`)) missingWalk.push(`${blocks[i]} ↔ ${blocks[j]}`)

  return { demand, supply, unassigned, overloaded, tooBig, noPrefs, maxClass, hasLab, labRooms, blocks, unknownBlocks, missingWalk, counts: { sections: sections.length, subjects: subjects.length, teachers: teachers.length, rooms: rooms.length, slots: slots.length, map: map.length } }
}
