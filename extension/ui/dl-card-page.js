// The download card in a small window of its own, for when the page in front cannot be
// written into (browser pages, the new tab page). Same card as in a page (../dl-card.js).
import { showDownloadCard } from '../dl-card.js';

const q = new URLSearchParams(location.search);
showDownloadCard({ id: q.get('id') || '', name: q.get('name') || '', closeWindow: true });
// In its own window the card sits at the window's top left, not the screen's top right.
const host = document.getElementById('gamblium-download-card');
if (host) host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0;';
