function normalized(value) {
  return String(value || "").trim().normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "").replace(/\.[a-z]{2,3}$/, "")
    .replace(/\b(?:hd|fhd|uhd|4k|sd)\b/g, "").replace(/(\d)(?:fhd|uhd|hd|sd|4k)$/, "$1")
    .replace(/\+/g, "plus").replace(/[^\p{L}\p{N}]/gu, "");
}

function matchChannel(channels, current) {
  const urls = current.urls || [current.url];
  const exact = channels.find(channel => urls.includes(channel.url));
  if (exact) return exact;
  const title = normalized(current.title);
  if (!title) return null;
  const matches = channels.filter(channel =>
    [channel.name, channel.tvgName].some(name => normalized(name) === title));
  if (matches.length === 1 || matches.length > 1 && matches[0].epgId &&
      matches.every(channel => channel.epgId === matches[0].epgId)) return matches[0];
  return null;
}

module.exports = { matchChannel };
