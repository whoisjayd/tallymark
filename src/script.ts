/**
 * The browser tracker, served at `/script.js`. Plain JavaScript in a string so it
 * needs no build step and cannot drift from what is served.
 *
 * It sets no cookies and writes nothing to storage. Config is read from the
 * <script> tag: data-api, data-auto, data-outbound, data-downloads,
 * data-engagement ("false" turns off time-on-page), data-localhost.
 *
 * Exposes `window.tallymark.track(name, props?, value?)` and `.pageview()`.
 * Elements with `data-tally="Name"` send that event on click; extra props are
 * `data-tally-*` attributes (`data-tally-plan="pro"` sends `{ plan: "pro" }`).
 *
 * Time on page: engaged time (tab visible) and the deepest scroll position are
 * sent as a cumulative `engagement` beacon when the page is hidden, left, or
 * replaced by a single-page-app navigation. The server keeps the largest value.
 */
export const TRACKER = `(function () {
  var s = document.currentScript
  if (!s) return
  var d = s.dataset
  // Default: wherever this script was served from, so a mounted prefix just works.
  var api = (d.api || s.src.replace(/\\/script\\.js.*$/, '')).replace(/\\/$/, '')
  var endpoint = api + '/collect'
  var last = ''
  var ref = document.referrer
  var cur = ''
  var engaged = 0
  var since = 0
  var sent = 0
  var maxScroll = 0

  function skip() {
    if (d.localhost !== 'true' && /^(localhost|127\\.|\\[::1\\])/.test(location.hostname)) return true
    if (navigator.webdriver) return true
    try { return localStorage.getItem('tallymark_ignore') === 'true' } catch (e) { return false }
  }

  function send(body) {
    if (skip()) return
    body.w = window.innerWidth
    var payload = JSON.stringify(body)
    // text/plain keeps this a "simple" CORS request, so there is no preflight.
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([payload], { type: 'text/plain' }))) return
    } catch (e) {}
    fetch(endpoint, { method: 'POST', body: payload, headers: { 'content-type': 'text/plain' }, keepalive: true }).catch(function () {})
  }

  function visible() { return document.visibilityState !== 'hidden' }
  function total() { return engaged + (since ? Date.now() - since : 0) }

  function scrolled() {
    var el = document.documentElement
    var room = el.scrollHeight - window.innerHeight
    var pct = room > 0 ? Math.round(((window.pageYOffset || el.scrollTop || 0) / room) * 100) : 100
    if (pct > maxScroll) maxScroll = Math.min(100, pct)
  }

  // Cumulative engaged time for the page being left. Sent again only if it grew.
  function report() {
    if (d.engagement === 'false' || !cur) return
    var ms = total()
    if (ms < 1 || ms === sent) return
    sent = ms
    send({ name: 'engagement', url: cur, d: ms, s: maxScroll })
  }

  var t = {
    pageview: function () {
      var path = location.pathname + location.search
      if (path === last) return
      report()
      last = path
      cur = location.href
      engaged = 0
      sent = 0
      maxScroll = 0
      since = visible() ? Date.now() : 0
      scrolled()
      send({ url: cur, referrer: ref || undefined })
      // The next page was reached from this one. Same-site referrers are dropped server-side.
      ref = cur
    },
    track: function (name, props, value) {
      send({ name: name, url: location.href, props: props, value: value })
    }
  }
  window.tallymark = t

  document.addEventListener('visibilitychange', function () {
    if (visible()) {
      since = Date.now()
    } else {
      if (since) engaged += Date.now() - since
      since = 0
      report()
    }
  })
  addEventListener('pagehide', report)
  addEventListener('scroll', scrolled, { passive: true })

  if (d.auto !== 'false') {
    // Single-page apps change the URL without a page load.
    var push = history.pushState
    history.pushState = function () {
      var r = push.apply(this, arguments)
      setTimeout(t.pageview, 0)
      return r
    }
    addEventListener('popstate', t.pageview)
    if (document.visibilityState === 'prerender') {
      document.addEventListener('visibilitychange', t.pageview, { once: true })
    } else {
      t.pageview()
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('a,[data-tally]')
    if (!el) return
    var name = el.getAttribute('data-tally')
    if (name) {
      var props = {}
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i]
        if (a.name.indexOf('data-tally-') === 0) props[a.name.slice(11)] = a.value
      }
      return t.track(name, props)
    }
    if (!el.href) return
    if (d.downloads === 'true' && /\\.(pdf|zip|gz|dmg|exe|msi|pkg|csv|xlsx?|docx?|pptx?|mp[34]|mov)$/i.test(el.pathname)) {
      t.track('download', { file: el.pathname })
    } else if (d.outbound === 'true' && el.hostname && el.hostname !== location.hostname) {
      t.track('outbound', { url: el.href.split(/[?#]/)[0] })
    }
  })
})()
`
