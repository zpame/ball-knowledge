import { defineConfig } from 'vite'
import type { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BDL_API_KEY']) {
    if (!process.env[key] && env[key]) process.env[key] = env[key]
  }

  return {
    server: {
      host: '127.0.0.1',
    },
    plugins: [
      vue(),
      {
        name: 'local-nba-games-function',
        configureServer(server) {
          server.middlewares.use('/api/nbaGames/tonight', async (request, response, next) => {
            try {
              const module = await server.ssrLoadModule('/api/nbaGames/tonight.js')
              const vercelResponse = createVercelResponse(response)
              await module.default(request, vercelResponse)
            } catch (error) {
              next(error instanceof Error ? error : new Error(String(error)))
            }
          })
        },
      },
    ],
  }
})

function createVercelResponse(response: ServerResponse<IncomingMessage>) {
  return {
    setHeader: response.setHeader.bind(response),
    status(code: number) {
      response.statusCode = code
      return this
    },
    json(body: unknown) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
      return this
    },
  }
}
