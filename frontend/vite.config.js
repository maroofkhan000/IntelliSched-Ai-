import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // fs.allow: src/schema.js re-exports ../backend/src/schema.js, which sits outside this folder.
  server: { proxy: { '/api': 'http://localhost:4000' }, fs: { allow: ['..'] } },
})
