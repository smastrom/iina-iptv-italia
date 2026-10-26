import contextlib
import gzip
import http.server
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
HELPER = subprocess.check_output(['node', '-p', 'require("./epg-helper.js")'], cwd=ROOT, text=True)
EPG = {'__name__': 'test_helper'}
exec(HELPER, EPG)


def channel(name='News HD', identifier='', url='https://stream.test/1', tvg_name=''):
    return {'name': name, 'tvgName': tvg_name, 'tvgId': identifier, 'url': url}


def xml(identifier='news.test', name='News', title='Current programme'):
    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc)
    start = (now - dt.timedelta(minutes=10)).strftime('%Y%m%d%H%M%S +0000')
    stop = (now + dt.timedelta(hours=1)).strftime('%Y%m%d%H%M%S +0000')
    return ('<tv><channel id="' + identifier + '"><display-name>' + name + '</display-name></channel>'
            '<programme channel="' + identifier + '" start="' + start + '" stop="' + stop + '">'
            '<title>' + title + '</title><desc>Example</desc></programme></tv>').encode()


class ParserTests(unittest.TestCase):
    def test_download_timeout_does_not_disclose_provider_credentials(self):
        url = 'https://provider.test/list?username=private&password=secret'
        with mock.patch.object(EPG['subprocess'], 'run', side_effect=subprocess.TimeoutExpired(['curl', url], 65)):
            with self.assertRaises(RuntimeError) as error: EPG['download'](url)
        self.assertNotIn('private', str(error.exception))
        self.assertNotIn('secret', str(error.exception))

    def test_m3u_attributes_and_relative_urls(self):
        result = EPG['playlist']('\ufeff#EXTM3U\n#EXTINF:-1 tvg-id="news" tvg-name="News, HD" group-title=\'Live TV\',News, HD\n#EXTVLCOPT:network-caching=1000\n../stream/1\n', 'https://provider.test/lists/main.m3u')
        self.assertEqual(result[0]['tvgName'], 'News, HD')
        self.assertEqual(result[0]['group'], 'Live TV')
        self.assertEqual(result[0]['url'], 'https://provider.test/stream/1')
        with self.assertRaises(ValueError): EPG['playlist']('not a playlist')

    def test_discovers_all_common_m3u_epg_headers(self):
        result = EPG['epg_sources']('#EXTM3U x-tvg-url="guide.xml.gz,https://epg.test/2" url-tvg=\'other.xml;guide.xml.gz\' tvg-url="file:///etc/passwd"', 'https://provider.test/list.m3u')
        self.assertEqual(result, ['https://provider.test/guide.xml.gz', 'https://epg.test/2', 'https://provider.test/other.xml'])

    def test_xml_and_gzip_timestamps(self):
        for data in (xml(), gzip.compress(xml())):
            names, programmes = EPG['parse_epg'](data, time.time())
            self.assertEqual(names['news.test'], ['News'])
            self.assertEqual(programmes['news.test'][0]['title'], 'Current programme')
        self.assertEqual(EPG['timestamp']('20261027090000 +0100'), EPG['timestamp']('20261027080000'))
        with self.assertRaises(ValueError): EPG['parse_epg'](b'<html/>', time.time())

    def test_exact_id_takes_precedence(self):
        result = EPG['build']([channel(identifier='news.test', tvg_name='Other')], {'news.test': ['News'], 'other': ['Other']}, {}, 1)
        self.assertEqual(result['channels'][0]['epgId'], 'news.test')
        self.assertEqual(result['channels'][0]['match'], 'id')

    def test_casefold_accents_quality_and_country_suffix(self):
        cases = [(channel(identifier='NEWS.TEST'), {'news.test': ['News']}, 'id'),
                 (channel(name='Télé 1 HD'), {'tele1.fr': ['Télé 1']}, 'normalized'),
                 (channel(name='Rai1HD'), {'Rai1.it': []}, 'normalized')]
        for item, names, reason in cases:
            result = EPG['build']([item], names, {}, 1)['channels'][0]
            self.assertEqual(result['epgId'], next(iter(names)))
            self.assertEqual(result['match'], reason)

    def test_ambiguous_or_conflicting_names_are_not_guessed(self):
        for item, names in [(channel(), {'news.one': ['News'], 'news.two': ['News']}),
                            (channel(name='News', tvg_name='Other'), {'news': ['News'], 'other': ['Other']})]:
            result = EPG['build']([item], names, {}, 1)['channels'][0]
            self.assertIsNone(result['epgId'])
            self.assertEqual(result['match'], 'ambiguous')

    def test_timeshift_and_other_digits_stay_distinct(self):
        result = EPG['build']([channel(name='Rai 1 +1')], {'Rai11': ['Rai 11'], 'plus': ['Rai 1 +1']}, {}, 1)
        self.assertEqual(result['channels'][0]['epgId'], 'plus')

    def test_manual_disable_and_missing_override(self):
        for override, expected, reason in [('other', 'other', 'manual'), ('', None, 'disabled'), ('gone', None, 'missing')]:
            result = EPG['build']([channel()], {'news': ['News'], 'other': ['Other']}, {}, 1,
                                  {'https://stream.test/1': override})['channels'][0]
            self.assertEqual(result['epgId'], expected)
            self.assertEqual(result['match'], reason)


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)
        self.cache = self.path / 'data' / 'epg.json'
        (self.path / 'guide.xml.gz').write_bytes(gzip.compress(xml()))
        (self.path / 'list.m3u').write_text('#EXTM3U x-tvg-url="guide.xml.gz"\n#EXTINF:-1 tvg-id="news.test",News HD\nhttps://stream.test/live\n')
        self.config = {'playlistUrl': str(self.path / 'list.m3u'), 'epgUrls': [], 'overrides': {}}

    def tearDown(self): self.tmp.cleanup()

    def run_helper(self, force=False, success=True):
        result = subprocess.run(['python3', '-c', HELPER, str(self.cache), json.dumps(self.config), '1' if force else '0'], capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(Path(str(self.cache) + '.result').read_text())
        self.assertNotEqual(result.returncode, 0)

    def test_local_discovery_caching_and_force(self):
        first = self.run_helper()
        self.assertEqual(first['matched'], 1)
        self.assertEqual(first['epgSourceCount'], 1)
        self.assertEqual(first['channels'][0]['programmes'][0]['title'], 'Current programme')
        (self.path / 'list.m3u').unlink()
        self.assertEqual(self.run_helper()['updated'], first['updated'])
        stale = self.run_helper(force=True)
        self.assertEqual(stale['channels'], first['channels'])
        self.assertTrue(stale['retry'])

    def test_different_sources_never_reuse_old_channel_cache(self):
        self.run_helper()
        self.config['playlistUrl'] = str(self.path / 'missing.m3u')
        self.run_helper(success=False)

    def test_rematching_reuses_feed_cache(self):
        self.run_helper()
        (self.path / 'guide.xml.gz').unlink()
        self.config['overrides'] = {'https://stream.test/live': ''}
        result = self.run_helper()
        self.assertEqual(result['matched'], 0)
        self.assertEqual(result['channels'][0]['match'], 'disabled')
        self.config['overrides'] = {'https://stream.test/live': 'news.test'}
        self.assertEqual(self.run_helper()['matched'], 1)

    def test_failed_epg_still_returns_playable_channels_and_retries(self):
        self.config['epgUrls'] = [str(self.path / 'missing.xml')]
        result = self.run_helper()
        self.assertEqual(len(result['channels']), 1)
        self.assertEqual(result['matched'], 0)
        self.assertTrue(result['retry'])
        (self.path / 'missing.xml').write_bytes(xml())
        self.assertEqual(self.run_helper()['matched'], 1)

    def test_multiple_feeds_partial_failure_and_duplicate_id_priority(self):
        (self.path / 'second.xml').write_bytes(xml(title='Second feed'))
        self.config['epgUrls'] = [str(self.path / 'missing.xml'), str(self.path / 'guide.xml.gz'), str(self.path / 'second.xml')]
        result = self.run_helper()
        self.assertEqual(result['epgSourceCount'], 2)
        self.assertEqual(result['channels'][0]['programmes'][0]['title'], 'Current programme')
        self.assertIn('Guida EPG 1', result['warning'])

    def test_no_epg_advertised(self):
        (self.path / 'list.m3u').write_text('#EXTM3U\n#EXTINF:-1,News\nhttps://stream.test/live\n')
        result = self.run_helper()
        self.assertEqual(len(result['channels']), 1)
        self.assertIn('Nessuna guida EPG', result['warning'])

    def test_http_playlist_and_relative_epg_discovery(self):
        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(handler, *args, **kwargs):
                super().__init__(*args, directory=str(self.path), **kwargs)
            def log_message(self, *args): pass
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.config['playlistUrl'] = 'http://127.0.0.1:' + str(server.server_port) + '/list.m3u?user=example&password=example'
                self.assertEqual(self.run_helper()['matched'], 1)
            finally:
                server.shutdown()
                thread.join()


if __name__ == '__main__': unittest.main(verbosity=2)
