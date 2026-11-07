import unittest
import tempfile
import json
import os
from pathlib import Path
from unittest.mock import patch
from datetime import datetime,timedelta,timezone
import livepocket_v21 as v21
import livepocket_individual_fetch as individual

URL='https://livepocket.jp/e/sample123'
NOW=datetime(2026,11,5,1,tzinfo=timezone.utc)
BODY='概要\nポケモンカード抽選販売\n詳細\n対象店舗\nテスト渋谷店（東京都）\n応募期間 2026年11月5日10:00～2026年11月7日23:59\n受付・チケット情報\nお問い合わせ'
def page(url=URL,text=BODY):
    return {'status':'ok','final_url':url,'titles':['ポケモンカード抽選販売'],
            'title_sources':['h1'],'text':text}
def pair(pending=False):
    return ({'items':[{'url':URL,'discord_posted_at':NOW.isoformat()}],
        'collector_state':{'v14':{'pending_new_urls':[URL] if pending else [],
        'new_url_checks':{URL:{'detected_at':NOW.isoformat(),'status':'queued'}} if pending else {}}}},
        {'items':[{'url':URL}]})

class IndividualFetchTests(unittest.TestCase):
    def test_extract_exact_event_title_dates_and_store(self):
        result=individual.extract(v21,URL,page())
        self.assertEqual(result['status'],'success')
        self.assertEqual(result['fields']['event_title'],'ポケモンカード抽選販売')
        self.assertEqual(result['fields']['stores'][0]['name'],'テスト渋谷店')
        self.assertEqual(result['fields']['stores'][0]['prefecture'],'東京都')
        self.assertIn('2026-11-07T23:59',result['fields']['application_end_at'])
    def test_wrong_url_or_robot_never_yields_fields(self):
        self.assertEqual(individual.extract(v21,URL,page('https://livepocket.jp/e/other123'))['fields'],{})
        blocked=individual.extract(v21,URL,page(text="Verify that you're not a robot"))
        self.assertEqual(blocked['status'],'blocked')
        self.assertEqual(blocked['fields'],{})
    def test_ambiguous_dates_are_not_selected(self):
        text=BODY.replace('受付・チケット情報','申込期間 2026年11月5日10:00～2026年11月8日23:59\n受付・チケット情報')
        fields=individual.extract(v21,URL,page(text=text))['fields']
        self.assertNotIn('application_end_at',fields)

    def test_overview_venue_supplies_store_in_individual_and_scheduled_collection(self):
        body = BODY.replace('対象店舗\nテスト渋谷店（東京都）',
                            '会場\nTSUTAYA佐野店 (栃木県)\n佐野市田島町51 TSUTAYA佐野店')
        observation = {**page(text=body), 'overview_venue': 'TSUTAYA佐野店 (栃木県)'}
        stores = [{'name': 'TSUTAYA佐野店', 'prefecture': '栃木県'}]
        self.assertEqual(individual.extract(v21, URL, observation)['fields']['stores'], stores)
        raw, public = pair(pending=True)
        raw, public, *_ = v21.process(
            raw, public, lambda _: observation, catalog=[], now=NOW, new_limit=1,
            background_limit=0, retry_limit=0, title_limit=0, verified={}, v19_verified={},
            verified_titles={}, verified_unavailable={})
        for row in (raw['items'][0], public['items'][0]):
            self.assertEqual(row['stores'], stores)
            self.assertEqual(row['store_name'], 'TSUTAYA佐野店')
            self.assertEqual(row['prefecture'], '栃木県')

    def test_overview_venue_defers_to_explicit_stores(self):
        observation = {**page(), 'overview_venue': 'TSUTAYA佐野店 (栃木県)'}
        stores = individual.extract(v21, URL, observation)['fields']['stores']
        self.assertEqual(stores, [{'name': 'テスト渋谷店', 'prefecture': '東京都'}])
        conflicting = BODY.replace('応募期間', '対象店舗：別店舗（千葉県）\n応募期間')
        observation['text'] = conflicting
        # The overview venue must not replace an ambiguous store list.
        self.assertIsNone(v21.v19.overview_store({**observation, 'page_identity': 'event_confirmed'}))
        observation['text'] = BODY.replace('対象店舗\nテスト渋谷店（東京都）\n', '')
        observation['overview_venue'] = 'テスト体育館（栃木県）'
        self.assertNotIn('stores', individual.extract(v21, URL, observation)['fields'])

    def test_trading_card_branch_without_shop_suffix_in_both_collection_paths(self):
        name = 'TSUTAYA Trading Card 宇都宮インターパークビレッジ'
        venue = name + ' (栃木県)'
        body = BODY.replace('対象店舗\nテスト渋谷店（東京都）', '会場\n' + venue)
        observation = {**page(text=body), 'overview_venue': venue}
        stores = [{'name': name, 'prefecture': '栃木県'}]
        self.assertEqual(individual.extract(v21, URL, observation)['fields']['stores'], stores)
        raw, public = pair(pending=True)
        raw, public, *_ = v21.process(
            raw, public, lambda _: observation, catalog=[], now=NOW, new_limit=1,
            background_limit=0, retry_limit=0, title_limit=0, verified={}, v19_verified={},
            verified_titles={}, verified_unavailable={})
        for row in (raw['items'][0], public['items'][0]):
            self.assertEqual(row['stores'], stores)
            self.assertEqual(row['store_name'], name)
            self.assertEqual(row['prefecture'], '栃木県')
        self.assertEqual(raw['items'][0]['field_sources']['stores'], 'v19_livepocket_overview_venue')

    def test_trading_card_venue_keeps_identity_scope_and_existing_stores(self):
        name = 'TSUTAYA Trading Card 宇都宮インターパークビレッジ'
        observation = {**page(), 'page_identity': 'event_confirmed',
                       'overview_venue': name + ' (栃木県)'}
        self.assertIsNone(v21.v19.overview_store({**observation, 'page_identity': 'event_unconfirmed'}))
        for venue in (name, 'TSUTAYA Trading Card (栃木県)', 'TSUTAYA O-EAST (東京都)',
                      'テスト体育館 (栃木県)'):
            with self.subTest(venue=venue):
                self.assertIsNone(v21.v19.overview_store({**observation, 'overview_venue': venue}))
        self.assertEqual(individual.extract(v21, URL, observation)['fields']['stores'],
                         [{'name': 'テスト渋谷店', 'prefecture': '東京都'}])
        existing = [{'name': '保存済みの店舗', 'prefecture': '東京都'}]
        raw, public = pair()
        for row in (raw['items'][0], public['items'][0]):
            row.update(store_name=existing[0]['name'], prefecture='東京都', stores=existing)
        observation['text'] = BODY.replace('対象店舗\nテスト渋谷店（東京都）\n', '')
        v21.v19.apply_stores(raw, public, {URL: observation})
        self.assertEqual(raw['items'][0]['stores'], existing)
        self.assertEqual(public['items'][0]['stores'], existing)

    def test_purchase_window_in_shop_ticket_is_removed_from_new_and_saved_stores(self):
        prefix = '11/14～11/16購入可能・'
        names = ['フルコンプ秋葉原店', 'フルコンプ千葉店']
        ticket_text = '\n'.join(f'【{prefix}{name}】抽選販売分購入権利\n販売中\n¥0' for name in names)
        body = BODY.replace('対象店舗\nテスト渋谷店（東京都）\n', '') + '\n' + ticket_text
        stores = individual.extract(v21, URL, page(text=body))['fields']['stores']
        self.assertEqual(stores, [{'name': name, 'prefecture': ''} for name in names])
        existing = [{'name': prefix + name, 'prefecture': ''} for name in names]
        self.assertEqual(v21.v19.merge_stores(existing, stores, []), stores)
        self.assertEqual(v21.v19.safe_name('11/14模型店'), '11/14模型店')

    def test_restock_tickets_supply_stores_product_and_start_in_both_paths(self):
        product = 'ポケモンカードゲーム MEGA 拡張パック ストームエメラルダ'
        stores = [{'name': 'PAO青梅店', 'prefecture': ''}, {'name': '竜星のPAO大宮店', 'prefecture': ''}]
        body = ('概要\nポケモンカード抽選販売\n詳細\n応募締切：2026年11月8日23:59まで\n'
                '受付・チケット情報\n抽選販売受付\n販売受付期間\n'
                '2026年11月6日11:50〜2026年11月8日23:59\n' +
                '\n'.join(f"{store['name']}【再販分】{product}\n販売中\n¥0" for store in stores))
        observation = page(text=body)
        fields = individual.extract(v21, URL, observation)['fields']
        expected = {'stores': stores, 'product_name': product,
                    'application_start_at': '2026-11-06T11:50:00+09:00',
                    'application_end_at': '2026-11-08T23:59:00+09:00'}
        raw, public = pair(pending=True)
        raw, public, *_ = v21.process(
            raw, public, lambda _: observation, catalog={}, now=NOW, new_limit=1,
            background_limit=0, retry_limit=0, title_limit=0, verified={}, v19_verified={},
            verified_titles={}, verified_unavailable={})
        for row in (fields, raw['items'][0], public['items'][0]):
            self.assertEqual({key: row[key] for key in expected}, expected)
        self.assertEqual(v21.v19.page_stores(body.replace('販売中', '').replace('¥0', '')), [])

    def run_case(self,pending=False,blocked=False,unknown=False):
        raw,public=pair(pending)
        if blocked:raw['collector_state']['v14']['blocked_until']=(NOW+timedelta(hours=1)).isoformat()
        calls=[];result={}
        def fetch(url):calls.append(url);return page(url)
        request={'url':'https://livepocket.jp/e/unknown123' if unknown else URL,'request_id':'fake'}
        out=v21.process(raw,public,fetch,catalog=[],now=NOW,new_limit=1 if pending else 0,
            background_limit=0,retry_limit=0,title_limit=0,verified={},v19_verified={},
            verified_titles={},verified_unavailable={},individual_request=request,individual_result=result)
        return calls,result,out
    def test_single_requested_event_only_and_does_not_modify_card(self):
        calls,result,out=self.run_case()
        self.assertEqual(calls,[URL]);self.assertEqual(result['status'],'success')
        self.assertNotIn('event_title',out[1]['items'][0])
        self.assertNotIn('stores',out[1]['items'][0])
    def test_already_scheduled_page_is_not_fetched_twice(self):
        calls,result,_=self.run_case(pending=True)
        self.assertEqual(calls,[URL]);self.assertEqual(result['status'],'success')
    def test_cooldown_and_unknown_url_do_not_fetch(self):
        calls,result,_=self.run_case(blocked=True)
        self.assertEqual(calls,[]);self.assertEqual(result['status'],'blocked')
        calls,result,_=self.run_case(unknown=True)
        self.assertEqual(calls,[]);self.assertEqual(result['status'],'unavailable')
    def test_access_gate_sets_cooldown(self):
        raw,public=pair();outcome={};calls=[]
        def fetch(url):calls.append(url);return page(url,"Verify that you're not a robot")
        out=v21.process(raw,public,fetch,catalog=[],now=NOW,new_limit=0,background_limit=0,
            retry_limit=0,title_limit=0,verified={},v19_verified={},verified_titles={},verified_unavailable={},
            individual_request={'url':URL,'request_id':'fake'},individual_result=outcome)
        self.assertEqual(calls,[URL]);self.assertEqual(outcome['status'],'blocked')
        self.assertTrue(out[0]['collector_state']['v14']['blocked_until'])

class WorkerQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.req=Path(self.temp.name)/'request.json';self.res=Path(self.temp.name)/'result.json'
        self.task={'url':URL,'request_id':'00000000-0000-4000-8000-000000000002'}
        self.calls=[]
        def rpc(name,data):
            self.calls.append((name,data))
            return self.task if name in ('livepocket_individual_claim_v1','livepocket_individual_claim_one_v1') else True
        self.patches=[patch.object(individual,'REQUEST_PATH',self.req),patch.object(individual,'RESULT_PATH',self.res),patch.object(individual,'rpc',rpc)]
        for p in self.patches:p.start();self.addCleanup(p.stop)
    def test_prepare_known_event_then_finish_private_candidates(self):
        raw,public=pair()
        with patch.object(individual.v14,'read_pair',return_value=(raw,public)):
            individual.prepare()
        self.assertTrue(self.req.exists())
        self.res.write_text('{"request_id":"00000000-0000-4000-8000-000000000002","status":"success","fields":{"event_title":"確認名"},"message":"確認"}',encoding='utf-8')
        individual.complete()
        self.assertFalse(self.req.exists())
        self.assertEqual(self.calls[-1][1]['p_fields']['event_title'],'確認名')

    def test_finish_fills_missing_store_regions_by_exact_master_name(self):
        self.req.write_text(json.dumps(self.task), encoding='utf-8')
        stores = [
            {'name': 'フルコンプ秋葉原店', 'prefecture': ''},
            {'name': 'フルコンプ千葉店', 'prefecture': '千葉県'},
            {'name': '秋葉原店', 'prefecture': ''},
        ]
        self.res.write_text(json.dumps({**self.task, 'status': 'success',
                                        'fields': {'stores': stores}}), encoding='utf-8')
        regions = {'フルコンプ秋葉原店': '東京都', 'フルコンプ千葉店': '東京都'}
        with patch.object(individual.master, 'fetch_regions', return_value=regions) as lookup:
            individual.complete()
        lookup.assert_called_once()
        saved = self.calls[-1][1]['p_fields']['stores']
        self.assertEqual([store['prefecture'] for store in saved], ['東京都', '千葉県', ''])

    def test_prepare_unknown_event_never_enqueues_browser(self):
        raw,public=pair();public['items']=[]
        with patch.object(individual.v14,'read_pair',return_value=(raw,public)):
            individual.prepare()
        self.assertFalse(self.req.exists());self.assertEqual(self.calls[-1][1]['p_status'],'unavailable')
    def test_prepare_during_cooldown_returns_blocked(self):
        raw,public=pair();raw['collector_state']['v14']['blocked_until']='2099-01-01T00:00:00+00:00'
        with patch.object(individual.v14,'read_pair',return_value=(raw,public)):
            individual.prepare()
        self.assertFalse(self.req.exists());self.assertEqual(self.calls[-1][1]['p_status'],'blocked')
    def test_missing_result_finishes_as_error(self):
        self.req.write_text(json.dumps(self.task),encoding='utf-8')
        individual.complete();self.assertEqual(self.calls[-1][1]['p_status'],'error')
    def test_route_returns_only_the_one_marked_request(self):
        output=Path(self.temp.name)/'output'
        with patch.dict(os.environ,{'GITHUB_OUTPUT':str(output)}), patch.object(individual,'rpc',return_value={'request_id':self.task['request_id']}):
            individual.route()
        self.assertEqual(output.read_text(),f"mode=individual\nrequest_id={self.task['request_id']}\n")
    def test_route_without_marker_leaves_bulk_recheck_available(self):
        output=Path(self.temp.name)/'output'
        with patch.dict(os.environ,{'GITHUB_OUTPUT':str(output)}), patch.object(individual,'rpc',return_value=None):
            individual.route()
        self.assertEqual(output.read_text(),'mode=normal\n')
    def test_specific_claim_does_not_take_another_pending_event(self):
        raw,public=pair()
        with patch.object(individual.v14,'read_pair',return_value=(raw,public)):
            individual.prepare(self.task['request_id'])
        self.assertTrue(self.req.exists())
        self.assertEqual(self.calls[0],('livepocket_individual_claim_one_v1',{'p_id':self.task['request_id']}))
    def test_completed_claim_does_not_launch_browser(self):
        with patch.object(individual,'rpc',return_value=None):
            individual.prepare(self.task['request_id'])
        self.assertFalse(self.req.exists())
    def test_immediate_run_checks_only_registered_event(self):
        raw,public=pair();self.req.write_text(json.dumps(self.task),encoding='utf-8')
        calls=[];closed=[]
        with patch.object(individual.v14,'read_pair',return_value=(raw,public)), patch.object(v21,'browser_fetcher',return_value=(lambda url:(calls.append(url) or page(url)),lambda:closed.append(True))):
            individual.execute_direct()
        result=json.loads(self.res.read_text(encoding='utf-8'))
        self.assertEqual(calls,[URL]);self.assertEqual(closed,[True])
        self.assertEqual(result['status'],'success')
        self.assertEqual(result['fields']['event_title'],'ポケモンカード抽選販売')
        self.assertNotIn('event_title',public['items'][0])

    def test_existing_runner_claims_and_finishes_one_queued_followup(self):
        raw, public = pair()
        with patch.object(individual.v14, 'read_pair', return_value=(raw, public)), \
                patch.object(v21, 'browser_fetcher', return_value=(page, lambda: None)):
            individual.execute_next()
        self.assertEqual([name for name, _ in self.calls],
                         ['livepocket_individual_claim_v1', 'livepocket_individual_finish_v1'])
        self.assertEqual(self.calls[-1][1]['p_id'], self.task['request_id'])
        self.assertEqual(self.calls[-1][1]['p_status'], 'success')
        self.assertFalse(self.req.exists())

    def test_immediate_run_does_not_fetch_unknown_or_blocked_event(self):
        for reason in ('unknown','cooldown'):
            raw,public=pair()
            if reason=='unknown':public['items']=[]
            else:raw['collector_state']['v14']['blocked_until']='2099-01-01T00:00:00+00:00'
            self.req.write_text(json.dumps(self.task),encoding='utf-8')
            with patch.object(individual.v14,'read_pair',return_value=(raw,public)), patch.object(v21,'browser_fetcher') as fetcher:
                individual.execute_direct()
            fetcher.assert_not_called()
            self.assertEqual(json.loads(self.res.read_text())['status'],'unavailable' if reason=='unknown' else 'blocked')
    def test_immediate_access_gate_sets_cooldown(self):
        raw,public=pair();self.req.write_text(json.dumps(self.task),encoding='utf-8')
        with patch.object(individual.v14,'read_pair',return_value=(raw,public)), patch.object(v21,'browser_fetcher',return_value=(lambda url:page(url,"Verify that you're not a robot"),lambda:None)), patch.object(v21.v11,'write_json') as write:
            individual.execute_direct()
        result=json.loads(self.res.read_text())
        self.assertEqual(result['status'],'blocked');self.assertEqual(result['fields'],{})
        self.assertTrue(raw['collector_state']['v14']['blocked_until']);write.assert_called_once()

if __name__=='__main__':unittest.main()
