import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/mg': {
        target: process.env.VITE_MG_SERVER ?? 'http://127.0.0.1:31337',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/mg/, ''),
      },
    },
  },
})
