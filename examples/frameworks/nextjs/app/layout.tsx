// The root layout: one component loads the tracker on every page, including client-side
// navigations in the App Router. Nothing else is needed for pageviews and time on page.
import type { ReactNode } from 'react'
import { Analytics } from 'tallymark/react'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics api="/api/analytics" outbound downloads />
      </body>
    </html>
  )
}
