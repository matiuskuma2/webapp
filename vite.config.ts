import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'
import { execSync } from 'child_process'

// Get git commit hash or timestamp for cache busting
function getBuildVersion(): string {
  try {
    // Try to get git short hash
    const gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    return gitHash
  } catch {
    // Fallback to timestamp
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  }
}

export default defineConfig({
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ],
  // Replace __BUILD_VERSION__ at build time with git hash or timestamp
  define: {
    '__BUILD_VERSION__': JSON.stringify(getBuildVersion())
  }
})
