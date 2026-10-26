let data = null;
let current = null;
const list = document.getElementById("channels");
const status = document.getElementById("status");
const error = document.getElementById("error");
const search = document.getElementById("search");
const refresh = document.getElementById("refresh");
const sourcesView = document.getElementById("sources");
const playlistInput = document.getElementById("playlist-url");
const epgInput = document.getElementById("epg-urls");
let sourceDefaults = null;
let sourceConfig = null;
let loading = false;
const matchLabels = { id: "ID tvg-id", name: "Nome", normalized: "Nome normalizzato", manual: "Manuale", ambiguous: "Nome ambiguo", unmatched: "Non abbinato", disabled: "EPG disattivato", missing: "ID manuale non presente nel feed" };
const timeFormat = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("it-IT", { weekday: "short", day: "numeric", month: "short" });

function receive(name, callback) {
  iina.onMessage(name, message => {
    callback(JSON.parse(decodeURIComponent(message.payload)));
  });
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function timeRange(programme) {
  return timeFormat.format(programme.start) + "–" + timeFormat.format(programme.stop);
}

function render() {
  if (!data) return;
  const expanded = new Set(Array.from(list.querySelectorAll("details[open]")).map(e => e.dataset.url));
  list.textContent = "";
  const now = Date.now();
  const query = search.value.trim().toLocaleLowerCase("it");
  let count = 0;
  data.channels.forEach(channel => {
    const programmes = channel.programmes.filter(p => p.stop > now);
    if (query && !(channel.name + " " + programmes.map(p => p.title).join(" ")).toLocaleLowerCase("it").includes(query)) return;
    count += 1;
    const details = node("details");
    details.dataset.url = channel.url;
    details.open = expanded.has(channel.url);
    const summary = node("summary");
    summary.appendChild(node("span", channel.name, "channel"));
    if (current && channel.url === current.url) summary.appendChild(node("span", "IN RIPRODUZIONE", "badge"));
    const live = programmes.find(p => p.start <= now && p.stop > now);
    const next = programmes.find(p => p.start > now);
    summary.appendChild(node("div", live ? "Ora · " + timeRange(live) + "  " + live.title : "Nessun programma in onda disponibile", "now"));
    if (next) summary.appendChild(node("div", "A seguire · " + timeRange(next) + "  " + next.title, "next"));
    details.appendChild(summary);
    // Build long schedules only when a channel is expanded.
    let filled = false;
    function fill() {
      if (filled || !details.open) return;
      filled = true;
      const schedule = node("div", "", "schedule");
      const matching = node("div", "", "matching");
      const label = node("label", "Abbinamento EPG · " + (matchLabels[channel.match] || "Automatico"));
      const input = node("input");
      input.type = "text";
      input.setAttribute("list", "epg-options");
      input.setAttribute("aria-label", "ID EPG per " + channel.name);
      input.placeholder = "Cerca un ID o un nome EPG…";
      input.value = channel.epgId || "";
      label.appendChild(input);
      matching.appendChild(label);
      const actions = node("div", "", "toolbar");
      [["Applica ID", () => input.value.trim()], ["Automatico", () => null], ["Disattiva EPG", () => ""]].forEach(([title, selection]) => {
        const button = node("button", title);
        button.type = "button";
        button.dataset.loadControl = "";
        button.disabled = loading;
        button.addEventListener("click", () => iina.postMessage("match-channel", { url: channel.url, id: selection() }));
        actions.appendChild(button);
      });
      matching.appendChild(actions);
      matching.appendChild(node("p", "Gli abbinamenti manuali hanno priorità. Automatico rimuove la correzione; i nomi ambigui restano senza EPG.", "help"));
      schedule.appendChild(matching);
      if (!programmes.length) schedule.appendChild(node("p", channel.epgId ? "Nessun programma disponibile nel feed per questo periodo." : "Canale non abbinato alla guida EPG.", "muted"));
      programmes.forEach(p => {
        const article = node("article", "", p === live ? "live" : "");
        article.appendChild(node("p", dateFormat.format(p.start) + " · " + timeRange(p), "muted"));
        article.appendChild(node("strong", p.title || "Titolo non disponibile"));
        if (p.description) article.appendChild(node("p", p.description));
        schedule.appendChild(article);
      });
      details.appendChild(schedule);
    }
    details.addEventListener("toggle", fill);
    fill();
    list.appendChild(details);
  });
  if (!count) list.appendChild(node("p", "Nessun canale trovato.", "empty"));
  status.textContent = count + " canali · " + data.matched + "/" + data.channels.length + " abbinati all’EPG · Aggiornato: " + new Date(data.updated).toLocaleString("it-IT");
}

search.addEventListener("input", render);
document.getElementById("show-sources").addEventListener("click", () => {
  sourcesView.open = !sourcesView.open;
  if (sourcesView.open) playlistInput.focus();
});
document.getElementById("source-form").addEventListener("submit", event => {
  event.preventDefault();
  document.getElementById("settings-error").textContent = "";
  document.getElementById("settings-status").textContent = "";
  iina.postMessage("save-sources", { playlistUrl: playlistInput.value, epgUrls: epgInput.value });
});
document.getElementById("default-sources").addEventListener("click", () => {
  if (!sourceDefaults) return;
  playlistInput.value = sourceDefaults.playlistUrl;
  epgInput.value = sourceDefaults.epgUrls.join("\n");
  document.getElementById("settings-status").textContent = "Fonti italiane selezionate. Premi Salva sorgenti per applicarle.";
});
document.getElementById("open-playlist").addEventListener("click", () => iina.postMessage("open-playlist"));
refresh.addEventListener("click", () => iina.postMessage("refresh"));
receive("settings", value => {
  sourceConfig = value.config;
  sourceDefaults = value.defaults;
  playlistInput.value = sourceConfig.playlistUrl;
  epgInput.value = sourceConfig.epgUrls.join("\n");
  if (typeof value.open === "boolean") sourcesView.open = value.open;
  if (!data) status.textContent = "Configura le sorgenti o premi Aggiorna EPG per caricare la guida.";
});
receive("sources-saved", () => {
  data = null;
  list.textContent = "";
  document.getElementById("epg-options").textContent = "";
  document.getElementById("settings-error").textContent = "";
  document.getElementById("settings-status").textContent = "Sorgenti e abbinamenti salvati.";
});
receive("settings-error", value => { document.getElementById("settings-error").textContent = value; });
receive("loading", value => {
  loading = value;
  refresh.disabled = loading;
  document.querySelectorAll("[data-load-control]").forEach(control => { control.disabled = loading; });
  refresh.textContent = loading ? "Caricamento…" : "Aggiorna EPG";
  if (loading) { error.textContent = ""; status.textContent = "Scaricamento e lettura della guida TV…"; }
});
receive("guide", value => {
  data = value;
  const options = document.createDocumentFragment();
  (data.epgChannels || []).forEach(channel => {
    const option = node("option");
    option.value = channel.id;
    option.label = channel.name;
    options.appendChild(option);
  });
  document.getElementById("epg-options").replaceChildren(options);
  error.textContent = value.warning || "";
  render();
});
receive("current", value => { current = value; render(); });
receive("error", value => {
  error.textContent = value;
  if (!data) status.textContent = "Guida non disponibile. Controlla la connessione e riprova con Aggiorna EPG.";
});
setInterval(render, 60000);
iina.postMessage("ready");
