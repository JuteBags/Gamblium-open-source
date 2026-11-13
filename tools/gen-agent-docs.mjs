// Writes the command reference in docs/agent-cli.md and in the agent skill
// (skills/gamblium-cli/references/commands.md) from the command list the
// extension itself uses, so they cannot drift.
//
//   node tools/gen-agent-docs.mjs          rewrite the section
//   node tools/gen-agent-docs.mjs --check  exit 1 if it is out of date

import fs from "node:fs";
import { OPS } from "../extension/agent.js";

const DOCS = ["../docs/agent-cli.md", "../skills/gamblium-cli/references/commands.md"];
const TITLES = {
  browser: "The browser",
  tabs: "Tabs",
  windows: "Windows",
  read: "Reading a page",
  act: "Acting on a page",
  downloads: "Downloads",
  network: "Network capture",
  security: "Security tools",
  settings: "Settings",
  memory: "Memory and CPU",
  sessions: "Sessions (checkpoints)",
  cookies: "Cookies",
};

const cell = (s) => String(s).replace(/\|/g, "\\|");
let out = `## Command reference\n\n${Object.keys(OPS).length} commands. \`gamblium ctl help\` prints the same list as JSON.\n`;
for (const [group, title] of Object.entries(TITLES)) {
  const rows = Object.entries(OPS).filter(([, v]) => v[0] === group);
  if (!rows.length) continue;
  out += `\n### ${title}\n\n| Command | Arguments | What it does |\n|---|---|---|\n`;
  for (const [name, [, args, about]] of rows) out += `| \`${name}\` | ${args ? "`" + cell(args) + "`" : ""} | ${cell(about)} |\n`;
}
const unknown = Object.values(OPS).map((v) => v[0]).filter((g) => !(g in TITLES));
if (unknown.length) throw new Error("no section title for group: " + [...new Set(unknown)].join(", "));

const START = "<!-- commands:start";
const END = "<!-- commands:end -->";
let stale = 0;
for (const rel of DOCS) {
  const file = new URL(rel, import.meta.url);
  // Line endings as git checked them out (CRLF on Windows) do not count.
  const doc = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a < 0 || b < 0) throw new Error("markers not found in " + rel);
  const head = doc.slice(a, doc.indexOf("-->", a) + 3);
  const next = doc.slice(0, a) + head + "\n" + out + doc.slice(b);
  const name = rel.replace("../", "");
  if (process.argv.includes("--check")) {
    if (next !== doc) {
      console.error(name + " is out of date: run node tools/gen-agent-docs.mjs");
      stale++;
    }
  } else {
    fs.writeFileSync(file, next);
    console.log(`wrote ${Object.keys(OPS).length} commands to ${name}`);
  }
}
if (stale) process.exit(1);
