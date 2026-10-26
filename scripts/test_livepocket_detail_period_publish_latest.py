import copy
from datetime import datetime, timezone
import unittest
from livepocket_detail_period_publish_latest import capture, apply_manifest

U='https://livepocket.jp/e/test123'
A='2099-10-24T13:00:00+09:00'
B='2099-10-26T21:45:00+09:00'
N=datetime(2026,10,26,tzinfo=timezone.utc)

class ManifestTests(unittest.TestCase):
    def original(self):
        return {'items':[{'url':U,'name':'A店'}], 'updated_at':'a'}
    def verified(self):
        catalog=self.original()
        catalog['items'][0].update(application_start_at=A,application_end_at=B)
        return catalog
    def manifest(self):
        return capture(self.original(), self.original(), self.verified(), self.verified(),N)

    def test_capture_dates(self):
        data=self.manifest()
        self.assertEqual(len(data['changes']),1)
        self.assertEqual(data['changes'][0]['application_start_at'],A)

    def test_capture_rejects_changed_non_date(self):
        modified=self.verified()
        modified['items'][0]['name']='different'
        with self.assertRaises(ValueError):
            capture(self.original(),self.original(),modified, self.verified(),N)

    def test_capture_rejects_mismatched_raw_and_public(self):
        with self.assertRaises(ValueError):
            capture(self.original(),self.original(),self.verified(),self.original(),N)

    def test_apply_current_catalog_preserves_other_fields(self):
        raw=self.original()
        pub=self.original()
        raw['items'][0]['another_field']='changed since fetch'
        pub['items'][0]['another_field']='changed since fetch'
        self.assertEqual(apply_manifest(raw,pub,self.manifest(),set(),N),1)
        self.assertEqual(raw['items'][0]['another_field'],'changed since fetch')
        self.assertEqual(pub['items'][0]['application_end_at'],B)

    def test_previously_filled_dates_not_overwritten(self):
        raw=self.original()
        pub=self.original()
        pub['items'][0]['application_end_at']='2099-10-25T21:45:00+09:00'
        self.assertEqual(apply_manifest(raw,pub,self.manifest(),set(),N),0)
        self.assertNotIn('application_start_at',raw['items'][0])

    def test_manual_override_skipped(self):
        raw=self.original()
        pub=self.original()
        self.assertEqual(apply_manifest(raw,pub,self.manifest(),{U},N),0)

    def test_invalid_manifest_fails_before_mutating(self):
        raw=self.original()
        pub=self.original()
        bad=self.manifest()
        bad['changes'].append({'url':U,'application_start_at':A,'application_end_at':B})
        with self.assertRaises(ValueError):
            apply_manifest(raw,pub,bad,set(),N)
        self.assertNotIn('application_start_at',raw['items'][0])

    def test_expired_manifest_rejected(self):
        raw=self.original()
        pub=self.original()
        with self.assertRaises(ValueError):
            apply_manifest(raw,pub,self.manifest(),set(),datetime(2100,1,1,tzinfo=timezone.utc))

    def test_empty_capture_allowed(self):
        manifest=capture(self.original(),self.original(),self.original(),self.original(),N)
        self.assertEqual(manifest['changes'],[])

if __name__=='__main__':
    unittest.main()
