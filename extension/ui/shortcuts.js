// Keyboard shortcuts: every command with its keys. "Change" listens for the
// next key press; keys another command holds are named, with "Reassign".
// The keys live in the browser, so reading and changing them goes through the
// helper (shortcuts-get, shortcuts-set, shortcuts-reset). Without those the
// page lists the usual keys and says it cannot change them.
import { $, el, button, helper, say } from './page.js';
import { chordOf, findClash, filterCommands, groupCommands, sameKeys, USUAL_KEYS, keyParts } from './pages-logic.js';

// ?demo keeps changes on this page only: for looking at the editor without a helper.
const demo = new URLSearchParams(location.search).has('demo');
let commands = [];
let canEdit = false;
let listening = null; // id of the command waiting for a key press
let clash = null; // { id, keys, holder } while a clash is being shown

// Gamblium's own commands, every one of them, with or without a key. A command may ship with no key
// (Focus: Alt+Shift+F took Format Document from vscode.dev and github.dev), and must still be listed
// so it can be given one. Extension keys are set in the browser's own editor, not through the helper.
async function ownCommands() {
  const own = (await chrome.commands?.getAll().catch(() => [])) ?? [];
  return own.map((c) => {
    const keys = c.shortcut ? [c.shortcut] : [];
    return { id: `ext:${c.name}`, name: c.name === '_execute_action' ? 'Open the Gamblium panel' : c.description || c.name, group: 'Gamblium', keys, defaults: [...keys], ext: true };
  });
}

async function read() {
  const r = demo ? { ok: false } : await helper({ type: 'shortcuts-get' });
  const own = await ownCommands();
  if (r.ok !== false && Array.isArray(r.commands)) {
    const got = r.commands.map((c) => ({ ...c, keys: c.keys ?? [], defaults: c.defaults ?? [] }));
    commands = [...own.filter((o) => !got.some((c) => c.id === o.id)), ...got];
    canEdit = true;
  } else if (!commands.length) {
    // The usual keys of the browser, and this extension's own commands.
    commands = [...own, ...USUAL_KEYS.map((c) => ({ ...c, keys: [...c.defaults] }))];
    canEdit = demo;
  }
  say($('readonly'), '', canEdit && !demo ? '' : demo ? 'Demo: changes stay on this page and change no key.' : "These are the usual keys. To change one, use the browser's own editor.");
  if (!canEdit) $('readonly').append(' ', button('Open the browser\'s editor', () => chrome.tabs.create({ url: 'chrome://settings/system/shortcuts' }), 'quiet'));
  $('resetAll').hidden = !canEdit;
  render();
}

async function setKeys(id, keys) {
  const r = demo ? { ok: true } : await helper({ type: 'shortcuts-set', id, keys });
  if (r.ok === false) return void ($('saved').textContent = r.error || 'That could not be saved.');
  commands = commands.map((c) => (c.id === id ? { ...c, keys } : c));
  $('saved').textContent = demo ? 'Changed on this page.' : 'Saved. It applies the next time Gamblium starts.';
}

function keyChips(keys) {
  return keys.length ? keys.map((k) => el('span', { className: 'chord' }, keyParts(k).map((part) => el('kbd', { textContent: part })))) : [el('span', { className: 'muted', textContent: 'No key' })];
}

function commandRow(c) {
  const changed = !sameKeys(c.keys, c.defaults);
  const acts = [];
  let keys = keyChips(c.keys);
  if (listening === c.id) {
    keys = [el('span', { className: 'listening', textContent: 'Press the new keys… Esc to cancel' })];
    acts.push(button('Cancel', stopListening, 'quiet'));
  } else if (c.ext && !demo) {
    // Only the browser's editor can give an extension command its keys.
    acts.push(button(c.keys.length ? 'Change' : 'Set a key', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }), 'quiet'));
  } else if (canEdit) {
    if (changed) acts.push(button('Reset', async () => {
      await setKeys(c.id, [...c.defaults]);
      render();
    }, 'quiet'));
    if (c.keys.length) acts.push(button('Clear', async () => {
      await setKeys(c.id, []);
      render();
    }, 'quiet'));
    acts.push(button('Change', () => {
      listening = c.id;
      clash = null;
      render();
    }));
  }
  const li = el('li', { className: listening === c.id ? 'waiting' : '' }, [
    el('span', { className: 'cname' }, [c.name, ...(changed ? [el('span', { className: 'pill', textContent: 'changed' })] : [])]),
    el('span', { className: 'ckeys' }, keys),
    el('span', { className: 'cacts' }, acts),
  ]);
  if (clash?.id === c.id) {
    li.append(el('div', { className: 'notice warn clash', role: 'alert' }, [
      el('span', { textContent: `${clash.keys} is held by “${clash.holder.name}”.` }),
      button('Reassign', async () => {
        const { id, keys, holder } = clash;
        clash = null;
        await setKeys(holder.id, holder.keys.filter((k) => k !== keys)); // the other command gives the keys up
        await setKeys(id, [keys]);
        render();
      }, 'primary'),
      button('Keep both as they are', () => {
        clash = null;
        render();
      }, 'quiet'),
    ]));
  }
  return li;
}

function render() {
  const shown = filterCommands(commands, $('kq').value);
  const changed = commands.filter((c) => !sameKeys(c.keys, c.defaults)).length;
  $('line').textContent = `${commands.length} commands${changed ? `, ${changed} changed` : ''}.`;
  $('none').hidden = shown.length > 0;
  $('groups').replaceChildren(...groupCommands(shown).map((g) => el('section', {}, [el('h2', { textContent: g.name }), el('ul', { className: 'keys' }, g.commands.map(commandRow))])));
}

function stopListening() {
  listening = null;
  render();
}
// The next key press while a row is waiting becomes that command's keys.
document.addEventListener('keydown', async (e) => {
  if (!listening) {
    if (e.key === '/' && document.activeElement !== $('kq')) {
      e.preventDefault();
      $('kq').focus();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') return stopListening();
  const keys = chordOf(e);
  if (!keys) return; // only modifiers so far: keep waiting
  const id = listening;
  listening = null;
  const holder = findClash(commands, keys, id);
  if (holder) clash = { id, keys, holder };
  else await setKeys(id, [keys]);
  render();
}, true);

$('kq').addEventListener('input', render);
$('resetAll').addEventListener('click', async () => {
  const r = demo ? { ok: true } : await helper({ type: 'shortcuts-reset' });
  if (r.ok === false) return void ($('saved').textContent = r.error || 'That could not be reset.');
  commands = commands.map((c) => ({ ...c, keys: [...c.defaults] }));
  clash = null;
  $('saved').textContent = 'Every command has its usual keys again.';
  render();
});

read();
