import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ASSETS_DIR = path.resolve(FRONTEND_ROOT, '../backend/assets')
const BACKEND_OUTPUT_DIR = path.resolve(FRONTEND_ROOT, '../backend/output')

/**
 * Serve NIfTI assets as raw binary so the browser receives the volume bytes
 * directly instead of Vite trying to infer compression/content encodings.
 */
function serveNiftiPlugin() {
  const publicDir = path.join(FRONTEND_ROOT, 'public')
  let outDir = path.join(FRONTEND_ROOT, 'dist')

  const serveFile = (res, filePath, contentType = 'application/octet-stream') => {
    const stat = fs.statSync(filePath)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    })
    fs.createReadStream(filePath).pipe(res)
  }

  const resolveBackendFile = (prefix, rootDir, url) => {
    if (!url.startsWith(prefix)) return null
    // Strip query strings (e.g. ?t=123) and hashes (#...)
    const cleanUrl = url.split(/[?#]/)[0]
    const relativePath = decodeURIComponent(cleanUrl.slice(prefix.length))
    return path.join(rootDir, relativePath)
  }

  const attachMiddleware = (middlewares) => {
    middlewares.use((req, res, next) => {
      if (!req.url) {
        next()
        return
      }

      const cleanUrl = req.url.split(/[?#]/)[0]
      if (cleanUrl.endsWith('.nii.gz')) {
        const filePath = path.join(publicDir, cleanUrl)
        if (fs.existsSync(filePath)) {
          serveFile(res, filePath)
          return
        }
      }

      const backendAssetPath = resolveBackendFile('/backend-assets/', BACKEND_ASSETS_DIR, req.url)
      if (backendAssetPath && fs.existsSync(backendAssetPath)) {
        const contentType = backendAssetPath.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream'
        serveFile(res, backendAssetPath, contentType)
        return
      }

      const backendOutputPath = resolveBackendFile('/backend-output/', BACKEND_OUTPUT_DIR, req.url)
      if (backendOutputPath && fs.existsSync(backendOutputPath)) {
        const contentType = backendOutputPath.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream'
        serveFile(res, backendOutputPath, contentType)
        return
      }

      next()
    })
  }

  const copyIfExists = (sourcePath, targetPath) => {
    if (!fs.existsSync(sourcePath)) return
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(sourcePath, targetPath)
  }

  return {
    name: 'serve-nifti',
    configResolved(config) {
      outDir = path.resolve(FRONTEND_ROOT, config.build.outDir)
    },
    configureServer(server) {
      attachMiddleware(server.middlewares)
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares)
    },
    writeBundle() {
      copyIfExists(
        path.join(BACKEND_ASSETS_DIR, '1.nii'),
        path.join(outDir, 'backend-assets', '1.nii')
      )
      copyIfExists(
        path.join(BACKEND_ASSETS_DIR, 'final_example', 'analyze_response.json'),
        path.join(outDir, 'backend-assets', 'final_example', 'analyze_response.json')
      )
      copyIfExists(
        path.join(BACKEND_OUTPUT_DIR, '9acd632a-8937-4fdc-8e9b-d16d8387aa6d', '9acd632a-8937-4fdc-8e9b-d16d8387aa6d_overlay.nii.gz'),
        path.join(outDir, 'backend-output', '9acd632a-8937-4fdc-8e9b-d16d8387aa6d', '9acd632a-8937-4fdc-8e9b-d16d8387aa6d_overlay.nii.gz')
      )
    },
  }
}

export default defineConfig({
  plugins: [serveNiftiPlugin(), react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
})
