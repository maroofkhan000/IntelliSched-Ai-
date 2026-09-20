import ExcelJS from 'exceljs'
import { saveAs } from 'file-saver'
import { TABLES, TABLE_ORDER } from './schema'

const plain = (v) => {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(11, 16)
  if (typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : '')
  return v
}

const timeStr = (v) => {
  if (typeof v === 'number') { // Excel time fraction
    const mins = Math.round(v * 24 * 60)
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
  }
  return String(v)
}

// Parse a workbook into { TableName: [row, ...] } using the schema's column keys.
export async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const out = {}
  const report = {}
  for (const name of TABLE_ORDER) {
    const ws = wb.getWorksheet(name)
    if (!ws) continue
    const headers = ws.getRow(1).values.slice(1).map((h) => String(plain(h)).trim())
    const cols = TABLES[name].columns
    const rows = []
    ws.eachRow((row, i) => {
      if (i === 1) return
      const vals = row.values.slice(1)
      if (vals.every((v) => plain(v) === '')) return
      const obj = {}
      for (const c of cols) {
        const idx = headers.indexOf(c.key)
        if (idx < 0) continue
        let v = plain(vals[idx])
        if (c.type === 'time') v = timeStr(v)
        else if ((c.type === 'number' || c.numeric) && v !== '') v = Number(v)
        obj[c.key] = v
      }
      rows.push(obj)
    })
    out[name] = rows
    report[name] = rows.length
  }
  return { data: out, report }
}

function styleSheet(ws, table, rows, withStatus) {
  const cols = TABLES[table].columns
  const headers = cols.map((c) => c.key)
  if (withStatus) headers.push('Status', 'EnteredBy')
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 4) }))
  for (const r of rows) {
    const o = {}
    for (const c of cols) o[c.key] = r[c.key]
    if (withStatus) { o.Status = r._status; o.EnteredBy = r._by }
    ws.addRow(o)
  }
  ws.columns.forEach((col) => {
    let w = col.header.length
    col.eachCell({ includeEmpty: false }, (cell) => { w = Math.max(w, String(cell.value ?? '').length) })
    col.width = Math.min(45, w + 3)
  })
  const head = ws.getRow(1)
  head.height = 22
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0B2540' } } }
  })
  ws.eachRow((row, i) => {
    if (i === 1) return
    row.eachCell((cell) => {
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFBBBBBB' } } }
      if (i % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F7FB' } }
    })
  })
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } }
}

// Whole database -> one workbook (one sheet per table). Approved rows only, so the
// file is a clean input for the scheduler.
export async function exportWorkbook(db, { onlyApproved = true, name = 'timetable_database' } = {}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'IntelliSched AI'
  for (const name of TABLE_ORDER) {
    const rows = db[name].filter((r) => !onlyApproved || r._status === 'approved')
    styleSheet(wb.addWorksheet(name), name, rows, false)
  }
  saveAs(new Blob([await wb.xlsx.writeBuffer()]), `${name.replace(/[^\w\- ]+/g, '').trim() || 'timetable_database'}.xlsx`)
}

export async function exportSheet(name, rows) {
  const wb = new ExcelJS.Workbook()
  styleSheet(wb.addWorksheet(name), name, rows, true)
  saveAs(new Blob([await wb.xlsx.writeBuffer()]), `${name}.xlsx`)
}
