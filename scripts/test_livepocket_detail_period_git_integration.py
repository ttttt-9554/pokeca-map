"""Integration test: verified dates survive a concurrent collector update."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parent
URL = 'https://livepocket.jp/e/test123'
DATES = ('2099-10-24T13:00:00+09:00', '2099-10-26T21:45:00+09:00')


class GitIntegration(unittest.TestCase):
    def shell(self, *argv):
        return subprocess.run(argv, cwd=self.tmp, text=True, check=True,
                              capture_output=True).stdout

    def write(self, name, payload):
        (self.tmp / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8')

    def read(self, name):
        return json.loads((self.tmp / name).read_text(encoding='utf-8'))

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.tmp = Path(self.directory.name)
        shutil.copy(ROOT / 'livepocket_detail_period_publish_latest.py', self.tmp)
        (self.tmp / 'livepocket_v11.py').write_text(
            'import json\n'
            'def write_json(path, data):\n'
            ' path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\\n")\n',
            encoding='utf-8')
        self.shell('git', 'init', '-q')
        self.shell('git', 'config', 'user.name', 'Test')
        self.shell('git', 'config', 'user.email', 'test@example.com')
        for name in ('livepocket_urls.json', 'livepocket_public.json'):
            self.write(name, {'items': [{'url': URL, 'title': 'original'}],
                              'updated_at': 'original'})
        self.shell('git', 'add', '.')
        self.shell('git', 'commit', '-qm', 'initial')
        (self.tmp / 'exclusions.json').write_text(
            json.dumps({'urls': ['https://livepocket.jp/e/unrelated']}),
            encoding='utf-8')

    def tearDown(self):
        self.directory.cleanup()

    def test_end_only_survives_capture_and_apply_without_made_up_start(self):
        for name in ('livepocket_urls.json', 'livepocket_public.json'):
            catalog=self.read(name)
            catalog['items'][0]['application_end_at']=DATES[1]
            self.write(name,catalog)
        self.shell('python','livepocket_detail_period_publish_latest.py',
                   'capture','--manifest','manifest.json')
        self.assertIsNone(self.read('manifest.json')['changes'][0]['application_start_at'])
        self.shell('git','restore','livepocket_urls.json','livepocket_public.json')
        self.shell('python','livepocket_detail_period_publish_latest.py',
                   'apply','--manifest','manifest.json',
                   '--manual-overrides-json','exclusions.json')
        for name in ('livepocket_urls.json', 'livepocket_public.json'):
            row=self.read(name)['items'][0]
            self.assertEqual(row['application_end_at'],DATES[1])
            self.assertNotIn('application_start_at',row)

    def test_capture_apply_preserves_concurrent_catalog_changes(self):
        for name in ('livepocket_urls.json', 'livepocket_public.json'):
            catalog = self.read(name)
            catalog['items'][0].update(
                application_start_at=DATES[0], application_end_at=DATES[1])
            self.write(name, catalog)
        self.shell('python', 'livepocket_detail_period_publish_latest.py',
                   'capture', '--manifest', 'manifest.json')
        self.assertEqual(len(self.read('manifest.json')['changes']), 1)
        self.shell('git', 'restore', 'livepocket_urls.json', 'livepocket_public.json')

        # A collector run publishes a new lottery + a changed title meanwhile.
        for name in ('livepocket_urls.json', 'livepocket_public.json'):
            catalog = self.read(name)
            catalog['items'][0]['title'] = 'newer name'
            catalog['items'].append({
                'url': 'https://livepocket.jp/e/second2', 'title': 'new event'})
            self.write(name, catalog)
        self.shell('git', 'add', '.')
        self.shell('git', 'commit', '-qm', 'concurrent collector')

        self.shell('python', 'livepocket_detail_period_publish_latest.py',
                   'apply', '--manifest', 'manifest.json',
                   '--manual-overrides-json', 'exclusions.json')
        for name in ('livepocket_urls.json', 'livepocket_public.json'):
            catalog = self.read(name)
            self.assertEqual(catalog['items'][0]['title'], 'newer name')
            self.assertEqual(catalog['items'][1]['title'], 'new event')
            self.assertEqual(catalog['items'][0]['application_end_at'], DATES[1])


if __name__ == '__main__':
    unittest.main()
