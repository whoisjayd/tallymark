<?php
// Tallymark from PHP, no extensions or packages needed.
//
//   TALLYMARK_API_KEY=... php examples/http/php.php
//
// How this works
//   1. POST /collect records a hit. The body is JSON: { url, name?, props?, value?, referrer? }.
//      Leave out `name` for a pageview; give a `name` for a custom event ("Signup", "Purchase").
//   2. GET /api/... reads numbers back. It needs the API key as "Authorization: Bearer <key>".
//      Ranges: ?range=1h|24h|7d|30d|90d|365d. Break down with /api/top?by=country|channel|device|path|prop:plan ...
//
// Why forward the visitor's User-Agent and X-Forwarded-For?
//   Tallymark works out browser, OS, device and country from the request it receives. If your backend sends
//   the hit, that request is YOURS, so without these two headers every visitor would look like your server.
//   Forward the real values from the request you are handling. (The server must run with
//   TALLYMARK_TRUST_PROXY=true, or trustProxy: true, to read X-Forwarded-For.) If you cannot, the hit is
//   still recorded, as an anonymous visitor with no device or location.
//
// Responses
//   202  accepted, OR deliberately ignored (bot, Do-Not-Track, your own IP). Ignored hits are not errors.
//   422  the url was not a valid http(s) URL     429  too many hits from one IP     403  origin not allowed
//   401  (read API) missing or wrong API key     503  the database is unavailable: retry later

$url = getenv('TALLYMARK_URL') ?: 'http://localhost:3000';
$key = getenv('TALLYMARK_API_KEY') ?: die("set TALLYMARK_API_KEY\n");

// Forward the *visitor's* User-Agent and IP from the request you are handling.
// (Run the server with TALLYMARK_TRUST_PROXY=true so it reads X-Forwarded-For.)
$visitor = [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'X-Forwarded-For: 203.0.113.9',
];

function call(string $method, string $path, array $headers = [], ?array $body = null): string {
    global $url;
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
    }
    $ctx = stream_context_create(['http' => [
        'method' => $method,
        'header' => implode("\r\n", $headers),
        'content' => $body === null ? '' : json_encode($body),
        'ignore_errors' => true,
    ]]);
    // A stream (not file_get_contents) so the status line is available on every PHP version.
    $stream = fopen($url . $path, 'r', false, $ctx);
    $out = stream_get_contents($stream);
    $status = (int) explode(' ', stream_get_meta_data($stream)['wrapper_data'][0])[1];
    fclose($stream);
    if ($status >= 300) {
        throw new RuntimeException("$method $path -> $status $out");
    }
    return $out;
}

function track(array $body): void {
    global $visitor;
    call('POST', '/collect', $visitor, $body);
}

function read(string $path): string {
    global $key;
    return call('GET', $path, ["Authorization: Bearer $key"]);
}

// 1. A pageview.
track(['url' => 'https://shop.example/pricing?utm_source=example-php', 'referrer' => 'https://news.ycombinator.com/']);

// 2. A custom event with props and a numeric value (revenue).
track(['name' => 'Signup', 'url' => 'https://shop.example/signup', 'props' => ['plan' => 'pro'], 'value' => 49]);

// 3. Read it back.
echo read('/api/summary?range=1h'), "\n";
echo read('/api/top?by=event&range=1h'), "\n";
