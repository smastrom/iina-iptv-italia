const DEFAULT_PLAYLIST = "https://forgejo.it/peppenamir/iptv_italia/raw/branch/main/lista.m3u";
const DEFAULT_EPG = "https://epgshare01.online/epgshare01/epg_ripper_IT1.xml.gz";

function source(value) {
  if (typeof value !== "string") throw new Error("Inserisci un URL HTTP(S) o un percorso assoluto.");
  const result = value.trim();
  if (!result || /[\r\n\0]/.test(result) ||
      !/^(?:https?:\/\/[^\s/]+(?:[/?#][^\s]*)?|file:\/\/\/[^\r\n]*|\/[^\r\n]*|~\/[^\r\n]*)$/i.test(result)) {
    throw new Error("Inserisci un URL HTTP(S) valido o un percorso assoluto per playlist e guide.");
  }
  return result;
}

function defaults() {
  return { playlistUrl: DEFAULT_PLAYLIST, epgUrls: [DEFAULT_EPG], overrides: {} };
}

function validate(value) {
  if (!value || typeof value !== "object") throw new Error("Configurazione delle sorgenti non valida.");
  const playlistUrl = source(value.playlistUrl);
  const urls = typeof value.epgUrls === "string" ? value.epgUrls.split(/\r?\n/) : value.epgUrls;
  if (!Array.isArray(urls)) throw new Error("Inserisci una guida EPG per riga.");
  const epgUrls = [...new Set(urls.filter(url => typeof url !== "string" || url.trim()).map(source))];
  if (epgUrls.length > 16) throw new Error("Puoi usare fino a 16 guide EPG.");
  const overrides = {};
  if (value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)) {
    Object.keys(value.overrides).sort().forEach(url => {
      const id = value.overrides[url];
      if (typeof id === "string" && id.length <= 1024 && !/[\r\n\0]/.test(id)) {
        Object.defineProperty(overrides, url, { value: id, enumerable: true, configurable: true, writable: true });
      }
    });
  }
  return { playlistUrl, epgUrls, overrides };
}

function read(preferences) {
  try {
    const saved = preferences.get("sources");
    return saved ? validate(JSON.parse(saved)) : defaults();
  } catch (_) { return defaults(); }
}

module.exports = { defaults, validate, read };
