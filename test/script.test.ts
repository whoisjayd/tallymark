import { describe, expect, test } from 'bun:test'
import { TRACKER } from '../src/script'

/**
 * Runs the real tracker string against a minimal fake browser, so every branch of
 * the script is exercised without a DOM library. examples/browser is the same
 * script in a real browser.
 */
function browser(
  opts: {
    host?: string
    dataset?: Record<string, string>
    webdriver?: boolean
    ignore?: boolean
    src?: string
    width?: number
  } = {},
) {
  const beacons: { url: string; body: any }[] = []
  const winListeners: Record<string, ((e?: any) => void)[]> = {}
  const docListeners: Record<string, ((e?: any) => void)[]> = {}
  const timers: (() => void)[] = []
  let clock = 1_000_000

  const location = {
    href: `https://${opts.host ?? 'example.com'}/start`,
    hostname: opts.host ?? 'example.com',
    pathname: '/start',
    search: '',
  }
  const history = {
    pushState(_s: unknown, _t: string, url: string) {
      location.pathname = url
      location.href = `https://${location.hostname}${url}`
    },
  }
  const script = {
    dataset: opts.dataset ?? {},
    src: opts.src ?? 'https://stats.example.com/script.js',
  }
  const documentElement = { scrollHeight: 2000, scrollTop: 0 }
  const document = {
    currentScript: script,
    referrer: 'https://news.ycombinator.com/',
    visibilityState: 'visible',
    documentElement,
    addEventListener: (t: string, fn: (e?: any) => void) => {
      const list = docListeners[t] ?? []
      docListeners[t] = list
      list.push(fn)
    },
  }
  const win: any = { innerWidth: opts.width ?? 1280, innerHeight: 800, pageYOffset: 0 }

  const run = new Function(
    'document',
    'location',
    'history',
    'navigator',
    'localStorage',
    'window',
    'addEventListener',
    'setTimeout',
    'URL',
    'Blob',
    'fetch',
    'Date',
    TRACKER,
  )
  run(
    document,
    location,
    history,
    {
      webdriver: opts.webdriver,
      sendBeacon: (url: string, blob: unknown) => {
        beacons.push({ url, body: blob })
        return true
      },
    },
    { getItem: (k: string) => (k === 'tallymark_ignore' && opts.ignore ? 'true' : null) },
    win,
    (t: string, fn: (e?: any) => void) => {
      const list = winListeners[t] ?? []
      winListeners[t] = list
      list.push(fn)
    },
    (fn: () => void) => {
      timers.push(fn)
    },
    URL,
    class {
      constructor(public parts: string[]) {}
      text() {
        return this.parts.join('')
      }
    },
    () => Promise.resolve(),
    { now: () => clock },
  )

  const fire = (l: Record<string, ((e?: any) => void)[]>, type: string, e?: any) => {
    for (const fn of l[type] ?? []) fn(e)
  }
  return {
    beacons,
    sent: () => beacons.map((b) => ({ url: b.url, ...JSON.parse(b.body.text()) })),
    click: (el: any) => fire(docListeners, 'click', { target: { closest: () => el } }),
    flush: () => {
      for (const t of timers.splice(0)) t()
    },
    advance: (ms: number) => {
      clock += ms
    },
    scrollTo: (y: number) => {
      win.pageYOffset = y
      fire(winListeners, 'scroll')
    },
    hide: () => {
      document.visibilityState = 'hidden'
      fire(docListeners, 'visibilitychange')
    },
    show: () => {
      document.visibilityState = 'visible'
      fire(docListeners, 'visibilitychange')
    },
    leave: () => fire(winListeners, 'pagehide'),
    win,
    history,
  }
}

