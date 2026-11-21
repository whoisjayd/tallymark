#!/usr/bin/env python3
"""Tallymark from Python, standard library only.

    TALLYMARK_API_KEY=... python3 examples/http/python.py

How this works
  1. POST /collect records a hit. The body is JSON: { url, name?, props?, value?, referrer? }.
     Leave out `name` for a pageview; give a `name` for a custom event ("Signup", "Purchase").
  2. GET /api/... reads numbers back. It needs the API key as "Authorization: Bearer <key>".
     Ranges: ?range=1h|24h|7d|30d|90d|365d. Break down with /api/top?by=country|channel|device|path|prop:plan ...

Why forward the visitor's User-Agent and X-Forwarded-For?
  Tallymark works out browser, OS, device and country from the request it receives. If your backend sends
  the hit, that request is YOURS, so without these two headers every visitor would look like your server.
  Forward the real values from the request you are handling. (The server must run with
  TALLYMARK_TRUST_PROXY=true, or trustProxy: true, to read X-Forwarded-For.) If you cannot, the hit is
  still recorded, as an anonymous visitor with no device or location.

Responses
  202  accepted, OR deliberately ignored (bot, Do-Not-Track, your own IP). Ignored hits are not errors.
  422  the url was not a valid http(s) URL     429  too many hits from one IP     403  origin not allowed
  401  (read API) missing or wrong API key     503  the database is unavailable: retry later
"""
import json
import os
import urllib.request

URL = os.environ.get("TALLYMARK_URL", "http://localhost:3000")
KEY = os.environ["TALLYMARK_API_KEY"]

# Forward the *visitor's* User-Agent and IP from the request you are handling.
# (Run the server with TALLYMARK_TRUST_PROXY=true so it reads X-Forwarded-For.)
VISITOR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    "X-Forwarded-For": "203.0.113.9",
}


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req) as res:
        return json.load(res)


def track(body):
    return call("POST", "/collect", body, VISITOR)


def read(path):
    return call("GET", path, headers={"Authorization": f"Bearer {KEY}"})


# 1. A pageview.
track({"url": "https://shop.example/pricing?utm_source=example-python", "referrer": "https://news.ycombinator.com/"})

# 2. A custom event with props and a numeric value (revenue).
track({"name": "Signup", "url": "https://shop.example/signup", "props": {"plan": "pro"}, "value": 49})

# 3. Read it back.
print(read("/api/summary?range=1h")["data"])
print(read("/api/top?by=event&range=1h")["data"])
