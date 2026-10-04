import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

// Static assets use public/_headers; SSR HTML needs the same isolation headers.
export default createServerEntry({
  async fetch(request, options) {
    const response = await handler.fetch(request, options)
    const headers = new Headers(response.headers)
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
})
