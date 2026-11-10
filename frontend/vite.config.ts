import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'serve-release-dossier',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/api/v2/release/dossier') {
            const dossierPath = path.resolve(__dirname, 'public/release-dossier.json')
            if (fs.existsSync(dossierPath)) {
              res.setHeader('Content-Type', 'application/json')
              res.statusCode = 200
              res.end(fs.readFileSync(dossierPath, 'utf8'))
              return
            }
          }
          next()
        })
      }
    }
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
