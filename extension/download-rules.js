// Download routing rules. Pure logic, no chrome.* calls, tested with node.
//
// A rule sends matching downloads to a subfolder of the browser's download
// folder (Chromium does not let an extension write anywhere else).
//
//   { folder: "Video", extensions: ["mp4", "mkv"], hosts: [] }
//
// A rule matches when the file extension is listed (if any are listed) AND the
// source host is listed (if any are listed). The first matching rule wins.

export const DOWNLOAD_DEFAULTS = {
  // Off until the user turns it on: a download manager must not surprise people.
  routingEnabled: false,
  rules: [
    { folder: "Documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "txt", "md", "csv", "epub"], hosts: [] },
    { folder: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic", "bmp", "ico"], hosts: [] },
    { folder: "Video", extensions: ["mp4", "mkv", "webm", "mov", "avi", "m4v"], hosts: [] },
    { folder: "Audio", extensions: ["mp3", "flac", "wav", "m4a", "ogg", "opus", "aac"], hosts: [] },
    { folder: "Archives", extensions: ["zip", "7z", "rar", "tar", "gz", "xz", "bz2", "zst"], hosts: [] },
    { folder: "Programs", extensions: ["exe", "msi", "apk", "dmg", "deb", "rpm", "appimage"], hosts: [] },
    { folder: "Disk images", extensions: ["iso", "img"], hosts: [] },
    { folder: "Torrents", extensions: ["torrent"], hosts: [] },
  ],
};

// ---- Our own downloader -------------------------------------------------------------
// Brave downloads on one connection. `gamblium-dl` opens more when that makes
// the download faster, so big files are handed to it once Brave knows where
// the file goes. Small files gain nothing and stay with Brave.
export const OWN_DEFAULTS = {
  // A .torrent file the browser has saved is opened in our downloader.
  ownTorrents: true,
  // Minutes to keep sharing a finished torrent. 0: stop when it is whole.
  seedMinutes: 0,
  // "always" | "off". Every download is ours (owner, Nov 14 2026: no minimum; Brave only for
  // what we cannot fetch: blob:, data:). "big" was the old 64 MB rule and now means "always".
  ownDownloader: "always",
};

// Why this download stays with Brave, or null if our downloader takes it.
export function stayReason(item, settings, ownId) {
  // Asked while Brave is still choosing the file's name, before it shows the download
  // anywhere: what we take, nobody sees Brave start. Private windows too.
  const s = { ...OWN_DEFAULTS, ...settings };
  if (s.ownDownloader === "off") return "switched off";
  if (!item || item.state !== "in_progress") return "not running";
  // A download we handed back to Brave ourselves must not come round again.
  if (ownId && item.byExtensionId === ownId) return "handed back";
  const web = (u) => /^https?:\/\//i.test(u || "");
  if (!web(item.url) || !web(item.finalUrl || item.url)) return "not a web address";
  return null;
}

// Magnet links and .torrent files are for the torrent engine.
export function isTorrent(address) {
  const lower = String(address || "").toLowerCase();
  return lower.startsWith("magnet:?") || /\.torrent$/.test(lower.split(/[?#]/)[0]);
}

// "C:\\Users\\me\\Downloads\\a.iso" -> { dir, name }
export function splitPath(path) {
  const at = Math.max(String(path).lastIndexOf("\\"), String(path).lastIndexOf("/"));
  return at < 0 ? { dir: "", name: String(path) } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

export function extensionOf(filename) {
  const base = String(filename || "").split(/[\\/]/).pop();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostMatches(host, list) {
  return list.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    return e && (host === e || host.endsWith("." + e));
  });
}

// Windows refuses these characters and names; "." and ".." would escape the folder.
export function safeFolder(folder) {
  const parts = String(folder || "")
    .split(/[\\/]+/)
    .map((p) => p.replace(/[<>:"|?*\x00-\x1f]/g, "").replace(/[. ]+$/, "").trim())
    .filter((p) => p && p !== "." && p !== ".." && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(p));
  return parts.join("/");
}

// The rule that applies to this download, or null.
export function matchRule(item, rules) {
  const ext = extensionOf(item.filename);
  const host = hostOf(item.finalUrl || item.url) || hostOf(item.referrer);
  for (const rule of rules) {
    const exts = (rule.extensions || []).map((x) => String(x).toLowerCase().replace(/^\./, ""));
    const hosts = rule.hosts || [];
    if (!exts.length && !hosts.length) continue;
    if (exts.length && !exts.includes(ext)) continue;
    if (hosts.length && !hostMatches(host, hosts)) continue;
    return rule;
  }
  return null;
}

// Path to suggest to the browser, relative to the download folder, or null to
// leave the download alone.
export function routedFilename(item, settings) {
  if (!settings.routingEnabled) return null;
  const rule = matchRule(item, settings.rules || []);
  if (!rule) return null;
  const folder = safeFolder(rule.folder);
  const base = String(item.filename || "").split(/[\\/]/).pop();
  if (!folder || !base) return null;
  return folder + "/" + base;
}

/** The browser's own downloads page (the download bubble's "Full download history", Ctrl+J). Gamblium's
 *  Downloads page replaces it in normal windows, so there is one list of downloads, not two. */
export function isBrowserDownloadsPage(url) {
  return /^(chrome|brave):\/\/downloads\/?(\?.*|#.*)?$/i.test(String(url || ''));
}
