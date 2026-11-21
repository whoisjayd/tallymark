// A Vite / Create React App / React Router app.
//
// <Analytics /> loads the tracker script once and renders nothing. From then on, with no further code:
// pageviews (including React Router navigation), sources and campaigns, device, language, screen size,
// location, time on page and scroll depth are all recorded. You add only the events that matter to you.
import { createRoot } from 'react-dom/client'
import { Analytics, track } from 'tallymark/react'

function App() {
  return (
    <>
      <h1>Hello</h1>

      {/* Way 1: attributes, no JavaScript. The element's click sends event "Signup" with plan = "pro". */}
      <button type="button" data-tally="Signup" data-tally-plan="pro">
        Sign up
      </button>

      {/* Way 2: from code. track(name, properties?, value?). The value is added up as revenue. */}
      <button type="button" onClick={() => track('Purchase', { sku: 'A1' }, 49)}>
        Buy
      </button>

      {/* Mount once, anywhere. api = where Tallymark runs.
          outbound   also record clicks on links to other sites
          downloads  also record clicks on files (.pdf .zip ...) */}
      <Analytics api="https://stats.example.com" outbound downloads />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
