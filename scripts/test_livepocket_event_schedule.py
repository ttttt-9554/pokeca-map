import unittest

import livepocket_event_schedule as schedule
import livepocket_v7 as v7


class EventScheduleTest(unittest.TestCase):
    def setUp(self):
        self.item = {'application_end_at': '2026-11-05T22:00:00+09:00'}

    def test_flattened_result_range_and_sale_dates(self):
        fields = schedule.extract(
            '当選発表：2026年11月6日（金）～11月10日（火）期間中に発表します '
            '販売期間：2026年11月13日（金）～11月15日（日） 計3日間 '
            '結果発表予定日 2026年11月6日（金）～11月10日（火）', self.item)
        self.assertEqual(fields, {
            'result_announcement_date': '2026-11-10',
            'purchase_start_date': '2026-11-13', 'purchase_end_date': '2026-11-15',
        })

    def test_only_explicit_times_and_latest_announcement(self):
        fields = schedule.extract(
            '抽選発表日：１１月６日 １７：３０〜１０日\n'
            '当選者様ご購入期間：11/14営業開始時刻~11/15 19時半まで', self.item)
        self.assertEqual(fields, {
            'result_announcement_date': '2026-11-10',
            'purchase_start_date': '2026-11-14',
            'purchase_end_date': '2026-11-15', 'purchase_end_time': '19:30',
        })
        self.assertEqual(schedule.extract('結果発表予定日：11/12 18:00', self.item), {
            'result_announcement_date': '2026-11-12', 'result_announcement_time': '18:00',
        })

    def test_purchase_and_pickup_label_on_store_ticket(self):
        fields = schedule.extract(
            '結果発表予定日\n2026年11月11日 ～ 11月13日中\n'
            '＜当選発表期間＞\n2026年11月11日（水）～ 11月13日（金）\n'
            '＜抽選販売の購入可能期間＞\n2026年11月14日（土）～ 11月16日（月）閉店まで\n'
            '【購入受け取り期間】2026年 11月14日（土） ～ 11月16日（月）', self.item)
        self.assertEqual(fields, {
            'result_announcement_date': '2026-11-13',
            'purchase_start_date': '2026-11-14', 'purchase_end_date': '2026-11-16',
        })

    def test_same_day_hours_and_year_boundary(self):
        fields = schedule.extract(
            '当選発表：2026/12/29 17:00～1/2 18:00\n購入期間：1/5 10時～20時',
            {'application_end_at': '2026-12-25T23:00:00+09:00'})
        self.assertEqual(fields, {
            'result_announcement_date': '2027-01-02', 'result_announcement_time': '18:00',
            'purchase_start_date': '2027-01-05', 'purchase_start_time': '10:00',
            'purchase_end_date': '2027-01-05', 'purchase_end_time': '20:00',
        })

    def test_ambiguous_and_ticket_dates_stay_empty(self):
        for body in (
            '抽選発表日：11/7、11/8',
            '結果発表日：11/7以降',
            '抽選発表日：11/7\n結果発表：11/8',
            '抽選発表日：11/7～11/40',
            'チケット販売期間：11/8～11/12',
            '販売期間：11/1～11/5',
        ):
            with self.subTest(body=body):
                self.assertEqual(schedule.extract(body, self.item), {})
        self.assertEqual(schedule.extract('結果発表予定日：11/12 18時頃', self.item), {
            'result_announcement_date': '2026-11-12',
        })

    def test_trial_seeds_and_export_preserves_date_only(self):
        url = 'https://livepocket.jp/e/schedule1'
        item = dict(self.item, url=url, private_note='internal')
        raw = {'items': [item], 'collector_state': {'period_trial_v1': {'results': [{
            'url': url, 'status': 'ok', 'result_candidates': ['結果発表予定日 11/12'],
            'purchase_candidates': [],
        }]}}}
        public = v7.public_export(raw)['items'][0]
        self.assertEqual(schedule.seed_trial(raw, {url: item}, {url: public}), 1)
        self.assertEqual(schedule.seed_trial(raw, {url: item}, {url: public}), 0)
        self.assertEqual(v7.public_export(raw)['items'], [public])
        self.assertEqual(public['result_announcement_date'], '2026-11-12')
        self.assertNotIn('result_announcement_time', public)
        self.assertNotIn('private_note', public)
        schedule.apply(item, public, {
            'result_announcement_date': '2026-11-12', 'result_announcement_time': '17:00',
        })
        self.assertEqual(schedule.seed_trial(raw, {url: item}, {url: public}), 0)
        self.assertEqual(public['result_announcement_time'], '17:00')
        self.assertFalse(schedule.apply(item, public, {}))
        schedule.apply(item, public, {'result_announcement_date': '2026-11-13'})
        self.assertNotIn('result_announcement_time', item)
        self.assertNotIn('result_announcement_time', public)


if __name__ == '__main__':
    unittest.main()
