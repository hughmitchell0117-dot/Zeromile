import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Not `import.meta.env` and not a VITE_ name: this key must never reach the
  // browser bundle. It is read here, in the Node process, and attached by the
  // proxy below — the page only ever talks to its own origin.
  const env = loadEnv(mode, process.cwd(), '')
  const nimKey = env.NIM_API_KEY?.trim()

  return {
    plugins: [react()],
    server: {
      proxy: {
        /*
         * NVIDIA's API sends no CORS headers, so a browser cannot call it
         * directly — which turned out to be a favour. Everything goes through
         * this dev proxy instead, and the key stays server-side.
         *
         * This covers `npm run dev` only. A deployed build needs the same hop
         * as a real serverless function; point the app at it with
         * VITE_LLM_BASE and nothing else has to change.
         */
        '/nim': {
          target: 'https://integrate.api.nvidia.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/nim/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (nimKey) proxyReq.setHeader('Authorization', `Bearer ${nimKey}`)
            })
          },
        },
      },
    },
  }
})
