import { Link } from 'react-router-dom'

// Link that leans toward the mouse pointer (CSS reads --rx / --ry). Touch and pen are ignored.
export default function Tilt({ children, ...props }) {
  const move = (e) => {
    if (e.pointerType !== 'mouse') return
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    el.style.setProperty('--rx', `${(-y * 12).toFixed(1)}deg`)
    el.style.setProperty('--ry', `${(x * 14).toFixed(1)}deg`)
  }
  const leave = (e) => {
    e.currentTarget.style.removeProperty('--rx')
    e.currentTarget.style.removeProperty('--ry')
  }
  return <Link {...props} onPointerMove={move} onPointerLeave={leave}>{children}</Link>
}
