import { useEffect } from 'react'

type Props = Record<string, string | number | boolean>

export interface AnalyticsProps {
  /** Base URL of your tallymark API, e.g. `https://stats.example.com`, or `/api/analytics`. */
  api: string
  outbound?: boolean
  downloads?: boolean
  localhost?: boolean
}

declare global {
  interface Window {
    tallymark?: { track(name: string, props?: Props, value?: number): void }
  }
}

/**
 * Loads the tracker script once. Renders nothing. Mount near the root:
 *
 *   <Analytics api="https://stats.example.com" outbound />
 *
 * Route changes are picked up automatically (History API), including the
 * Next.js App Router and React Router.
 */
export function Analytics({ api, outbound, downloads, localhost }: AnalyticsProps) {
  useEffect(() => {
    // StrictMode mounts twice in development; load the script only once.
    if (document.querySelector('script[data-tallymark]')) return
    const s = document.createElement('script')
    s.src = `${api.replace(/\/$/, '')}/script.js`
    s.async = true
    s.dataset.tallymark = ''
    s.dataset.api = api
    if (outbound) s.dataset.outbound = 'true'
    if (downloads) s.dataset.downloads = 'true'
    if (localhost) s.dataset.localhost = 'true'
    document.head.append(s)
  }, [api, outbound, downloads, localhost])
  return null
}

/** Send a custom event. A no-op on the server and until the script has loaded. */
export function track(name: string, props?: Props, value?: number) {
  if (typeof window !== 'undefined') window.tallymark?.track(name, props, value)
}
