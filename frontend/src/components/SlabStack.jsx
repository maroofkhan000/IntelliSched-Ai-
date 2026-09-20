// Isometric stack of "spreadsheet slabs" built from CSS 3D transforms. Decorative only.
const SLABS = [
  { name: 'Rooms', cols: ['RoomID', 'Type', 'Seats'] },
  { name: 'Teachers', cols: ['ID', 'Name', 'Load'] },
  { name: 'Subjects', cols: ['Code', 'Name', 'Hours'] },
  { name: 'Sections', cols: ['Section', 'Sem', 'Students'] },
]

export default function SlabStack() {
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    e.currentTarget.style.setProperty('--px', x.toFixed(3))
    e.currentTarget.style.setProperty('--py', y.toFixed(3))
  }
  const leave = (e) => {
    e.currentTarget.style.setProperty('--px', 0)
    e.currentTarget.style.setProperty('--py', 0)
  }

  return (
    <div className="stage" onPointerMove={move} onPointerLeave={leave} aria-hidden="true">
      <div className="scene">
        {SLABS.map((s, i) => (
          <div key={s.name} className={`slab s${i}`} style={{ '--i': i }}>
            <div className="slab-head">
              {s.cols.map((c) => <span key={c}>{c}</span>)}
            </div>
            <b>{s.name}</b>
          </div>
        ))}
      </div>
    </div>
  )
}
