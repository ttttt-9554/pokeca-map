"""New-arrival failures, bounded retry and placeholder-regression tests."""
import copy
import unittest
from datetime import datetime, timedelta, timezone
import livepocket_arrival_policy as policy
import livepocket_collect as collect
import livepocket_v7 as v7
import livepocket_v9 as v9
import livepocket_v14 as v14
import livepocket_v15 as v15
import livepocket_v17 as v17
import livepocket_v19 as v19
import livepocket_v21 as v21

NOW = datetime(2026, 10, 24, 10, 0, tzinfo=timezone.utc)
URL = 'https://livepocket.jp/e/test0'


def fixture(status='browser_http_error', http=405, minutes=31, attempts=0):
    when = (NOW-timedelta(minutes=minutes)).isoformat()
    item = {'url': URL}
    raw = {'items': [item], 'collector_state': {
        'v14': {'new_url_checks': {URL: {
            'detected_at': (NOW-timedelta(hours=3)).isoformat(),
            'checked_at': when, 'status': status}}, 'pending_new_urls': []},
        'v13': {'browser_checks': {URL: {'checked_at': when, 'status': status}}},
        'v16': {'retry_log': {}},
        'v21_9': {'official_checks': {URL: {
            'checked_at': when, 'status': status, 'http_status': http}}},
    }}
    if attempts:
        raw['collector_state']['v16']['retry_log'][URL] = {
            'attempts': attempts, 'last_attempt_at': when, 'last_status': status}
    return raw, {'items': [copy.deepcopy(item)]}


class PlaceholderTests(unittest.TestCase):
    def test_placeholder_is_never_a_store(self):
        for name in ('店舗名不明', '店舗名未確認', '店舗未取得', 'UNKNOWN', '店舗 名 不明'):
            self.assertTrue(policy.unknown_shop(name), name)
            self.assertFalse(collect.credible_store(name), name)
            self.assertFalse(v7.is_shop(name), name)
            self.assertIsNone(v15.clean_value(name, 'store_name'), name)
            self.assertIsNone(v19.safe_name(name), name)
        self.assertFalse(policy.unknown_shop('古本市場 東住吉店'))
        self.assertTrue(v19.safe_name('古本市場 東住吉店'))

    def test_clean_only_poisoned_prefecture_and_no_other_fields(self):
        raw, public = fixture()
        r = raw['items'][0]
        r.update(store_name='店舗名不明', prefecture='宮城県',
                 event_title='公式の抽選名', application_end_at='2026-11-01T12:00:00+09:00',
                 stores=[{'name':'店舗名不明','prefecture':'宮城県'}],
                 field_sources={'prefecture':'v9_exact_store_cross_reference'})
        public['items'][0] = copy.deepcopy(r)
        self.assertEqual(policy.clean_placeholders(raw, public), 1)
        for row in (r, public['items'][0]):
            self.assertNotIn('store_name', row)
            self.assertNotIn('prefecture', row)
            self.assertNotIn('stores', row)
            self.assertEqual(row['event_title'], '公式の抽選名')
            self.assertEqual(row['application_end_at'], '2026-11-01T12:00:00+09:00')
        self.assertEqual(policy.clean_placeholders(raw, public), 0)

    def test_independent_prefecture_and_real_store_preserved(self):
        raw, public = fixture()
        r = raw['items'][0]
        r.update(store_name='店舗名不明', prefecture='宮城県',
                 field_sources={'prefecture':'discord_explicit'})
        policy.clean_placeholders(raw)
        self.assertEqual(r['prefecture'], '宮城県')
        r.update(store_name='TSUTAYA仙台店', field_sources={'prefecture':'v9_exact_store_cross_reference'})
        before = copy.deepcopy(r)
        policy.clean_placeholders(raw)
        self.assertEqual(r, before)

    def test_no_placeholder_cross_reference(self):
        raw, public = fixture()
        raw['items'] = [
            {'url':URL, 'store_name':'店舗名不明','prefecture':'宮城県'},
            {'url':URL+'x', 'store_name':'店舗名不明'}]
        public['items'] = copy.deepcopy(raw['items'])
        fixed, pub, _, stats = v9.transform(raw, public)
        self.assertEqual(stats['prefectures_added'], 0)
        self.assertNotIn('prefecture', fixed['items'][1])
        self.assertNotIn('prefecture', pub['items'][1])
        self.assertEqual(raw['items'][1]['store_name'], '店舗名不明')

    def test_recover_only_exact_official_shop_not_prefecture(self):
        raw, public = fixture()
        raw['items'][0].update(event_title='【古本市場 東住吉店】ポケモンカード抽選',
            store_name='店舗名不明', prefecture='宮城県',
            field_sources={'event_title':'v14_livepocket_rendered_public_page',
                           'prefecture':'v9_exact_store_cross_reference'})
        public['items'] = copy.deepcopy(raw['items'])
        v19.apply_stores(raw, public)
        for row in (raw['items'][0],public['items'][0]):
            self.assertEqual(row['store_name'],'古本市場 東住吉店')
            self.assertFalse(row.get('prefecture'))
            self.assertEqual(row['stores'][0]['name'],'古本市場 東住吉店')
        raw, public = fixture()
        raw['items'][0].update(event_title='【古本市場 東住吉店】ポケモンカード抽選',
                              field_sources={'event_title':'discord_guess'})
        v19.apply_stores(raw, public)
        self.assertFalse(raw['items'][0].get('store_name'))


