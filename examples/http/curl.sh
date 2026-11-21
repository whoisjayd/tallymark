#!/bin/sh
# Tallymark from the shell: the HTTP API is all you need, in any language.
#   TALLYMARK_API_KEY=... sh examples/http/curl.sh
#
# How this works
#   1. POST /collect records a hit. The body is JSON: { url, name?, props?, value?, referrer? }.
#      Leave out `name` for a pageview; give a `name` for a custom event ("Signup", "Purchase").
#   2. GET /api/... reads numbers back. It needs the API key as "Authorization: Bearer <key>".
#      Ranges: ?range=1h|24h|7d|30d|90d|365d. Break down with /api/top?by=country|channel|device|path|prop:plan ...
#
# Why forward the visitor's User-Agent and X-Forwarded-For?
#   Tallymark works out browser, OS, device and country from the request it receives. If your backend sends
#   the hit, that request is YOURS, so without these two headers every visitor would look like your server.
#   Forward the real values from the request you are handling. (The server must run with
#   TALLYMARK_TRUST_PROXY=true, or trustProxy: true, to read X-Forwarded-For.) If you cannot, the hit is
#   still recorded, as an anonymous visitor with no device or location.
#
# Responses
#   202  accepted, OR deliberately ignored (bot, Do-Not-Track, your own IP). Ignored hits are not errors.
#   422  the url was not a valid http(s) URL     429  too many hits from one IP     403  origin not allowed
#   401  (read API) missing or wrong API key     503  the database is unavailable: retry later
set -eu

URL="${TALLYMARK_URL:-http://localhost:3000}"
KEY="${TALLYMARK_API_KEY:?set TALLYMARK_API_KEY}"

# When you send hits from your own backend, forward the *visitor's* User-Agent and IP.
# (Run the server with TALLYMARK_TRUST_PROXY=true so it reads X-Forwarded-For.)
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
IP='203.0.113.9'

# 1. A pageview.
curl -fsS -X POST "$URL/collect" -H "user-agent: $UA" -H "x-forwarded-for: $IP" \
  -d '{"url":"https://shop.example/pricing?utm_source=example-curl","referrer":"https://news.ycombinator.com/"}'
echo

# 2. A custom event with props and a numeric value (revenue).
curl -fsS -X POST "$URL/collect" -H "user-agent: $UA" -H "x-forwarded-for: $IP" \
  -d '{"name":"Signup","url":"https://shop.example/signup","props":{"plan":"pro"},"value":49}'
echo

# 3. Read it back. Every /api/* route needs the API key.
curl -fsS "$URL/api/summary?range=1h" -H "authorization: Bearer $KEY"
echo
curl -fsS "$URL/api/top?by=event&range=1h" -H "authorization: Bearer $KEY"
echo
