//! Passive web security audit: reads response headers and reports weak or
//! missing protections. It sends two ordinary GET requests and nothing else:
//! no payloads, no fuzzing, no login attempts.
//!
//! The same scope rule as `scan` applies (see main.rs).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
}

#[derive(Debug, Serialize)]
pub struct Finding {
    pub severity: Severity,
    /// Short stable id, e.g. "csp-missing".
    pub id: &'static str,
    pub title: String,
    pub detail: String,
}

/// Response headers as (lower-case name, value), repeated names kept.
pub type Headers = Vec<(String, String)>;

fn get<'a>(h: &'a Headers, name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn all<'a>(h: &'a Headers, name: &str) -> Vec<&'a str> {
    h.iter().filter(|(k, _)| k == name).map(|(_, v)| v.as_str()).collect()
}

/// The origin sent in the cross-origin probe. It does not exist.
pub const PROBE_ORIGIN: &str = "https://gamblium-audit.invalid";

/// `headers`: response to a plain GET. `cors`: response to the same GET sent
/// with `Origin: PROBE_ORIGIN`. `local`: the target is this machine or network.
pub fn analyse(https: bool, local: bool, headers: &Headers, cors: Option<&Headers>) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut add = |severity, id, title: &str, detail: String| {
        out.push(Finding { severity, id, title: title.to_owned(), detail })
    };

    if !https && !local {
        add(Severity::Medium, "no-https", "Served over plain HTTP",
            "Anyone on the network path can read and change this page.".into());
    }

    if https {
        match get(headers, "strict-transport-security") {
            None => add(Severity::Medium, "hsts-missing", "No Strict-Transport-Security header",
                "Browsers may still be downgraded to HTTP on a hostile network.".into()),
            Some(v) => {
                let max_age = v.split(';').filter_map(|p| p.trim().strip_prefix("max-age="))
                    .filter_map(|n| n.trim_matches('"').parse::<u64>().ok()).next().unwrap_or(0);
                if max_age < 15_552_000 {
                    add(Severity::Low, "hsts-short", "Strict-Transport-Security lasts under six months",
                        format!("max-age is {max_age} seconds."));
                }
            }
        }
    }

    let csp = get(headers, "content-security-policy");
    match csp {
        None => add(Severity::Medium, "csp-missing", "No Content-Security-Policy header",
            "Nothing limits which scripts the page may run, so an injected script runs freely.".into()),
        Some(v) => {
            let lower = v.to_ascii_lowercase();
            // The directive that governs scripts: script-src, else default-src.
            let directive = |name: &str| lower.split(';').map(str::trim).find(|d| d.split_whitespace().next() == Some(name));
            let scripts = directive("script-src").or(directive("default-src"));
            match scripts {
                None => add(Severity::Medium, "csp-no-script-rule", "Content-Security-Policy does not restrict scripts",
                    "It has neither script-src nor default-src.".into()),
                Some(d) => {
                    for (token, id, what) in [
                        ("'unsafe-inline'", "csp-unsafe-inline", "allows inline scripts"),
                        ("'unsafe-eval'", "csp-unsafe-eval", "allows eval()"),
                        (" *", "csp-wildcard", "allows scripts from any site"),
                    ] {
                        let hit = if token == " *" { d.split_whitespace().any(|t| t == "*") } else { d.contains(token) };
                        if hit {
                            add(Severity::Low, id, &format!("Content-Security-Policy {what}"), format!("Directive: {d}"));
                        }
                    }
                }
            }
        }
    }

    let frame_ancestors = csp.is_some_and(|v| v.to_ascii_lowercase().contains("frame-ancestors"));
    if get(headers, "x-frame-options").is_none() && !frame_ancestors {
        add(Severity::Medium, "clickjacking", "The page can be framed by any site",
            "Neither X-Frame-Options nor a frame-ancestors rule is set (clickjacking).".into());
    }

    if !get(headers, "x-content-type-options").is_some_and(|v| v.eq_ignore_ascii_case("nosniff")) {
        add(Severity::Low, "nosniff-missing", "No X-Content-Type-Options: nosniff",
            "Browsers may guess a file's type and run something uploaded as an image.".into());
    }

    match get(headers, "referrer-policy") {
        None => add(Severity::Low, "referrer-policy-missing", "No Referrer-Policy header",
            "Full page addresses may be sent to other sites.".into()),
        Some(v) if v.to_ascii_lowercase().contains("unsafe-url") => add(Severity::Low, "referrer-policy-unsafe",
            "Referrer-Policy is unsafe-url", "Full page addresses, query strings included, go to other sites.".into()),
        _ => {}
    }

    if get(headers, "permissions-policy").is_none() {
        add(Severity::Info, "permissions-policy-missing", "No Permissions-Policy header",
            "Camera, microphone and location are not explicitly switched off for embedded content.".into());
    }

    for cookie in all(headers, "set-cookie") {
        let name = cookie.split('=').next().unwrap_or("").trim().to_owned();
        let attrs: Vec<String> = cookie.split(';').skip(1).map(|a| a.trim().to_ascii_lowercase()).collect();
        let has = |a: &str| attrs.iter().any(|x| x == a || x.starts_with(&format!("{a}=")));
        let mut missing = Vec::new();
        if https && !has("secure") {
            missing.push("Secure");
        }
        if !has("httponly") {
            missing.push("HttpOnly");
        }
        if !has("samesite") {
            missing.push("SameSite");
        }
        if !missing.is_empty() {
            add(Severity::Medium, "cookie-flags", &format!("Cookie '{name}' lacks {}", missing.join(", ")),
                "Without HttpOnly a script can read it; without Secure it can travel over HTTP; without SameSite other sites can send it.".into());
        }
    }

    if let Some(c) = cors {
        let origin = get(c, "access-control-allow-origin");
        let creds = get(c, "access-control-allow-credentials").is_some_and(|v| v.eq_ignore_ascii_case("true"));
        match origin {
            Some(o) if o == PROBE_ORIGIN && creds => add(Severity::High, "cors-reflect-credentials",
                "Any website can read this page as the logged-in user",
                "Access-Control-Allow-Origin repeats whatever Origin is sent, with Allow-Credentials: true.".into()),
            Some(o) if o == PROBE_ORIGIN => add(Severity::Medium, "cors-reflect",
                "Access-Control-Allow-Origin repeats any Origin", "Any website can read this response (without cookies).".into()),
            Some("null") => add(Severity::Medium, "cors-null", "Access-Control-Allow-Origin allows the 'null' origin",
                "Sandboxed frames and local files count as 'null', so they can read this response.".into()),
            Some("*") => add(Severity::Info, "cors-any", "Access-Control-Allow-Origin is *",
                "Fine for public data; a problem if this response holds anything private.".into()),
            _ => {}
        }
    }

    for name in ["server", "x-powered-by", "x-aspnet-version", "x-generator"] {
        if let Some(v) = get(headers, name) {
            if v.chars().any(|c| c.is_ascii_digit()) {
                add(Severity::Low, "version-disclosed", &format!("Software version disclosed in the {name} header"),
                    format!("{name}: {v}"));
            }
        }
    }

    out.sort_by(|a, b| b.severity.cmp(&a.severity));
    out
}

