// The schema lives with the backend (it's deployed as its own Vercel service and can't
// reach into frontend/). Re-exported here so frontend imports stay unchanged.
export * from '../../backend/src/schema.js'
