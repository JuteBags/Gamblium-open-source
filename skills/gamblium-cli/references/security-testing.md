# Security testing with Gamblium

**Only for targets the person owns or is authorised to test** (their own
machine and network, or a bug-bounty / engagement scope they wrote down).
Never help get around the scope check.

## Scope

`audit` and `scan` accept this machine, the local network, and hosts listed
in the person's scope file. Agents can read it (`scope-list`,
`scope-check host=...`) but not add to it: there is no command for that, on
purpose. A refused target means: ask the person to add it.

## Commands

```
gamblium ctl scope-check host=staging.example.com
gamblium ctl audit url=https://staging.example.com/ cve=true   # two plain GETs: headers, cookies, CORS, versions
gamblium ctl scan target=staging.example.com ports=80,443,8000-8100
gamblium ctl cve product=nginx version=1.18.0                  # asks the US NVD; sends the name and version
```
The same exist as `gamblium audit|scan|cve` and as `gamblium-cli <name> ...`.

## Pen-test profile

```
gamblium launch --pentest --proxy http://127.0.0.1:8080 --tls-keylog D:\keys.log
```
- Its own profile folder, separate from the person's and the agent's.
- `--proxy` sends every request through Burp, mitmproxy or ZAP; Brave's own
  update and filter-list traffic is switched off there so the proxy sees only
  the target.
- `--tls-keylog` writes TLS keys for Wireshark (QUIC included). Refused on
  the person's main profile, which would leak every login.
- Request capture inside the browser: `capture-start`, `capture-list`,
  `capture-get id=<n>` (full headers and a curl command). Response bodies
  are not captured: use the proxy for those.
- The **Security check-up** page (right-click on a page) shows the audit of
  the current page for a person.
