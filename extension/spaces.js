// Spaces: a window's tab groups used as spaces, the way Zen and Arc keep several
// lists of tabs and show one at a time. A space is a tab group; the space you are in
// is the group of the tab in front. Switching expands that group, collapses the
// others and freezes their tabs at once (state kept, back in about 25 ms when shown).
// Tabs outside any group stay in view in every space, like Arc's pinned tabs.
// Pure functions only; background.js does the browser calls.

/** The spaces of one window, in strip order, with what their tabs are doing.
 *   tabs: chrome.tabs.query({ windowId }) results; groups: chrome.tabGroups.query({ windowId })
 *   frozen: { tabId: time } of tabs our freezer holds frozen */
export function listSpaces(tabs, groups, frozen = {}) {
  const front = tabs.find((t) => t.active);
  // The space you are in: the group of the tab in front. When that tab is in no group
  // (a New Tab page, say), the one space left open after a switch counts as the current one.
  const live = groups.filter((g) => tabs.some((t) => t.groupId === g.id));
  const open = live.filter((g) => !g.collapsed);
  const current = front && front.groupId !== -1 ? front.groupId : live.length > 1 && open.length === 1 ? open[0].id : null;
  const firstIndex = (g) => Math.min(...tabs.filter((t) => t.groupId === g.id).map((t) => t.index), Infinity);
  return [...groups]
    .filter((g) => tabs.some((t) => t.groupId === g.id))
    .sort((a, b) => firstIndex(a) - firstIndex(b))
    .map((g) => {
      const own = tabs.filter((t) => t.groupId === g.id);
      const asleep = own.filter((t) => t.discarded).length;
      const cold = own.filter((t) => !t.discarded && (t.frozen || frozen[t.id])).length;
      return {
        id: g.id, title: g.title || '', color: g.color, collapsed: !!g.collapsed,
        active: g.id === current,
        tabs: own.length, asleep, frozen: cold, awake: own.length - asleep - cold,
      };
    });
}

/** What switching to space `groupId` does: which groups fold, which tab comes to the front,
 *  and which tabs are frozen now. Null if the space is not in this window. */
export function switchPlan(tabs, groups, groupId) {
  const own = tabs.filter((t) => t.groupId === groupId);
  if (!own.length || !groups.some((g) => g.id === groupId)) return null;
  // Back to the tab last used in that space.
  const front = own.reduce((a, b) => ((b.lastAccessed ?? 0) > (a.lastAccessed ?? 0) ? b : a));
  const others = groups.filter((g) => g.id !== groupId && tabs.some((t) => t.groupId === g.id));
  return {
    expand: groupId,
    collapse: others.filter((g) => !g.collapsed).map((g) => g.id),
    activate: front.id,
    freeze: tabs.filter((t) => others.some((g) => g.id === t.groupId) && !t.discarded).map((t) => t.id),
  };
}

/** The space after the one in front, in strip order, going round; the first one when none is in front. */
export function nextSpace(spaces, step = 1) {
  if (!spaces.length) return null;
  const at = spaces.findIndex((s) => s.active);
  if (at < 0) return spaces[step > 0 ? 0 : spaces.length - 1].id;
  return spaces[(at + step + spaces.length) % spaces.length].id;
}

const COLOURS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
/** A colour no space in the window wears yet, so a new space can be told apart at a glance. */
export function freeColour(groups) {
  const used = new Set(groups.map((g) => g.color));
  return COLOURS.find((c) => !used.has(c)) ?? COLOURS[groups.length % COLOURS.length];
}
