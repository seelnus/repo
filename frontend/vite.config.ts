import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3100'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['hr.mmcb.top'],
    hmr: false,
    // 本机默认转发到 localhost；Docker Compose 通过环境变量改为后端容器名。
    proxy: {
      '/api': { target: apiProxyTarget, changeOrigin: true },
      '/uploads': { target: apiProxyTarget, changeOrigin: true },
    },
  },
})
