import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base path so the built assets work correctly when served from
// https://<username>.github.io/<repo-name>/ (a subfolder), regardless of
// what the repo is named.
export default defineConfig({
  plugins: [react()],
  base: './',
})
