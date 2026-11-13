import assert from "node:assert/strict";
import { test } from "node:test";
import { DOWNLOAD_DEFAULTS, extensionOf, matchRule, routedFilename, safeFolder, isBrowserDownloadsPage } from "./download-rules.js";

const on = { ...DOWNLOAD_DEFAULTS, routingEnabled: true };
const item = (over = {}) => ({ filename: "report.PDF", url: "https://example.com/a/report.pdf", ...over });

test("routing is off by default", () => {
  assert.equal(routedFilename(item(), DOWNLOAD_DEFAULTS), null);
});

test("routes by file extension, case-insensitively", () => {
  assert.equal(routedFilename(item(), on), "Documents/report.PDF");
  assert.equal(routedFilename(item({ filename: "film.mkv" }), on), "Video/film.mkv");
  assert.equal(routedFilename(item({ filename: "ubuntu.iso" }), on), "Disk images/ubuntu.iso");
  assert.equal(routedFilename(item({ filename: "noextension" }), on), null);
  assert.equal(routedFilename(item({ filename: ".gitignore" }), on), null);
});

test("a host rule must match the source site, including subdomains", () => {
  const rules = [{ folder: "Work", extensions: [], hosts: ["github.com"] }, ...on.rules];
  const s = { routingEnabled: true, rules };
  assert.equal(routedFilename(item({ url: "https://objects.github.com/x.pdf" }), s), "Work/report.PDF");
  assert.equal(routedFilename(item({ url: "https://notgithub.com/x.pdf" }), s), "Documents/report.PDF");
  assert.equal(matchRule(item({ url: "bad url", referrer: "https://github.com/a" }), rules).folder, "Work");
});

test("extension and host together must both match", () => {
  const rules = [{ folder: "Papers", extensions: ["pdf"], hosts: ["arxiv.org"] }];
  assert.equal(matchRule(item({ url: "https://arxiv.org/pdf/1.pdf" }), rules).folder, "Papers");
  assert.equal(matchRule(item({ url: "https://example.com/1.pdf" }), rules), null);
  assert.equal(matchRule(item({ filename: "a.zip", url: "https://arxiv.org/a.zip" }), rules), null);
});

test("folder names cannot escape the download folder or break Windows", () => {
  assert.equal(safeFolder("../../Windows/System32"), "Windows/System32");
  assert.equal(safeFolder("C:\\Users\\x"), "C/Users/x");
  assert.equal(safeFolder("a<b>|c?*"), "abc");
  assert.equal(safeFolder("con/ok./ trailing "), "ok/trailing");
  assert.equal(safeFolder(""), "");
  assert.equal(routedFilename(item(), { routingEnabled: true, rules: [{ folder: "..", extensions: ["pdf"] }] }), null);
});

test("extensionOf handles paths", () => {
  assert.equal(extensionOf("C:\\dl\\a.b.TAR"), "tar");
  assert.equal(extensionOf("dir.v2/file"), "");
});

test("magnet links and .torrent files are told apart from other links", async () => {
  const { isTorrent } = await import("./download-rules.js");
  assert.equal(isTorrent("magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862"), true);
  assert.equal(isTorrent("https://x.org/debian.iso.torrent"), true);
  assert.equal(isTorrent("https://x.org/a.TORRENT?dl=1"), true);
  assert.equal(isTorrent(String.raw`C:\Users\me\Downloads\a.torrent`), true);
  assert.equal(isTorrent("https://x.org/debian.iso"), false);
  assert.equal(isTorrent("https://x.org/a?file=b.torrent"), false);
  assert.equal(isTorrent("magnet:"), false);
  assert.equal(isTorrent(""), false);
});

test("big web downloads go to our own downloader, the rest stay with Brave", async () => {
  const { stayReason, splitPath } = await import("./download-rules.js");
  const MB = 1024 * 1024;
  const big = { state: "in_progress", url: "https://x.org/a.iso", filename: String.raw`C:\Users\me\Downloads\a.iso`, totalBytes: 700 * MB };
  assert.equal(stayReason(big, {}, "me"), null);
  assert.equal(stayReason({ ...big, totalBytes: 5 * MB }, {}, "me"), "small file");
  assert.equal(stayReason({ ...big, totalBytes: 5 * MB }, { ownDownloader: "always" }, "me"), null);
  assert.equal(stayReason({ ...big, totalBytes: -1 }, {}, "me"), "size unknown");
  assert.equal(stayReason(big, { ownDownloader: "off" }, "me"), "switched off");
  assert.equal(stayReason({ ...big, incognito: true }, {}, "me"), "private window");
  assert.equal(stayReason({ ...big, byExtensionId: "me" }, {}, "me"), "handed back");
  assert.equal(stayReason({ ...big, url: "blob:https://x.org/1" }, {}, "me"), "not a web address");
  assert.equal(stayReason({ ...big, url: "data:text/plain,hi" }, { ownDownloader: "always" }, "me"), "not a web address");
  assert.equal(stayReason({ ...big, filename: "" }, {}, "me"), "no place to save yet");
  assert.equal(stayReason({ ...big, state: "complete" }, {}, "me"), "not running");
  assert.equal(stayReason({ ...big, finalUrl: "https://cdn.x.org/a.iso", url: "https://x.org/go" }, { ownDownloaderMinMb: 800 }, "me"), "small file");
  assert.deepEqual(splitPath(String.raw`C:\Users\me\Downloads\a.iso`), { dir: String.raw`C:\Users\me\Downloads`, name: "a.iso" });
  assert.deepEqual(splitPath("/home/me/a.iso"), { dir: "/home/me", name: "a.iso" });
});

test('the browser downloads page is recognised, nothing else is', () => {
  for (const u of ['chrome://downloads', 'chrome://downloads/', 'brave://downloads/', 'chrome://downloads/?q=pdf']) assert.ok(isBrowserDownloadsPage(u), u);
  for (const u of ['chrome://settings/downloads', 'https://example.com/downloads', 'chrome://downloadsx', '', null]) assert.ok(!isBrowserDownloadsPage(u), String(u));
});
