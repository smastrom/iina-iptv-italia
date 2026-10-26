let state = null;
const element = id => document.getElementById(id);
const clock = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
const range = programme => clock.format(programme.start) + "–" + clock.format(programme.stop);
let mode = "programme";
let channelViews = [];
let channelTimer = null;

function receive(name, callback) {
  iina.onMessage(name, message => callback(JSON.parse(decodeURIComponent(message.payload))));
}

function setText(id, text) {
  if (element(id).textContent !== text) element(id).textContent = text;
}

function cancelChannelTimer() {
  if (channelTimer !== null) clearTimeout(channelTimer);
  channelTimer = null;
}

function selectCurrent() {
  const urls = state && state.current ? state.current.urls || [state.current.url] : [];
  channelViews.forEach(view => {
    const selected = urls.includes(view.row.url);
    if (view.selected !== selected) {
      view.selected = selected;
      view.button.setAttribute("aria-current", String(selected));
    }
  });
}

function filterChannels() {
  const query = element("channel-search").value.trim().toLocaleLowerCase("it");
  let visible = 0;
  channelViews.forEach(view => {
    const hidden = Boolean(query && !view.searchText.includes(query));
    if (view.button.hidden !== hidden) view.button.hidden = hidden;
    if (!hidden) visible += 1;
  });
  const count = channelViews.length ? visible + " / " + channelViews.length + " canali" : "Nessun canale nella playlist.";
  if (element("channel-count").textContent !== count) element("channel-count").textContent = count;
}

function refreshLabels() {
  cancelChannelTimer();
  if (mode !== "channels" || document.hidden) return;
  const result = IPTVChannels.labelsAt(channelViews.map(view => view.row), Date.now());
  channelViews.forEach((view, index) => {
    const label = result.labels[index];
    if (view.label !== label) {
      view.label = label;
      view.searchText = label.toLocaleLowerCase("it");
      view.button.textContent = label;
      view.button.title = label;
    }
  });
  filterChannels();
  // One timer for the earliest programme boundary across the whole list.
  if (Number.isFinite(result.nextChange)) {
    channelTimer = setTimeout(refreshLabels, Math.max(100, Math.min(2147483647, result.nextChange - Date.now() + 50)));
  }
}

function setChannelRows(rows) {
  const previous = new Map(channelViews.map(view => [view.row.id + "|" + view.row.url, view]));
  const fragment = document.createDocumentFragment();
  channelViews = rows.map((row, index) => {
    const key = row.id + "|" + row.url;
    let view = previous.get(key);
    // Consume the reused view so duplicate URLs still receive distinct buttons.
    previous.delete(key);
    if (!view) view = { button: document.createElement("button"), label: null, searchText: "" };
    view.row = row;
    view.button.type = "button";
    view.button.dataset.channel = String(index);
    fragment.appendChild(view.button);
    return view;
  });
  element("channel-list").replaceChildren(fragment);
  refreshLabels();
  selectCurrent();
}

function setMode(value) {
  mode = value;
  const channels = mode === "channels";
  element("programme-view").hidden = channels;
  element("channels-view").hidden = !channels;
  element("in-onda").setAttribute("aria-pressed", String(!channels));
  element("channels").setAttribute("aria-pressed", String(channels));
  if (channels) refreshLabels();
  else cancelChannelTimer();
  iina.postMessage(channels ? "channels-open" : "channels-close");
  render();
}

function render() {
  if (!state) return;
  element("refresh").disabled = state.loading;
  setText("status", state.loading ? "Aggiornamento della guida…" : state.updated ?
    "EPG aggiornato: " + new Date(state.updated).toLocaleString("it-IT") : "");
  setText("error", state.error || state.warning || "");
  if (mode === "channels") { selectCurrent(); return; }
  const now = Date.now();
  const channel = state.channel;
  const schedule = channel ? channel.programmes : [];
  const live = schedule.find(p => p.start <= now && p.stop > now);
  const next = schedule.filter(p => p.start > now).slice(0, 3);
  element("channel").textContent = channel ? channel.name : state.current.title || "IPTV Italia";
  element("title").textContent = live ? live.title : state.loading ? "Caricamento del programma…" : "Programma non disponibile";
  element("time").textContent = live ? range(live) : "";
  element("description").textContent = live ? live.description : channel ?
    channel.epgId ? "Il feed non contiene un programma in onda per questo orario." : "Questo canale non è abbinato alla guida EPG." :
    "Apri un canale della playlist configurata per visualizzarne il programma.";
  element("progress").hidden = !live;
  element("progress").value = live ? Math.max(0, Math.min(1, (now - live.start) / (live.stop - live.start))) : 0;
  element("remaining").textContent = live ? "Termina tra " + Math.ceil((live.stop - now) / 60000) + " min" : "";
  element("next").hidden = !next.length;
  element("upcoming").textContent = "";
  next.forEach(programme => {
    const article = document.createElement("article");
    const time = document.createElement("time");
    time.textContent = range(programme);
    const title = document.createElement("h3");
    title.textContent = programme.title;
    article.appendChild(time);
    article.appendChild(title);
    element("upcoming").appendChild(article);
  });
}

receive("state", value => { state = value; render(); });
receive("channel-list", setChannelRows);
receive("show-channels", () => setMode("channels"));
receive("show-programme", () => setMode("programme"));
element("channels").addEventListener("click", () => setMode("channels"));
element("in-onda").addEventListener("click", () => setMode("programme"));
element("native-playlist").addEventListener("click", () => {
  setMode("programme");
  iina.postMessage("native-playlist");
});
element("channel-search").addEventListener("input", filterChannels);
element("channel-list").addEventListener("click", event => {
  const button = event.target.closest("[data-channel]");
  if (!button) return;
  const view = channelViews[Number(button.dataset.channel)];
  if (view) iina.postMessage("play-channel", { id: view.row.id, index: view.row.index, url: view.row.url });
});
element("refresh").addEventListener("click", () => iina.postMessage("refresh"));
element("settings").addEventListener("click", () => iina.postMessage("settings"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelChannelTimer();
  else { refreshLabels(); render(); }
});
window.addEventListener("pagehide", cancelChannelTimer);
setInterval(() => { if (mode === "programme" && !document.hidden) render(); }, 30000);
iina.postMessage("ready");
