/*
 * The deployed twin of the `/nim` dev proxy in vite.config.ts.
 *
 * NVIDIA's API sends no CORS headers, and the key must never reach the bundle,
 * so the browser talks to its own origin and this function adds the header.
 * `vercel.json` rewrites /nim/* here, which keeps the app's default
 * VITE_LLM_BASE ('/nim/v1') working unchanged in production.
 */

const UPSTREAM = 'https://integrate.api.nvidia.com'

export default async function handler(request: Request): Promise<Response> {
  const key = process.env.NIM_API_KEY?.trim()
  if (!key) {
    return new Response(JSON.stringify({ error: 'NIM_API_KEY is not set' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = new URL(request.url)
  const target = UPSTREAM + url.pathname.replace(/^\/(api\/)?nim/, '') + url.search

  const headers = new Headers(request.headers)
  headers.set('authorization', `Bearer ${key}`)
  headers.delete('host')
  headers.delete('content-length')

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    // @ts-expect-error — required by undici to stream a request body
    duplex: 'half',
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  })
}
