// A deliberately weak web server for testing `gamblium audit` and `gamblium scan`
// on this machine only. It listens on 127.0.0.1 and does nothing dangerous: it
// just sends the kind of headers a badly configured site sends.
//
//   node tools/vuln-server.mjs [port]      (default 8099)
//
//   /         weak: no security headers, loose cookie, reflects any Origin with
//             credentials, discloses an old Apache and PHP version
//   /secure   well configured: should produce no findings

import http from "node:http";

const port = Number(process.argv[2] || 8099);

http
  .createServer((req, res) => {
    if (req.url.startsWith("/secure")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Set-Cookie": "sid=abc123; Path=/; HttpOnly; SameSite=Lax",
        Server: "web",
      });
      res.end("<!doctype html><title>secure</title><p>Well configured page.</p>");
      return;
    }
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      Server: "Apache/2.4.49 (Unix) OpenSSL/1.1.1k",
      "X-Powered-By": "PHP/7.4.3",
      "Set-Cookie": ["session=deadbeef; Path=/", "tracking=1"],
    };
    if (req.headers.origin) {
      headers["Access-Control-Allow-Origin"] = req.headers.origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    res.writeHead(200, headers);
    res.end("<!doctype html><title>weak</title><p>Deliberately weak test page.</p>");
  })
  .listen(port, "127.0.0.1", () => console.log(`weak test server on http://127.0.0.1:${port}/`));
