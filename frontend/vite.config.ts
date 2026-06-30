import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['hr.mmcb.top'],
    hmr: {
      host: 'hr.mmcb.top',
      protocol: 'wss',
      clientPort: 443,
    },
  },
})
