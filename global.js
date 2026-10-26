const { global, menu, utils, file, preferences, standaloneWindow: guide } = iina;
// Require at entry time: IINA 1.5's native loader cannot resolve late requires.
const EPG_HELPER = require("./epg-helper.js");
const { findPython } = require("./python-runtime.js");
const sources = require("./source-config.js");

let config = sources.read(preferences);
let ready = false;
let loading = false;
let current = null;
let opened = false;
let settingsOpen = false;
let guideData = null;
let guideTask = null;
const subscribers = new Set();

function broadcast(name, value) {
  // Avoid converting the full guide through IINA's native object bridge, and
  // return from the player's callback before entering its JS context again.
  const message = JSON.stringify(value);
  const key = JSON.stringify(config);
  setTimeout(() => {
    if (name !== "iptv-sources-changed" && key !== JSON.stringify(config)) return;
    // IINA 1.5 uses null for managed players and string labels for normal players.
    global.postMessage(null, name, message);
    subscribers.forEach(player => global.postMessage(player, name, message));
  }, 0);
}

async function getGuide(force) {
  const key = JSON.stringify(config);
  if (!force && guideData && guideData.configKey === key && !guideData.retry &&
      Date.now() - guideData.updated < 6 * 3600000) return guideData;
  let task = guideTask;
  if (task && task.key !== key) {
    try { await task.promise; } catch (_) { /* Continue with the new sources. */ }
    return getGuide(force);
  }
  if (!task) {
    task = { key };
    task.promise = (async () => {
      const result = await utils.exec(findPython(file), [
        "-c", EPG_HELPER, utils.resolvePath("@data/epg.json"), key, force ? "1" : "0"
      ]);
      if (result.status !== 0) throw new Error(result.stderr || "Impossibile caricare playlist e guida TV.");
      const value = JSON.parse(file.read("@data/epg.json.result"));
      if (JSON.stringify(config) === key) guideData = value;
      return value;
    })();
    guideTask = task;
  }
  try {
    const value = await task.promise;
    if (JSON.stringify(config) === key) return value;
  } catch (error) {
    if (JSON.stringify(config) === key) throw error;
  } finally {
    if (guideTask === task) guideTask = null;
  }
  return getGuide(force);
}

global.onMessage("iptv-epg-request", async (request, player) => {
  subscribers.add(player);
  try { broadcast("iptv-epg-data", await getGuide(Boolean(request && request.force))); }
  catch (error) { broadcast("iptv-epg-error", String(error)); }
});

function send(name, value) {
  // Encode external strings before IINA interpolates messages into JavaScript.
  guide.postMessage(name, { payload: encodeURIComponent(JSON.stringify(value)) });
}

guide.loadFile("guide.html");
guide.setProperty({ title: "IPTV Italia · Guida e sorgenti", resizable: true });
guide.setFrame(940, 700);

async function loadGuide(force) {
  if (!opened || !ready || loading) return;
  loading = true;
  send("loading", true);
  try {
    const value = await getGuide(force);
    send("guide", value);
    send("current", current);
    broadcast("iptv-epg-data", value);
  } catch (error) { send("error", String(error)); }
  finally { loading = false; send("loading", false); }
}

function openGuide(settings) {
  opened = true;
  settingsOpen = Boolean(settings);
  guide.open();
  if (ready) {
    send("settings", { config, defaults: sources.defaults(), open: settingsOpen });
    if (!settingsOpen) loadGuide(false);
  }
}

function saveConfig(value) {
  const next = sources.validate(value);
  preferences.set("sources", JSON.stringify(next));
  preferences.sync();
  config = next;
  guideData = null;
  broadcast("iptv-sources-changed", true);
  send("settings", { config, defaults: sources.defaults() });
  send("sources-saved", true);
  loadGuide(false);
}

guide.onMessage("ready", () => {
  ready = true;
  send("settings", { config, defaults: sources.defaults(), open: settingsOpen });
  if (!settingsOpen) loadGuide(false);
});
guide.onMessage("refresh", () => loadGuide(true));
guide.onMessage("save-sources", value => {
  try {
    if (loading) throw new Error("Attendi il completamento del caricamento prima di salvare.");
    const next = sources.validate(value);
    saveConfig({ ...next, overrides: next.playlistUrl === config.playlistUrl ? config.overrides : {} });
  } catch (error) { send("settings-error", String(error)); }
});
guide.onMessage("match-channel", value => {
  try {
    if (loading || !guideData || !value || !guideData.channels.some(channel => channel.url === value.url)) {
      throw new Error("Attendi il caricamento della guida prima di modificare gli abbinamenti.");
    }
    const overrides = { ...config.overrides };
    if (value.id === null) delete overrides[value.url];
    else {
      if (value.id !== "" && !guideData.epgChannels.some(channel => channel.id === value.id)) {
        throw new Error("Seleziona un canale EPG presente nella guida.");
      }
      Object.defineProperty(overrides, value.url, { value: value.id, enumerable: true, configurable: true, writable: true });
    }
    saveConfig({ ...config, overrides });
  } catch (error) { send("error", String(error)); }
});
guide.onMessage("open-playlist", () => openPlaylist());
global.onMessage("iptv-open-settings", () => openGuide(true));
global.onMessage("iptv-current", value => {
  current = value;
  if (ready) send("current", current);
});

function openPlaylist() {
  global.createPlayerInstance({ url: config.playlistUrl, label: "iptv-italia", enablePlugins: true });
}

menu.addItem(menu.item("Apri IPTV Italia", openPlaylist));
menu.addItem(menu.item("Guida TV (EPG)…", () => openGuide(false)));
menu.addItem(menu.item("Sorgenti IPTV / EPG…", () => openGuide(true)));
