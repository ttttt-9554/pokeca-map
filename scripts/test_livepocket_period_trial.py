import unittest
from datetime import datetime, timedelta, timezone
import livepocket_period_trial as trial


class PeriodTrialTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)

    def test_only_urls_discovered_after_start_are_eligible(self):
        raw = {'collector_state': {'v14': {'pending_new_urls': ['old', 'new'],
            'new_url_checks': {'old': {'detected_at': (self.now-timedelta(minutes=1)).isoformat()},
                               'new': {'detected_at': (self.now+timedelta(minutes=1)).isoformat()}}}}}
        self.assertEqual(trial.start(raw, self.now), {'new'})
        self.assertEqual(trial.start(raw, self.now+timedelta(minutes=5)), {'new'})

    def test_first_scheduled_run_includes_url_after_cutover(self):
        detected = trial.TRIAL_CUTOVER + timedelta(seconds=1)
        raw = {'collector_state': {'v14': {'pending_new_urls':['new'],
                'new_url_checks': {'new': {'detected_at': detected.isoformat()}}}}}
        self.assertEqual(trial.start(raw, detected+timedelta(minutes=5)), {'new'})

    def test_collects_labeled_candidates_without_confusing_ticket_period(self):
        body = ('詳細\n抽選結果発表：2026年11月8日\n商品販売期間：2026年11月9日～11月15日\n'
                '受付・チケット情報\n販売受付期間：2026年11月1日～11月3日')
        row = trial.observation('https://livepocket.jp/e/test1', {'status':'ok', 'text':body}, self.now)
        self.assertIn('抽選結果発表', row['result_candidates'][0])
        self.assertIn('商品販売期間', row['purchase_candidates'][0])
        self.assertEqual(len(row['purchase_candidates']), 1)
        self.assertNotIn('商品販売期間', row['result_candidates'][0])
        self.assertNotIn('販売受付期間', row['purchase_candidates'][0])
        self.assertFalse(trial.lottery_or_unavailable({'status':'ok','text':'先着順チケット'}))
        self.assertTrue(trial.lottery_or_unavailable({'status':'ok','text':'抽選販売'}))
        self.assertTrue(trial.lottery_or_unavailable({'status':'browser_blocked'}))

    def test_failure_has_no_page_text_and_five_distinct_results_are_retained(self):
        raw = {}; trial.start(raw, self.now)
        blocked = trial.observation('a', {'status':'browser_blocked_or_empty', 'text':'challenge'}, self.now)
        self.assertEqual(blocked['result_candidates'], [])
        entries = [blocked] + [trial.observation(str(i), {'status':'ok','text':'情報なし'}, self.now) for i in range(6)]
        self.assertEqual(len(trial.append(raw, entries)), 5)
        self.assertEqual(len(trial.append(raw, entries)), 5)
        self.assertEqual(raw['collector_state']['period_trial_v1']['results'][0]['status'], 'browser_blocked_or_empty')

    def test_new_event_collector_reuses_the_single_page_fetch(self):
        import livepocket_v21 as v21
        url = 'https://livepocket.jp/e/trial1'
        raw = {'items': [{'url': url, 'discord_posted_at': self.now.isoformat()}],
            'collector_state': {'period_trial_v1': {'started_at': (self.now-timedelta(hours=1)).isoformat(), 'results': []},
              'v14': {'pending_new_urls': [url], 'new_url_checks': {url: {'detected_at': self.now.isoformat(), 'status': 'queued'}}}}}
        public = {'items': [{'url': url}]}
        calls = []
        def fetch(value):
            calls.append(value)
            return {'status':'ok', 'final_url':value, 'titles':['ポケモンカード抽選販売'], 'title_sources':['h1'],
                    'text':'概要\nポケモンカード抽選販売\n詳細\n抽選結果発表：2026年11月8日\n商品販売期間：2026年11月9日～11月15日\n受付・チケット情報\n応募期間：2026年11月5日10:00～2026年11月7日23:59\nお問い合わせ'}
        result = v21.process(raw, public, fetch, catalog=[], now=self.now, new_limit=1,
            background_limit=0, retry_limit=0, title_limit=0, verified={}, v19_verified={},
            verified_titles={}, verified_unavailable={})
        rows = result[0]['collector_state']['period_trial_v1']['results']
        self.assertEqual(calls, [url])
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]['result_candidates'])
        self.assertTrue(rows[0]['purchase_candidates'])
        self.assertNotIn('応募期間', rows[0]['purchase_candidates'][0])
        for catalog in result[:2]:
            item = next(item for item in catalog['items'] if item['url'] == url)
            self.assertEqual(item['result_announcement_date'], '2026-11-08')
            self.assertEqual(item['purchase_start_date'], '2026-11-09')
            self.assertEqual(item['purchase_end_date'], '2026-11-15')
            self.assertNotIn('result_announcement_time', item)


if __name__ == '__main__': unittest.main()
