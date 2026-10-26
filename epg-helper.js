// Standard-library helper: macOS curl downloads, Python decompresses/parses XMLTV.
// Arguments are passed directly to the process; no shell is involved.
module.exports = String.raw`
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from urllib.parse import unquote, urljoin, urlsplit
import xml.etree.ElementTree as ET

TTL = 6 * 3600
LIMIT = 128 * 1024 * 1024
DOWNLOAD_LIMIT = 50 * 1024 * 1024
CACHE_VERSION = 2

def download(url):
    parsed = urlsplit(url)
    if parsed.scheme.lower() == 'file' or not parsed.scheme:
        if parsed.netloc not in ('', 'localhost'):
            raise ValueError('Usa un percorso locale per i file delle sorgenti.')
        path = unquote(parsed.path) if parsed.scheme else url
        with open(os.path.expanduser(path), 'rb') as source:
            data = source.read(DOWNLOAD_LIMIT + 1)
        if len(data) > DOWNLOAD_LIMIT:
            raise ValueError('La sorgente supera il limite di 50 MB.')
        return data
    if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname:
        raise ValueError('La sorgente deve essere un URL HTTP(S) o un file locale.')
    try:
        result = subprocess.run([
            '/usr/bin/curl', '--fail', '--silent', '--show-error', '--location',
            '--proto', '=http,https', '--proto-redir', '=http,https',
            '--connect-timeout', '15', '--max-time', '60',
            '--max-filesize', str(DOWNLOAD_LIMIT), '--url', url
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=65)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Tempo di download scaduto. Verifica la sorgente e riprova.') from None
    if result.returncode:
        # Provider URLs can contain credentials; do not echo them into the UI/logs.
        raise RuntimeError('Download non riuscito (curl ' + str(result.returncode) + ').')
    if len(result.stdout) > DOWNLOAD_LIMIT:
        raise ValueError('La sorgente supera il limite di 50 MB.')
    return result.stdout

def attributes(text):
    return {match[1].lower(): match[3] for match in
            re.finditer(r'''([\w-]+)\s*=\s*(["'])(.*?)\2''', text)}

def resolve_source(base, value):
    if not base or urlsplit(value).scheme: return value
    if urlsplit(base).scheme in ('http', 'https', 'file'): return urljoin(base, value)
    return os.path.normpath(os.path.join(os.path.dirname(os.path.expanduser(base)), value))

def epg_sources(text, base):
    result = []
    for line in text.lstrip('\ufeff').splitlines():
        if line.strip().startswith('#EXTM3U'):
            attrs = attributes(line)
            for key in ('x-tvg-url', 'url-tvg', 'tvg-url'):
                for value in re.split(r'[,;]', attrs.get(key, '')):
                    if value.strip():
                        url = resolve_source(base, value.strip())
                        # A remote playlist must not direct the helper to local files.
                        if urlsplit(base).scheme in ('http', 'https') and urlsplit(url).scheme not in ('http', 'https'):
                            continue
                        if url not in result: result.append(url)
    return result[:16]

def playlist(text, base=''):
    channels, pending = [], None
    for line in text.lstrip('\ufeff').splitlines():
        line = line.strip()
        if line.startswith('#EXTINF:'):
            # The title separator is the first comma outside quoted attributes.
            quoted, separator = False, -1
            for i, char in enumerate(line):
                if char in ('"', "'"):
                    if not quoted: quoted = char
                    elif quoted == char: quoted = False
                elif char == ',' and not quoted:
                    separator = i
                    break
            attrs = attributes(line[:separator] if separator >= 0 else line)
            title = line[separator + 1:].strip() if separator >= 0 else ''
            pending = {'name': title or attrs.get('tvg-name', '') or attrs.get('tvg-id', ''),
                       'tvgName': attrs.get('tvg-name', ''),
                       'tvgId': attrs.get('tvg-id', ''), 'group': attrs.get('group-title', '')}
        elif line and not line.startswith('#'):
            if pending is not None:
                pending['url'] = resolve_source(base, line)
                channels.append(pending)
            pending = None
    if not channels:
        raise ValueError('La playlist non contiene canali riconoscibili.')
    return channels

def normalized(value, loose=False):
    value = unicodedata.normalize('NFKD', value).casefold()
    value = ''.join(c for c in value if not unicodedata.combining(c))
    if loose:
        value = re.sub(r'\.[a-z]{2,3}$', '', value)
        value = re.sub(r'\b(?:hd|fhd|uhd|4k|sd)\b', '', value)
        value = re.sub(r'(?<=\d)(?:fhd|uhd|hd|sd|4k)$', '', value.strip())
    value = value.replace('+', 'plus')
    return ''.join(c for c in value if c.isalnum())

def timestamp(value):
    match = re.fullmatch(r'(\d{14})\s*([+-]\d{4})?', value.strip())
    if not match:
        raise ValueError('Invalid XMLTV timestamp')
    # XMLTV uses UTC when the optional offset is absent.
    return dt.datetime.strptime(match[1] + (match[2] or '+0000'),
                                '%Y%m%d%H%M%S%z').timestamp()

def parse_epg(data, now):
    source = gzip.GzipFile(fileobj=io.BytesIO(data)) if data[:2] == b'\x1f\x8b' else io.BytesIO(data)
    xml = source.read(LIMIT + 1)
    if len(xml) > LIMIT:
        raise ValueError('La guida TV supera il limite di 128 MB.')
    names, programmes = {}, {}
    events = ET.iterparse(io.BytesIO(xml), events=('start', 'end'))
    _, root = next(events)
    if root.tag != 'tv':
        raise ValueError('Il feed non contiene una guida XMLTV.')
    for event, element in events:
        if event != 'end': continue
        if element.tag == 'channel':
            names[element.get('id', '')] = [e.text or '' for e in element.findall('display-name')]
            root.remove(element)
        elif element.tag == 'programme':
            try:
                start, stop = timestamp(element.get('start', '')), timestamp(element.get('stop', ''))
                if stop > now and start < now + 3 * 86400 and stop > start:
                    item = {'start': start * 1000, 'stop': stop * 1000,
                            'title': element.findtext('title', '').strip(),
                            'description': element.findtext('desc', '').strip()}
                    programmes.setdefault(element.get('channel', ''), []).append(item)
            except (ValueError, OverflowError):
                pass
            root.remove(element)
    for schedule in programmes.values():
        schedule.sort(key=lambda item: (item['start'], item['stop']))
    if not names and not programmes:
        raise ValueError('La guida XMLTV è vuota.')
    return names, programmes

def build(channels, names, programmes, now, overrides=None):
    overrides = overrides or {}
    ids = set(names) | set(programmes)
    exact = {}
    for identifier in ids:
        exact.setdefault(identifier.casefold(), set()).add(identifier)
    aliases = {False: {}, True: {}}
    for identifier in ids:
        for name in [identifier] + names.get(identifier, []):
            for loose in (False, True):
                key = normalized(name, loose)
                if key: aliases[loose].setdefault(key, set()).add(identifier)
    matched = 0
    for channel in channels:
        identifier, reason = None, 'unmatched'
        if channel['url'] in overrides:
            identifier = overrides[channel['url']] or None
            reason = 'manual' if identifier in ids else 'disabled' if identifier is None else 'missing'
            if identifier not in ids: identifier = None
        elif channel['tvgId'] in ids:
            identifier, reason = channel['tvgId'], 'id'
        else:
            candidates = exact.get(channel['tvgId'].casefold(), set())
            if len(candidates) == 1: identifier, reason = next(iter(candidates)), 'id'
        if not identifier and channel['url'] not in overrides:
            for loose in (False, True):
                candidates = set()
                for name in (channel['tvgName'], channel['name'], channel['tvgId']):
                    candidates.update(aliases[loose].get(normalized(name, loose), set()))
                if len(candidates) == 1:
                    identifier, reason = next(iter(candidates)), 'normalized' if loose else 'name'
                elif len(candidates) > 1:
                    reason = 'ambiguous'
                    break
                if identifier: break
        channel['epgId'] = identifier
        channel['match'] = reason
        channel['programmes'] = programmes.get(identifier, [])
        if identifier: matched += 1
    catalog = [{'id': identifier, 'name': next(iter(names.get(identifier, [])), identifier)}
               for identifier in sorted(ids, key=lambda key: (next(iter(names.get(key, [])), key).casefold(), key))]
    return {'updated': now * 1000, 'matched': matched, 'channels': channels, 'epgChannels': catalog}

def publish(cache_path, data):
    # Keep large guide data out of IINA's process-output pipe.
    output_path = cache_path + '.result'
    with open(output_path + '.tmp', 'w', encoding='utf-8') as output:
        json.dump(data, output)
    os.replace(output_path + '.tmp', output_path)

def load_epg(url, cache_path, now, force):
    # Reuse parsed feeds when only channel corrections change. Cache each source
    # separately so a new source never receives another source's programmes.
    digest = hashlib.sha256(url.encode('utf-8')).hexdigest()
    path = os.path.join(os.path.dirname(cache_path), 'feed-' + digest + '.json')
    if not force:
        try:
            with open(path, encoding='utf-8') as source:
                cached = json.load(source)
            if cached['version'] == CACHE_VERSION and 0 <= now - cached['updated'] < TTL:
                return cached['names'], cached['programmes']
        except (OSError, ValueError, KeyError, TypeError): pass
    names, programmes = parse_epg(download(url), now)
    with open(path + '.tmp', 'w', encoding='utf-8') as output:
        json.dump({'version': CACHE_VERSION, 'updated': now, 'names': names, 'programmes': programmes}, output)
    os.replace(path + '.tmp', path)
    return names, programmes

def main():
    cache_path, config_json, force = sys.argv[1:]
    config = json.loads(config_json)
    source_key = hashlib.sha256(config_json.encode('utf-8')).hexdigest()
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    now, cached = time.time(), None
    try:
        with open(cache_path, encoding='utf-8') as source:
            cached = json.load(source)
        if (cached.get('cacheVersion') != CACHE_VERSION or cached.get('sourceKey') != source_key
                or not isinstance(cached.get('channels'), list)
                or not isinstance(cached.get('updated'), (int, float))): cached = None
    except (OSError, ValueError, AttributeError):
        cached = None
    if cached and not cached.get('retry') and force != '1' and 0 <= now * 1000 - cached['updated'] < TTL * 1000:
        publish(cache_path, cached)
        return
    try:
        text = download(config['playlistUrl']).decode('utf-8-sig')
        channels = playlist(text, config['playlistUrl'])
        sources = config['epgUrls'] or epg_sources(text, config['playlistUrl'])
        names, programmes, warnings = {}, {}, []
        loaded = 0
        for index, url in enumerate(sources):
            try:
                feed_names, feed_programmes = load_epg(url, cache_path, now, force == '1')
                for identifier, aliases in feed_names.items():
                    names.setdefault(identifier, []).extend(name for name in aliases if name not in names.get(identifier, []))
                for identifier, schedule in feed_programmes.items():
                    # First feed with a schedule wins for repeated IDs.
                    programmes.setdefault(identifier, schedule)
                loaded += 1
            except Exception:
                warnings.append('Guida EPG ' + str(index + 1) + ' non disponibile. Verifica la sorgente e riprova.')
        if sources and not loaded and cached:
            raise ValueError('Nessuna sorgente EPG disponibile.')
        data = build(channels, names, programmes, now, config.get('overrides'))
        data.update(cacheVersion=CACHE_VERSION, sourceKey=source_key, configKey=config_json,
                    epgSourceCount=loaded, retry=bool(warnings))
        if not sources: warnings.append('Nessuna guida EPG indicata nella playlist. Aggiungi una sorgente in Sorgenti IPTV / EPG.')
        if warnings: data['warning'] = ' '.join(warnings)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        temporary = cache_path + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as output:
            json.dump(data, output)
        os.replace(temporary, cache_path)
    except Exception:
        if cached is None: raise
        data = dict(cached, warning='Aggiornamento non riuscito; uso dei dati salvati per queste sorgenti.', retry=True)
    publish(cache_path, data)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
`;
