const { core, event, global, mpv, sidebar, menu, file, playlist, preferences } = iina;
const { matchChannel } = require("./epg-match.js");
const { snapshot } = require("./channel-list.js");
const sources = require("./source-config.js");
let data = null;
let initialized = false;
let ready = false;
let shown = false;
let requested = false;
let lastRequest = 0;
let failure = "";
let listOpen = false;
let listSignature = "";
let revision = 0;
let playlistTimer = null;
let stateSignature = "";
let playbackLoaded = false;
let menuActive = false;

function post(name, value) {
  sidebar.postMessage(name, { payload: encodeURIComponent(JSON.stringify(value)) });
}

function sendChannels(force) {
  if (!ready || !listOpen || !isIPTVActive()) return;
  const entries = mpv.getNative("playlist") || [];
  const signature = JSON.stringify([revision, entries.map(e => [e.id, e.filename, e.title])]);
  if (!force && signature === listSignature) return;
  listSignature = signature;
  post("channel-list", snapshot(entries, data ? data.channels : []));
}

function showChannels() {
  if (!isIPTVActive()) return;
  initialize();
  if (!initialized) return;
  listOpen = true;
  shown = true;
  sidebar.show();
  if (ready) post("show-channels", true);
  requestGuide(false);
}

function currentChannel() {
  const entries = mpv.getNative("playlist") || [];
  const entry = entries.find(item => item.current) || entries[mpv.getNumber("playlist-pos")] || {};
  const path = mpv.getString("path") || "";
  return {
    url: entry.filename || path,
    urls: [entry.filename, path, mpv.getString("stream-open-filename")].filter(Boolean),
    title: entry.title || mpv.getString("media-title") || ""
  };
}

function isIPTVActive() {
  if (!playbackLoaded || !core.window.loaded || mpv.getFlag("idle-active")) return false;
  const current = currentChannel();
  if (!current.url) return false;
  if (data) return data.channels.some(channel => current.urls.includes(channel.url));
  return global.getLabel() === "iptv-italia";
}

function showProgramme() {
  if (!isIPTVActive()) return;
  initialize();
  if (!initialized) return;
  sidebar.show();
  shown = true;
  listOpen = false;
  if (ready) post("show-programme", true);
  update();
  requestGuide(false);
}

function updateMenu() {
  const active = isIPTVActive();
  if (active === menuActive) return;
  menuActive = active;
  menu.removeAllItems();
  if (active) {
    menu.addItem(menu.item("Canali con EPG", showChannels));
    menu.addItem(menu.item("EPG del canale corrente", showProgramme));
  }
}

function update() {
  if (!ready) return;
  const current = currentChannel();
  const channel = data && matchChannel(data.channels, current);
  const value = {
    current, channel: channel || null, updated: data && data.updated,
    loading: requested, error: failure, warning: data && data.warning
  };
  const signature = JSON.stringify(value);
  if (signature !== stateSignature) {
    stateSignature = signature;
    sidebar.postMessage("state", { payload: encodeURIComponent(signature) });
  }
}

function requestGuide(force) {
  if (requested || !isIPTVActive()) return;
  requested = true;
  lastRequest = Date.now();
  failure = "";
  update();
  global.postMessage("iptv-epg-request", { force: Boolean(force) });
}

function initialize() {
  if (initialized || !core.window.loaded) return;
  initialized = true;
  sidebar.loadFile("sidebar.html");
  sidebar.onMessage("ready", () => {
    ready = true;
    update();
    if (listOpen) post("show-channels", true);
    if (isIPTVActive()) requestGuide(false);
  });
  sidebar.onMessage("refresh", () => requestGuide(true));
  sidebar.onMessage("settings", () => global.postMessage("iptv-open-settings"));
  sidebar.onMessage("channels-open", () => {
    listOpen = true;
    sendChannels(true);
    if (!data || Date.now() - data.updated >= 6 * 3600000) requestGuide(false);
  });
  sidebar.onMessage("channels-close", () => { listOpen = false; });
  sidebar.onMessage("native-playlist", () => { listOpen = false; core.window.sidebar = "playlist"; });
  sidebar.onMessage("play-channel", selection => {
    if (!selection || typeof selection.url !== "string") return;
    const entries = mpv.getNative("playlist") || [];
    // Resolve the stable entry ID again: the playlist may have been reordered.
    const index = entries.findIndex((entry, at) => entry.filename === selection.url &&
      (selection.id !== undefined ? entry.id === selection.id : at === selection.index));
    if (index >= 0 && !entries[index].playing && !entries[index].current) playlist.play(index);
  });
  try {
    if (file.exists("@data/epg.json")) {
      const cached = JSON.parse(file.read("@data/epg.json"));
      if (cached.cacheVersion === 2 && cached.configKey === JSON.stringify(sources.read(preferences))) data = cached;
    }
  } catch (_) { /* The shared loader will replace an invalid cache. */ }
}

function followChannel() {
  initialize();
  updateMenu();
  const current = currentChannel();
  if (!isIPTVActive()) { update(); return; }
  global.postMessage("iptv-current", current);
  if (!shown && initialized) { sidebar.show(); shown = true; }
  update();
  if (!lastRequest || Date.now() - lastRequest >= 6 * 3600000) requestGuide(false);
}

global.onMessage("iptv-epg-data", message => {
  const value = JSON.parse(message);
  if (!data || data.updated !== value.updated || data.configKey !== value.configKey) revision += 1;
  data = value; requested = false; failure = "";
  // Do not call back into the global JS context from its message listener.
  setTimeout(() => { followChannel(); sendChannels(false); }, 0);
});
global.onMessage("iptv-epg-error", message => { requested = false; failure = JSON.parse(message); update(); });
global.onMessage("iptv-sources-changed", () => {
  data = null; revision += 1; lastRequest = 0; failure = ""; requested = false;
  setTimeout(() => {
    updateMenu();
    update(); sendChannels(true);
    if (shown) requestGuide(false);
  }, 0);
});
event.on("iina.window-loaded", followChannel);
event.on("iina.menu-update", updateMenu);
event.on("mpv.file-loaded", () => { playbackLoaded = true; followChannel(); });
event.on("mpv.media-title.changed", update);
event.on("mpv.playlist.changed", () => {
  if (!listOpen) return;
  if (playlistTimer !== null) clearTimeout(playlistTimer);
  playlistTimer = setTimeout(() => { playlistTimer = null; sendChannels(false); update(); }, 150);
});
function stopFollowing() {
  playbackLoaded = false;
  updateMenu();
  shown = false; listOpen = false;
  if (ready) post("show-programme", true);
  if (playlistTimer !== null) clearTimeout(playlistTimer);
  playlistTimer = null;
}
event.on("mpv.end-file", stopFollowing);
event.on("iina.window-will-close", stopFollowing);
setInterval(() => {
  if (!shown || !isIPTVActive()) return;
  update();
  if (Date.now() - lastRequest >= (failure || data && data.retry ? 5 * 60000 : 6 * 3600000)) requestGuide(false);
}, 60000);
initialize();
