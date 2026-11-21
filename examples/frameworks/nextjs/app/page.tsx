'use client'
// Custom events from a client component, and a server-side event from a server action.
import { track } from 'tallymark/react'

export default function Home() {
  return (
    <main>
      <h1>Pricing</h1>

      {/* No JavaScript needed: attributes become the event name and its properties. */}
      <button type="button" data-tally="Signup" data-tally-plan="pro">
        Start free trial
      </button>

      {/* Or call track() with a numeric value (revenue). */}
      <button type="button" onClick={() => track('Purchase', { sku: 'A1' }, 49)}>
        Buy now
      </button>
    </main>
  )
}