class RetryTests(unittest.TestCase):
    def test_405_first_retry_boundary(self):
        for age, due in ((29,False),(30,True),(31,True)):
            raw,pub=fixture(minutes=age)
            self.assertEqual(bool(v17.due_retries(raw,pub,NOW)),due)
        self.assertEqual(policy.quick_retry_wait(raw,URL,NOW),timedelta(minutes=30))

    def test_second_retry_and_budget(self):
        for age,due in ((59,False),(60,True)):
            raw,pub=fixture(minutes=age,attempts=1)
            self.assertEqual(bool(v17.due_retries(raw,pub,NOW)),due)
        raw,pub=fixture(minutes=400,attempts=2)
        self.assertIsNone(policy.quick_retry_wait(raw,URL,NOW))
        self.assertEqual(v17.due_retries(raw,pub,NOW),[])

    def test_timeout_server_error_have_bounded_short_retry(self):
        for status,http in [('browser_timeout',None),('browser_no_response',None),
                            ('browser_error',None),('browser_http_error',503),
                            ('browser_http_error',408)]:
            raw,pub=fixture(status,http,minutes=15)
            self.assertEqual(v17.due_retries(raw,pub,NOW),[URL])
            raw,pub=fixture(status,http,minutes=14)
            self.assertEqual(v17.due_retries(raw,pub,NOW),[])

    def test_never_shorten_access_gate_or_redirect(self):
        for status,http in [('browser_blocked',403),('browser_blocked',429),
                            ('browser_blocked_or_empty',200),('browser_http_error',401),
                            ('browser_http_error',404),('browser_redirected',302),
                            ('checked_no_new_details',200)]:
            raw,pub=fixture(status,http,minutes=120)
            self.assertIsNone(policy.quick_retry_wait(raw,URL,NOW))
            self.assertEqual(v17.due_retries(raw,pub,NOW),[])

    def test_later_success_does_not_inherit_old_405(self):
        raw,pub=fixture(minutes=120)
        raw['collector_state']['v13']['browser_checks'][URL]={
            'status':'checked_no_new_details', 'checked_at':(NOW-timedelta(minutes=10)).isoformat()}
        self.assertIsNone(policy.latest_result(raw,URL)[1])
        self.assertIsNone(policy.quick_retry_wait(raw,URL,NOW))
        self.assertEqual(v17.due_retries(raw,pub,NOW),[])

    def test_old_future_and_expired_events_are_skipped(self):
        for offset in (timedelta(days=15),timedelta(days=-1)):
            raw,pub=fixture()
            raw['collector_state']['v14']['new_url_checks'][URL]['detected_at']=(NOW-offset).isoformat()
            self.assertEqual(v17.due_retries(raw,pub,NOW),[])
        raw,pub=fixture()
        pub['items'][0]['application_end_at']='2026-10-23T21:00:00+09:00'
        self.assertEqual(v17.due_retries(raw,pub,NOW),[])

    def test_schedule_and_developer_diagnostics_agree(self):
        raw,pub=fixture(minutes=10)
        when,reason=v17.retry_schedule(raw,pub,URL,NOW)
        self.assertEqual(reason,'waiting')
        result=v21.manual_recheck_candidates(raw,pub,now=NOW,summary=True,include_items=True)
        row=result['items'][0]
        self.assertEqual(row['last_http_status'],405)
        self.assertEqual(row['last_check_status'],'browser_http_error')
        self.assertEqual(policy.stamp(when),policy.stamp(row['next_retry_at']))
        self.assertEqual(row['queue'],'retry_wait')
        raw,pub=fixture(minutes=31)
        result=v21.manual_recheck_candidates(raw,pub,now=NOW,summary=True,include_items=True)
        self.assertEqual(result['ready'],1)
        result=v21.manual_recheck_candidates(raw,pub,now=NOW,summary=True,
                                             completed_reviews={URL})
        self.assertEqual(result['ready'],0)
        self.assertEqual(result['completed'],1)

    def test_global_cooldown_is_honored(self):
        raw,pub=fixture(minutes=60)
        until=NOW+timedelta(hours=5)
        raw['collector_state']['v14']['blocked_until']=until.isoformat()
        self.assertEqual(v17.due_retries(raw,pub,NOW),[])
        result=v21.manual_recheck_candidates(raw,pub,now=NOW,summary=True,include_items=True)
        self.assertEqual(result['next_batch_size'],0)
        self.assertEqual(policy.stamp(result['items'][0]['next_retry_at']),until)

    def test_three_http_failures_leave_unvisited_new_urls_pending(self):
        urls=[URL+str(x) for x in range(8)]
        raw={'items':[{'url':u} for u in urls], 'collector_state':{'v14':{
            'new_url_checks':{u:{'detected_at':NOW.isoformat()} for u in urls},
            'pending_new_urls':urls}}}
        public={'items':copy.deepcopy(raw['items'])}
        calls=[]
        def fetch(u):
            calls.append(u)
            return {'status':'browser_http_error','http_status':405}
        result=v14.process(raw,public,fetch,now=NOW)
        self.assertEqual(len(calls),3)
        state=result[0]['collector_state']['v14']
        self.assertEqual(len(state['pending_new_urls']),5)
        self.assertEqual(policy.stamp(state['blocked_until']),NOW+timedelta(minutes=30))
        self.assertEqual(len(raw['collector_state']['v14']['pending_new_urls']),8)

    def test_pause_does_not_shorten_longer_pause(self):
        state={'blocked_until':(NOW+timedelta(hours=6)).isoformat()}
        _,stop=policy.stop_repeated_http_errors(state,{'status':'browser_http_error','http_status':405},2,NOW)
        self.assertTrue(stop)
        self.assertEqual(policy.stamp(state['blocked_until']),NOW+timedelta(hours=6))


if __name__=='__main__':
    unittest.main(verbosity=2)
