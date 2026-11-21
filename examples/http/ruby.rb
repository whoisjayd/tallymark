# Tallymark from Ruby, standard library only.
#
#   TALLYMARK_API_KEY=... ruby examples/http/ruby.rb
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
require 'json'
require 'net/http'

BASE = URI(ENV.fetch('TALLYMARK_URL', 'http://localhost:3000'))
KEY = ENV.fetch('TALLYMARK_API_KEY')

# Forward the *visitor's* User-Agent and IP from the request you are handling.
# (Run the server with TALLYMARK_TRUST_PROXY=true so it reads X-Forwarded-For.)
VISITOR = {
  'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  'X-Forwarded-For' => '203.0.113.9'
}.freeze

def call(request)
  res = Net::HTTP.start(BASE.host, BASE.port) { |http| http.request(request) }
  raise "#{request.method} #{request.path} -> #{res.code} #{res.body}" unless res.code.to_i < 300

  res.body
end

def track(body)
  request = Net::HTTP::Post.new('/collect', VISITOR)
  request.body = body.to_json
  call(request)
end

def read(path)
  call(Net::HTTP::Get.new(path, 'Authorization' => "Bearer #{KEY}"))
end

# 1. A pageview.
track(url: 'https://shop.example/pricing?utm_source=example-ruby', referrer: 'https://news.ycombinator.com/')

# 2. A custom event with props and a numeric value (revenue).
track(name: 'Signup', url: 'https://shop.example/signup', props: { plan: 'pro' }, value: 49)

# 3. Read it back.
puts read('/api/summary?range=1h')
puts read('/api/top?by=event&range=1h')
