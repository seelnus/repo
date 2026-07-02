import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['hr.mmcb.top'],
    hmr: false,
    // 本地开发：把 /api、/uploads 转发到后端容器（服务器上由 nginx 处理，此处不生效，无副作用）
    proxy: {
      '/api': { target: 'http://app-backend:3100', changeOrigin: true },
      '/uploads': { target: 'http://app-backend:3100', changeOrigin: true },
    },
  },
})
