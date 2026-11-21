// Tallymark from Java 11+, standard library only.
//
//   TALLYMARK_API_KEY=... java examples/http/Java.java
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
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class Java {
    static final String BASE = System.getenv().getOrDefault("TALLYMARK_URL", "http://localhost:3000");
    static final String KEY = System.getenv("TALLYMARK_API_KEY");
    static final HttpClient HTTP = HttpClient.newHttpClient();

    // Forward the *visitor's* User-Agent and IP from the request you are handling.
    // (Run the server with TALLYMARK_TRUST_PROXY=true so it reads X-Forwarded-For.)
    static final String VISITOR_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
    static final String VISITOR_IP = "203.0.113.9";

    static String send(HttpRequest request) throws Exception {
        HttpResponse<String> res = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() >= 300) {
            throw new RuntimeException(request.method() + " " + request.uri().getPath() + " -> " + res.statusCode() + " " + res.body());
        }
        return res.body();
    }

    static void track(String json) throws Exception {
        send(HttpRequest.newBuilder(URI.create(BASE + "/collect"))
                .header("User-Agent", VISITOR_UA)
                .header("X-Forwarded-For", VISITOR_IP)
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build());
    }

    static String read(String path) throws Exception {
        return send(HttpRequest.newBuilder(URI.create(BASE + path))
                .header("Authorization", "Bearer " + KEY)
                .GET()
                .build());
    }

    public static void main(String[] args) throws Exception {
        if (KEY == null) throw new IllegalStateException("set TALLYMARK_API_KEY");

        // 1. A pageview.
        track("{\"url\":\"https://shop.example/pricing?utm_source=example-java\",\"referrer\":\"https://news.ycombinator.com/\"}");

        // 2. A custom event with props and a numeric value (revenue).
        track("{\"name\":\"Signup\",\"url\":\"https://shop.example/signup\",\"props\":{\"plan\":\"pro\"},\"value\":49}");

        // 3. Read it back.
        System.out.println(read("/api/summary?range=1h"));
        System.out.println(read("/api/top?by=event&range=1h"));
    }
}
