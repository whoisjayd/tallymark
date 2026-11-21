// Tallymark from Go, standard library only.
//
//	TALLYMARK_API_KEY=... go run examples/http/go.go
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
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

var (
	baseURL = env("TALLYMARK_URL", "http://localhost:3000")
	apiKey  = os.Getenv("TALLYMARK_API_KEY")
)

// Forward the *visitor's* User-Agent and IP from the request you are handling.
// (Run the server with TALLYMARK_TRUST_PROXY=true so it reads X-Forwarded-For.)
const (
	visitorUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"
	visitorIP = "203.0.113.9"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func do(req *http.Request) string {
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		panic(fmt.Sprintf("%s %s -> %d %s", req.Method, req.URL.Path, res.StatusCode, out))
	}
	return string(out)
}

func track(body map[string]any) {
	payload, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", baseURL+"/collect", bytes.NewReader(payload))
	req.Header.Set("User-Agent", visitorUA)
	req.Header.Set("X-Forwarded-For", visitorIP)
	do(req)
}

func read(path string) string {
	req, _ := http.NewRequest("GET", baseURL+path, nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	return do(req)
}

func main() {
	if apiKey == "" {
		panic("set TALLYMARK_API_KEY")
	}

	// 1. A pageview.
	track(map[string]any{"url": "https://shop.example/pricing?utm_source=example-go", "referrer": "https://news.ycombinator.com/"})

	// 2. A custom event with props and a numeric value (revenue).
	track(map[string]any{"name": "Signup", "url": "https://shop.example/signup", "props": map[string]any{"plan": "pro"}, "value": 49})

	// 3. Read it back.
	fmt.Println(read("/api/summary?range=1h"))
	fmt.Println(read("/api/top?by=event&range=1h"))
}
