// The scratchpad in the side panel (owner, Nov 14 2026): the new tab page's Notes, at hand on
// any page. One text in extension storage (newtab.notes), so both places show the same.
const box = document.getElementById('notes');
let saving = null;

async function load() {
  const { newtab = {} } = await chrome.storage.local.get({ newtab: {} });
  if (document.activeElement !== box) box.value = newtab.notes || '';
}

async function save() {
  const { newtab = {} } = await chrome.storage.local.get({ newtab: {} });
  if ((newtab.notes || '') === box.value) return;
  await chrome.storage.local.set({ newtab: { ...newtab, notes: box.value } });
}

box.addEventListener('input', () => {
  clearTimeout(saving);
  saving = setTimeout(save, 400);
});
box.addEventListener('blur', save);
// Typed on the new tab page meanwhile: shown here too (not while typing here).
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.newtab) load();
});
load();