describe('tracker: pageviews and events', () => {
  test('sends a pageview on load with the URL, referrer and viewport width, to the script origin', () => {
    const b = browser()
    expect(b.beacons[0]!.url).toBe('https://stats.example.com/collect')
    expect(b.sent()[0]).toMatchObject({
      url: 'https://example.com/start',
      referrer: 'https://news.ycombinator.com/',
      w: 1280,
    })
  })

  test('endpoint follows the script URL, including a mounted prefix', () => {
    expect(browser({ src: 'https://example.com/analytics/script.js?v=2' }).beacons[0]!.url).toBe(
      'https://example.com/analytics/collect',
    )
  })

  test('data-api overrides the endpoint; trailing slash is trimmed', () => {
    expect(browser({ dataset: { api: 'https://api.example.com/' } }).beacons[0]!.url).toBe(
      'https://api.example.com/collect',
    )
  })

  test('single-page navigation sends a pageview; the same path is not sent twice', () => {
    const b = browser()
    b.history.pushState({}, '', '/pricing')
    b.flush()
    b.history.pushState({}, '', '/pricing')
    b.flush()
    expect(
      b
        .sent()
        .filter((e) => !e.name)
        .map((e) => e.url),
    ).toEqual(['https://example.com/start', 'https://example.com/pricing'])
  })

  test('an in-site navigation reports the previous page as its referrer, not the original external one', () => {
    const b = browser()
    b.history.pushState({}, '', '/pricing')
    b.flush()
    const pricing = b.sent().find((e) => e.url === 'https://example.com/pricing')!
    // The server drops same-site referrers, so the external visit is not counted twice.
    expect(pricing.referrer).toBe('https://example.com/start')
  })

  test('window.tallymark.track sends a named event with props, value and width', () => {
    const b = browser({ width: 390 })
    b.win.tallymark.track('Signup', { plan: 'pro' }, 49)
    expect(b.sent()[1]).toMatchObject({ name: 'Signup', props: { plan: 'pro' }, value: 49, w: 390 })
  })

  test('data-auto="false" disables automatic pageviews but keeps track()', () => {
    const b = browser({ dataset: { auto: 'false' } })
    expect(b.beacons.length).toBe(0)
    b.win.tallymark.track('x')
    expect(b.beacons.length).toBe(1)
  })

  test('data-tally click sends the event with data-tally-* props', () => {
    const b = browser()
    b.click({
      getAttribute: (n: string) => (n === 'data-tally' ? 'Join' : null),
      attributes: [
        { name: 'data-tally', value: 'Join' },
        { name: 'data-tally-plan', value: 'pro' },
      ],
    })
    expect(b.sent()[1]).toMatchObject({ name: 'Join', props: { plan: 'pro' } })
  })

  test('outbound and download links are tracked only when enabled', () => {
    const link = (href: string, hostname: string, pathname: string) => ({
      getAttribute: () => null,
      attributes: [],
      href,
      hostname,
      pathname,
    })
    const off = browser()
    off.click(link('https://other.com/x?token=1', 'other.com', '/x'))
    expect(off.beacons.length).toBe(1) // pageview only

    const on = browser({ dataset: { outbound: 'true', downloads: 'true' } })
    on.click(link('https://other.com/x?token=1#h', 'other.com', '/x'))
    on.click(link('https://example.com/a.PDF', 'example.com', '/a.PDF'))
    on.click(link('https://example.com/page', 'example.com', '/page'))
    expect(on.sent().slice(1)).toMatchObject([
      { name: 'outbound', props: { url: 'https://other.com/x' } }, // query and fragment stripped
      { name: 'download', props: { file: '/a.PDF' } },
    ])
  })

  test('sends nothing from localhost (unless allowed), automation, or an ignore flag', () => {
    expect(browser({ host: 'localhost' }).beacons.length).toBe(0)
    expect(browser({ host: '127.0.0.1' }).beacons.length).toBe(0)
    expect(browser({ host: 'localhost', dataset: { localhost: 'true' } }).beacons.length).toBe(1)
    expect(browser({ webdriver: true }).beacons.length).toBe(0)
    expect(browser({ ignore: true }).beacons.length).toBe(0)
  })

  test('writes no cookies or storage', () => {
    expect(TRACKER).not.toMatch(/document\.cookie|setItem|sessionStorage/)
  })
})

describe('tracker: time on page', () => {
  test('leaving the page reports engaged time and scroll depth', () => {
    const b = browser()
    b.advance(30_000)
    b.scrollTo(600) // 600 of 1200 scrollable pixels
    b.leave()
    expect(b.sent()[1]).toMatchObject({
      name: 'engagement',
      url: 'https://example.com/start',
      d: 30_000,
      s: 50,
    })
  })

  test('time in a hidden tab is not counted, and the total is cumulative', () => {
    const b = browser()
    b.advance(10_000)
    b.hide() // reports 10s
    b.advance(60_000) // tab in the background: not engaged
    b.show()
    b.advance(5_000)
    b.leave()
    const engagement = b.sent().filter((e) => e.name === 'engagement')
    expect(engagement.map((e) => e.d)).toEqual([10_000, 15_000])
  })

  test('nothing is sent again if engaged time did not grow', () => {
    const b = browser()
    b.advance(4_000)
    b.hide()
    b.hide()
    b.leave()
    expect(b.sent().filter((e) => e.name === 'engagement').length).toBe(1)
  })

  test('a single-page navigation closes the page being left before opening the next', () => {
    const b = browser()
    b.advance(8_000)
    b.history.pushState({}, '', '/pricing')
    b.flush()
    const kinds = b
      .sent()
      .map((e) => (e.name === 'engagement' ? `engagement ${e.url} ${e.d}` : `pageview ${e.url}`))
    expect(kinds).toEqual([
      'pageview https://example.com/start',
      'engagement https://example.com/start 8000',
      'pageview https://example.com/pricing',
    ])
  })

  test('scroll depth only ever increases, and is 100 on a page that does not scroll', () => {
    const b = browser()
    b.scrollTo(1200)
    b.scrollTo(300) // scrolling back up does not lower the maximum
    b.advance(1_000)
    b.leave()
    expect(b.sent()[1]).toMatchObject({ s: 100 })
  })

  test('data-engagement="false" turns it off', () => {
    const b = browser({ dataset: { engagement: 'false' } })
    b.advance(5_000)
    b.leave()
    expect(b.sent().some((e) => e.name === 'engagement')).toBe(false)
  })
})

describe('tracker: size', () => {
  test('stays under its 6 KB budget (about 1.7 KB gzipped)', () => {
    expect(TRACKER.length).toBeLessThan(6144)
  })
})