/// Software names and versions found in banners or headers, e.g.
/// "Apache/2.4.49 (Unix) OpenSSL/1.1.1k" or "SSH-2.0-OpenSSH_8.9p1 Ubuntu".
pub fn detect_software(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '(' || c == ')') {
        // SSH banners look like SSH-2.0-OpenSSH_8.9p1.
        let token = token.strip_prefix("SSH-2.0-").or(token.strip_prefix("SSH-1.99-")).unwrap_or(token);
        let Some((name, version)) = token.split_once('/').or_else(|| token.split_once('_')) else { continue };
        let version: String =
            version.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
        let numeric = version.split('.').next().is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
        if name.is_empty() || !numeric || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
            continue;
        }
        let pair = (name.to_ascii_lowercase(), version);
        if !out.contains(&pair) {
            out.push(pair);
        }
    }
    out
}

/// NVD vendor and product names for the software we can recognise.
pub fn cpe_for(product: &str) -> Option<(&'static str, &'static str)> {
    Some(match product.to_ascii_lowercase().as_str() {
        "apache" | "httpd" | "apache-httpd" => ("apache", "http_server"),
        "nginx" => ("f5", "nginx"),
        "openssh" => ("openbsd", "openssh"),
        "openssl" => ("openssl", "openssl"),
        "php" => ("php", "php"),
        "microsoft-iis" | "iis" => ("microsoft", "internet_information_services"),
        "tomcat" | "apache-coyote" => ("apache", "tomcat"),
        "lighttpd" => ("lighttpd", "lighttpd"),
        "jetty" => ("eclipse", "jetty"),
        "node.js" | "node" | "nodejs" => ("nodejs", "node.js"),
        "express" => ("expressjs", "express"),
        "redis" => ("redis", "redis"),
        "mysql" => ("oracle", "mysql"),
        "postgresql" => ("postgresql", "postgresql"),
        "proftpd" => ("proftpd", "proftpd"),
        "vsftpd" => ("vsftpd_project", "vsftpd"),
        "exim" => ("exim", "exim"),
        "dropbear" => ("dropbear_ssh_project", "dropbear_ssh"),
        "wordpress" => ("wordpress", "wordpress"),
        "jquery" => ("jquery", "jquery"),
        _ => return None,
    })
}

