// Shared pure model. Programme schedules are already sorted by the XMLTV reader.
(function (root, factory) {
  if (typeof module === "object") module.exports = factory(require("./epg-match.js").matchChannel);
  else root.IPTVChannels = factory();
})(this, function (matchChannel) {
  function programmeAt(schedule, now) {
    let low = 0, high = schedule.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (schedule[middle].start <= now) low = middle + 1;
      else high = middle;
    }
    const candidate = schedule[low - 1];
    const current = candidate && candidate.stop > now ? candidate : null;
    const next = schedule[low];
    return {
      current,
      nextChange: Math.min(current ? current.stop : Infinity, next ? next.start : Infinity)
    };
  }

  function snapshot(entries, channels) {
    const byURL = new Map(channels.map(channel => [channel.url, channel]));
    return entries.map((entry, index) => {
      const channel = byURL.get(entry.filename) || matchChannel && matchChannel(channels, { url: entry.filename, title: entry.title });
      return {
        id: entry.id, index, url: entry.filename,
        name: channel ? channel.name : entry.title || entry.filename,
        // Descriptions and other guide metadata are not needed by the list.
        programmes: channel ? channel.programmes.map(p => ({ start: p.start, stop: p.stop, title: p.title })) : []
      };
    });
  }

  function labelsAt(rows, now) {
    let nextChange = Infinity;
    const labels = rows.map(row => {
      const programme = programmeAt(row.programmes, now);
      nextChange = Math.min(nextChange, programme.nextChange);
      return row.name + (programme.current && programme.current.title ? " · " + programme.current.title : "");
    });
    return { labels, nextChange };
  }

  return { programmeAt, snapshot, labelsAt };
});