#[derive(Debug, Serialize)]
pub struct Cve {
    pub id: String,
    pub score: Option<f64>,
    pub severity: Option<String>,
    pub published: String,
    pub summary: String,
}

/// Address of the NVD query for one exact product version.
pub fn nvd_url(vendor: &str, product: &str, version: &str) -> String {
    format!(
        "https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=cpe:2.3:a:{vendor}:{product}:{version}:*:*:*:*:*:*:*&resultsPerPage=2000"
    )
}

/// Picks the fields we show out of an NVD API 2.0 answer, worst first.
pub fn parse_nvd(json: &serde_json::Value) -> Vec<Cve> {
    let mut out: Vec<Cve> = json["vulnerabilities"]
        .as_array()
        .map(|v| v.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|item| {
            let cve = &item["cve"];
            let metric = ["cvssMetricV31", "cvssMetricV30", "cvssMetricV40", "cvssMetricV2"]
                .iter()
                .filter_map(|k| cve["metrics"][k].as_array().and_then(|a| a.first()))
                .next();
            let data = metric.map(|m| &m["cvssData"]);
            let summary = cve["descriptions"]
                .as_array()
                .and_then(|d| d.iter().find(|x| x["lang"] == "en"))
                .and_then(|x| x["value"].as_str())
                .unwrap_or("")
                .to_owned();
            Cve {
                id: cve["id"].as_str().unwrap_or("").to_owned(),
                score: data.and_then(|d| d["baseScore"].as_f64()),
                severity: data
                    .and_then(|d| d["baseSeverity"].as_str())
                    .or(metric.and_then(|m| m["baseSeverity"].as_str()))
                    .map(str::to_owned),
                published: cve["published"].as_str().unwrap_or("").chars().take(10).collect(),
                summary,
            }
        })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(b.published.cmp(&a.published)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> Headers {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn ids(f: &[Finding]) -> Vec<&str> {
        f.iter().map(|x| x.id).collect()
    }

    #[test]
    fn a_bare_https_response_gets_every_basic_finding() {
        let f = analyse(true, false, &h(&[("content-type", "text/html")]), None);
        let got = ids(&f);
        for want in ["hsts-missing", "csp-missing", "clickjacking", "nosniff-missing", "referrer-policy-missing", "permissions-policy-missing"] {
            assert!(got.contains(&want), "missing {want} in {got:?}");
        }
        assert!(!got.contains(&"no-https"));
        assert_eq!(f.first().unwrap().severity, Severity::Medium); // worst first
    }

    #[test]
    fn a_well_configured_response_is_clean() {
        let good = h(&[
            ("strict-transport-security", "max-age=31536000; includeSubDomains"),
            ("content-security-policy", "default-src 'self'; frame-ancestors 'none'"),
            ("x-content-type-options", "nosniff"),
            ("referrer-policy", "strict-origin-when-cross-origin"),
            ("permissions-policy", "camera=(), microphone=()"),
            ("set-cookie", "sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax"),
            ("server", "nginx"),
        ]);
        let cors = h(&[("content-type", "text/html")]);
        assert_eq!(ids(&analyse(true, false, &good, Some(&cors))), Vec::<&str>::new());
    }

    #[test]
    fn weak_csp_cookies_and_versions_are_reported() {
        let weak = h(&[
            ("strict-transport-security", "max-age=3600"),
            ("content-security-policy", "script-src 'self' 'unsafe-inline' 'unsafe-eval' *"),
            ("x-frame-options", "DENY"),
            ("set-cookie", "session=1; Path=/"),
            ("set-cookie", "theme=dark; Secure; HttpOnly; SameSite=Strict"),
            ("server", "Apache/2.4.49 (Unix)"),
            ("x-powered-by", "PHP/7.4.3"),
        ]);
        let f = analyse(true, false, &weak, None);
        let got = ids(&f);
        for want in ["hsts-short", "csp-unsafe-inline", "csp-unsafe-eval", "csp-wildcard", "cookie-flags", "version-disclosed"] {
            assert!(got.contains(&want), "missing {want} in {got:?}");
        }
        assert!(!got.contains(&"clickjacking"));
        assert_eq!(got.iter().filter(|i| **i == "cookie-flags").count(), 1);
        assert_eq!(got.iter().filter(|i| **i == "version-disclosed").count(), 2);
        let cookie = f.iter().find(|x| x.id == "cookie-flags").unwrap();
        assert!(cookie.title.contains("'session'") && cookie.title.contains("Secure, HttpOnly, SameSite"));
    }

    #[test]
    fn cors_reflection_with_credentials_is_high() {
        let base = h(&[]);
        let reflect = h(&[("access-control-allow-origin", PROBE_ORIGIN), ("access-control-allow-credentials", "true")]);
        let f = analyse(true, false, &base, Some(&reflect));
        assert_eq!(f[0].id, "cors-reflect-credentials");
        assert_eq!(f[0].severity, Severity::High);
        let star = h(&[("access-control-allow-origin", "*")]);
        assert!(ids(&analyse(true, false, &base, Some(&star))).contains(&"cors-any"));
        let fixed = h(&[("access-control-allow-origin", "https://app.example.com")]);
        assert!(!ids(&analyse(true, false, &base, Some(&fixed))).iter().any(|i| i.starts_with("cors")));
    }

    #[test]
    fn plain_http_is_flagged_only_for_remote_targets() {
        assert!(ids(&analyse(false, false, &h(&[]), None)).contains(&"no-https"));
        let findings = analyse(false, true, &h(&[]), None);
        let local = ids(&findings);
        assert!(!local.contains(&"no-https") && !local.contains(&"hsts-missing"));
    }

    #[test]
    fn finds_software_in_headers_and_banners() {
        assert_eq!(
            detect_software("Apache/2.4.49 (Unix) OpenSSL/1.1.1k PHP/7.4.3"),
            vec![("apache".into(), "2.4.49".into()), ("openssl".into(), "1.1.1k".into()), ("php".into(), "7.4.3".into())]
        );
        assert_eq!(detect_software("SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.1"), vec![("openssh".into(), "8.9p1".into())]);
        assert_eq!(detect_software("nginx/1.18.0"), vec![("nginx".into(), "1.18.0".into())]);
        assert_eq!(detect_software("Microsoft-IIS/10.0"), vec![("microsoft-iis".into(), "10.0".into())]);
        assert!(detect_software("cloudflare").is_empty());
        assert!(detect_software("text/html; charset=utf_8").is_empty());
        assert_eq!(cpe_for("Apache"), Some(("apache", "http_server")));
        assert_eq!(cpe_for("unknownd"), None);
    }

    #[test]
    fn nvd_answer_is_sorted_worst_first() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"vulnerabilities":[
              {"cve":{"id":"CVE-2020-0001","published":"2020-01-02T00:00:00","descriptions":[{"lang":"es","value":"x"},{"lang":"en","value":"low one"}],
                      "metrics":{"cvssMetricV2":[{"baseSeverity":"LOW","cvssData":{"baseScore":2.1}}]}}},
              {"cve":{"id":"CVE-2021-41773","published":"2021-10-05T09:15:00","descriptions":[{"lang":"en","value":"path traversal"}],
                      "metrics":{"cvssMetricV31":[{"cvssData":{"baseScore":7.5,"baseSeverity":"HIGH"}}]}}},
              {"cve":{"id":"CVE-2019-0002","published":"2019-05-05T00:00:00","descriptions":[],"metrics":{}}}
            ]}"#,
        )
        .unwrap();
        let cves = parse_nvd(&json);
        assert_eq!(cves.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["CVE-2021-41773", "CVE-2020-0001", "CVE-2019-0002"]);
        assert_eq!(cves[0].severity.as_deref(), Some("HIGH"));
        assert_eq!(cves[1].severity.as_deref(), Some("LOW"));
        assert_eq!(cves[0].published, "2021-10-05");
        assert_eq!(cves[1].summary, "low one");
        assert!(nvd_url("apache", "http_server", "2.4.49").contains("cpeName=cpe:2.3:a:apache:http_server:2.4.49:*"));
    }
}
