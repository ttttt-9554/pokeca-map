import unittest
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
import guerrilla_sale_monitor as m

PC='https://www.pokemoncenter-online.com/4521329463261.html'
AM='https://www.amenitydream.com/product/273649'

def card(url,label='在庫数 3点',title='対象商品'):
    return '<li><a href="'+url+'">'+title+'</a><span>'+label+'</span></li>'

class MonitorTests(unittest.TestCase):
    def test_pokemon_probe_url_exact_allowlist_and_user_agent(self):
        url=('https://www.pokemoncenter-online.com/pokemon-card-game/'
             'booster-packs/?inStock=1&srule=top-new-product')
        self.assertTrue(m.allowed_read(url,'pokemon'))
        self.assertFalse(m.allowed_read(url+'&extra=1','pokemon'))
        self.assertFalse(m.allowed_read(url.replace('/booster-packs/','/admin/'),'pokemon'))
        self.assertFalse(m.allowed_read(url,'amenity'))
        bot=m.StoreClient(user_agent='TorecaRadarFastMonitor/1.0',
                          accept='text/html')
        self.assertEqual(bot.user_agent,'TorecaRadarFastMonitor/1.0')
        self.assertEqual(bot.accept,'text/html')

    def test_queue_diagnostic_does_not_log_sensitive_redirect_or_cookie(self):
        from email.message import Message
        from urllib.error import HTTPError
        url=('https://www.pokemoncenter-online.com/pokemon-card-game/'
             'booster-packs/?inStock=1&srule=top-new-product')
        headers=Message()
        headers.add_header('Location','https://wr.pokemoncenter-online.com/?token=DO_NOT_LOG')
        headers.add_header('Set-Cookie','sensitive=DO_NOT_LOG; Path=/; Secure')
        client=m.StoreClient(user_agent='TorecaRadarFastMonitor/1.0',
                             accept='text/html')
        with patch.object(m.socket,'getaddrinfo',return_value=[
                (None,None,None,'',('8.8.8.8',443))]), \
             patch.object(client.opener,'open',side_effect=HTTPError(
                url,302,'Found',headers,None)) as opening:
            with self.assertRaisesRegex(m.CheckError,'waiting'):
                client.raw(url,'pokemon')
            request=opening.call_args.args[0]
            self.assertEqual(request.get_header('User-agent'),
                             'TorecaRadarFastMonitor/1.0')
            self.assertEqual(request.get_header('Accept'),'text/html')
        self.assertEqual(client.last_http['http_status'],302)
        self.assertEqual(client.last_http['redirect_to'],'official_waiting_room')
        self.assertEqual(client.last_http['cookie_headers'],1)
        self.assertFalse(client.last_http['cookie_sent'])
        self.assertNotIn('DO_NOT_LOG',str(client.last_http))

    def test_canonical_product_identity(self):
        self.assertEqual(m.product_url(PC+'?utm_source=x#top','pokemon'),PC)
        self.assertEqual(m.product_id('pokemon',PC),m.product_id('pokemon',m.product_url(PC+'?ref=x','pokemon')))
        self.assertEqual(m.product_url(AM,'amenity'),AM)
    def test_reject_arbitrary_or_credential_urls(self):
        for u in ['http://www.amenitydream.com/product/1','https://localhost/product/1','https://127.0.0.1/product/1','https://www.amenitydream.com.evil.com/product/1','https://x@www.amenitydream.com/product/1','https://www.amenitydream.com:444/product/1']:
            self.assertEqual(m.product_url(u,'amenity'),'')
    def test_reject_wrong_store_home_cart_and_variants(self):
        self.assertEqual(m.product_url(PC,'amenity'),'')
        self.assertEqual(m.product_url('https://www.amenitydream.com/','amenity'),'')
        self.assertFalse(m.allowed_read('https://www.amenitydream.com/cart','amenity'))
        self.assertEqual(m.product_url(PC+'?dwvar_4521329463261_color=red','pokemon'),'')
    def test_stock_scoped_to_each_catalog_product(self):
        html='<main><p>100件</p><ul>'+card(AM)+card('https://www.amenitydream.com/product/2','在庫なし')+'</ul><a href="?page=2">次»</a></main>'
        rows,total,links=m.parse_catalog(html,'amenity',m.catalog_url('amenity'))
        self.assertEqual([r['status'] for r in rows],['available','unavailable'])
        self.assertEqual(total,100)
        self.assertEqual(links,['https://www.amenitydream.com/product-list?page=2'])
    def test_no_stock_does_not_mean_sold_out(self):
        rows,_,_=m.parse_catalog(card(PC,'再入荷'),'pokemon',m.catalog_url('pokemon'))
        self.assertEqual(rows[0]['status'],'unobserved')
    def test_empty_or_changed_catalog_is_error(self):
        with self.assertRaisesRegex(m.CheckError,'catalog_markup_unverified'):
            m.parse_catalog('<main>メンテナンス中</main>','pokemon',m.catalog_url('pokemon'))
    def test_detail_stock_and_baseline(self):
        html='<article><h1>商品</h1><span>在庫数 2点</span></article>'
        self.assertEqual(m.parse_detail(html,'amenity',AM)['status'],'available')
        self.assertEqual(m.parse_detail(html.replace('2点','0点'),'amenity',AM)['status'],'unavailable')
    def test_disabled_and_hidden_buttons_never_positive(self):
        for button in ['<button disabled>カートに入れる</button>','<button aria-disabled="true">カートに入れる</button>','<div hidden><button>カートに入れる</button></div>','<button class="d-none">カートに入れる</button>']:
            self.assertEqual(m.parse_detail('<article><h1>商品</h1>'+button+'</article>','pokemon',PC)['status'],'unknown')
    def test_unambiguous_enabled_button(self):
        self.assertEqual(m.parse_detail('<article><h1>商品</h1><button>カートに入れる</button></article>','pokemon',PC)['status'],'available')
    def test_conflicting_evidence_not_alert(self):
        html='<article><h1>商品</h1>在庫なし<button>カートに入れる</button></article>'
        self.assertEqual(m.parse_detail(html,'pokemon',PC)['status'],'unknown')
    def test_related_item_cannot_enable_target(self):
        html='<main><section><h1>対象商品</h1></section>'+card('https://www.amenitydream.com/product/2')+'</main>'
        self.assertEqual(m.parse_detail(html,'amenity',AM)['status'],'unknown')
    def test_queue_block_and_identity_mismatch(self):
        for title,code in [('仮想待合室','waiting'),('Access Denied','blocked')]:
            with self.assertRaisesRegex(m.CheckError,code):m.parse_detail('<title>'+title+'</title><h1>商品</h1>','pokemon',PC)
        with self.assertRaisesRegex(m.CheckError,'product_identity_mismatch'):
            m.parse_detail('<link rel="canonical" href="/product/2"><h1>商品</h1>','amenity',AM)
    def test_lottery_not_sale(self):
        self.assertEqual(m.parse_detail('<main><h1>商品</h1>抽選販売</main>','pokemon',PC)['status'],'lottery')
    def test_priority_rotation(self):
        targets=[{'id':str(i),'site_key':'amenity','mode':'selected','enabled':True,'url':'https://www.amenitydream.com/product/'+str(i),'product':'商品'} for i in range(10)]
        client=type('Client',(),{'halted':{},'get':lambda *x:'<main><h1>商品</h1>在庫数 2点</main>'})()
        with patch.object(m,'observe') as obs:
            a=m.sweep_site('amenity',targets,{},client)
            self.assertEqual(obs.call_count,8)
            self.assertEqual(a['selected_cursor'],8)
            obs.reset_mock();b=m.sweep_site('amenity',targets,a,client)
            self.assertEqual(b['selected_cursor'],6)
    def test_pokemon_retailer_terms_pause_even_if_target_enabled(self):
        client=type('Client',(),{'halted':{},'get':lambda *args:self.fail('Forbidden retailer request')})()
        targets=[{'site_key':'pokemon','mode':'all','enabled':True}]
        state=m.sweep_site('pokemon',targets,{},client)
        self.assertEqual(state['status'],'paused')
        self.assertFalse(state['catalog_enabled'])

    def test_disabled_never_fetches(self):
        client=type('Client',(),{'halted':{},'get':lambda *x:self.fail('network must not run')})()
        state=m.sweep_site('pokemon',[{'site_key':'pokemon','mode':'all','enabled':False}],{},client)
        self.assertEqual(state['status'],'paused')
    def test_front_page_baseline_then_new_products_are_eligible(self):
        html=card(AM)+'<p>50件</p>'
        client=type('Client',(),{'halted':{},'get':lambda *x:html})()
        targets=[{'site_key':'amenity','mode':'all','enabled':True}]
        with patch.object(m,'observe') as obs,patch.object(m,'db',return_value=[]):
            first=m.sweep_site('amenity',targets,{},client)
            self.assertTrue(first['front_baseline_ready'])
            self.assertFalse(obs.call_args_list[0].args[3])
            obs.reset_mock()
            second=m.sweep_site('amenity',targets,first,client)
            self.assertTrue(obs.call_args_list[0].args[3])

    def test_duplicate_page_does_not_finish_sweep(self):
        html=card(AM)+'<p>500件</p>'
        client=type('Client',(),{'halted':{},'get':lambda *x:html})()
        targets=[{'site_key':'amenity','mode':'all','enabled':True}]
        with patch.object(m,'observe'),patch.object(m,'db',return_value=[]):
            state=m.sweep_site('amenity',targets,{'next_page':2},client)
        self.assertIn('pagination_not_advancing',state['errors'])
        self.assertEqual(state['next_page'],2)
        self.assertNotIn('completed_cycles',state)
    def test_waiting_room_redirect_and_503_are_fail_closed(self):
        waiting='https://wr.pokemoncenter-online.com/?c=pol&t=https%3A%2F%2Fwww.pokemoncenter-online.com%2Fsearch%2F'
        self.assertEqual(m.redirect_reason(waiting,'pokemon'),'waiting')
        self.assertEqual(m.redirect_reason('https://example.com/login','pokemon'),'redirect_blocked')
        client=m.StoreClient()
        client.robots['amenity']=(type('Robots',(),{'can_fetch':lambda *a:True})(),'User-agent: *\\nAllow: /')
        with patch.object(client,'raw',side_effect=m.CheckError('http_503')):
            with self.assertRaisesRegex(m.CheckError,'http_503'):
                client.get(m.catalog_url('amenity'),'amenity')
        self.assertEqual(client.halted.get('amenity'),'http_503')

    def test_notification_filter_only_sealed_pack_or_deck(self):
        self.assertEqual(m.notification_product_kind('【ポケモンカードゲーム】拡張パック テスト BOX 在庫数 12点'),'pack')
        self.assertEqual(m.notification_product_kind('【ONE PIECEカードゲーム】ブースターパック 新時代 BOX'),'pack')
        self.assertEqual(m.notification_product_kind('【ガンダムカードゲーム】スタートデッキ ST01'),'deck')
        self.assertEqual(m.notification_product_kind('【遊戯王OCG】デュエルモンスターズ BOX'),'pack')
        self.assertEqual(m.notification_product_kind('【R】熱気 バサラ [ UNA_スタートデッキ ] 380円 在庫数 3枚'),'')
        self.assertEqual(m.notification_product_kind('【アルティメットガード社製：デッキケース】Deck Case 100+'),'')
        self.assertEqual(m.notification_product_kind('(予約)【UNION ARENA】ブースターパック BOX'),'')
        self.assertEqual(m.notification_product_kind('勝利の女神 14枚セット ブースターパック関連'),'')
        self.assertEqual(m.notification_product_kind('【プラコロ】たんけんボックス 01 BOX'),'')

    def test_sealed_classification_handles_real_spelling_and_excludes_single_units(self):
        for title in (
            'ONE PIECE ブースターパック BOX 在庫数 5点',
            'UNION ARENA ブースターパック BOX',
            'MTG コレクターブースターBOX',
            'デュエル マスターズ ボックス',
        ):
            with self.subTest(title=title):
                self.assertEqual(m.notification_product_kind(title,'amenity'),'pack')
        self.assertEqual(m.notification_product_kind('ポケカ スターターセット','amenity'),'deck')
        for title in (
            '(予約) ポケカ 拡張パック BOX',
            'ポケカ 14枚セット 拡張パック BOX',
            'ワンピースカードゲーム ブースターパック BOX 在庫数：1,200枚',
        ):
            with self.subTest(title=title):
                self.assertEqual(m.notification_product_kind(title,'amenity'),'')

    def test_stock_unit_outside_product_link_prevents_single_card_notification(self):
        title='ONE PIECE ブースターパック BOX'
        html=card(AM,'在庫数 3枚',title)
        rows,_,_=m.parse_catalog(html,'amenity',m.catalog_url('amenity'))
        self.assertTrue(rows[0]['single_item'])
        with patch.object(m,'db') as database:
            m.observe('amenity',rows,'all',True)
            posted=database.call_args.args[2]['p_rows'][0]
            self.assertFalse(posted['notification_eligible'])
            self.assertFalse(posted['notify_new'])
        detail=m.parse_detail('<article><h1>'+title+'</h1>在庫数 3枚</article>','amenity',AM)
        self.assertTrue(detail['single_item'])

    def test_bounded_detail_checks_prioritize_eligible_products(self):
        candidates=[
            {'url':'https://www.amenitydream.com/product/1','product':'ポケカ 5枚セット 拡張パック'},
            {'url':'https://www.amenitydream.com/product/2','product':'ONE PIECE ブースターパック BOX'},
            {'url':'https://www.amenitydream.com/product/3','product':'ポケカ スターターセット'},
        ]
        with patch.object(m,'db',return_value=candidates) as database:
            state={}
            selected=m.due_detail_rows('amenity',{'https://www.amenitydream.com/product/3'},state)
        self.assertEqual([r['url'] for r in selected],['https://www.amenitydream.com/product/2'])
        query=parse_qs(urlsplit(database.call_args.args[0]).query)
        self.assertEqual(query['site_key'],['eq.amenity'])
        self.assertEqual(query['limit'],[str(m.DETAIL_CANDIDATE_BATCH)])
        self.assertIn('product.ilike.*BOX*',query['or'][0])

    def test_detail_candidate_search_moves_past_old_single_cards(self):
        singles=[{'url':f'https://www.amenitydream.com/product/{i}',
                  'product':'ポケカ 10枚セット 拡張パック'} for i in range(m.DETAIL_CANDIDATE_BATCH)]
        sealed={'url':'https://www.amenitydream.com/product/999',
                'product':'ポケカ 拡張パック BOX'}
        state={}
        with patch.object(m,'db',side_effect=[singles,[sealed]]) as database:
            self.assertEqual(m.due_detail_rows('amenity',set(),state),[])
            self.assertEqual(state['detail_search_offset'],m.DETAIL_CANDIDATE_BATCH)
            self.assertEqual(m.due_detail_rows('amenity',set(),state),[sealed])
            self.assertEqual(state['detail_search_offset'],0)
        self.assertEqual(parse_qs(urlsplit(database.call_args.args[0]).query)['offset'],
                         [str(m.DETAIL_CANDIDATE_BATCH)])

    def test_duplicate_sweep_guard_only_skips_a_recent_valid_snapshot(self):
        now=datetime(2026,11,3,0,0,tzinfo=timezone.utc)
        self.assertTrue(m.recent_snapshot((now-timedelta(seconds=60)).isoformat(),240,now))
        self.assertFalse(m.recent_snapshot((now-timedelta(seconds=241)).isoformat(),240,now))
        self.assertFalse(m.recent_snapshot((now+timedelta(seconds=60)).isoformat(),240,now))
        self.assertFalse(m.recent_snapshot('invalid',240,now))
        self.assertFalse(m.recent_snapshot(now.isoformat(),0,now))
    def test_pokemon_center_alerts_require_pokemon_card_context(self):
        self.assertEqual(m.notification_product_kind('ポケモンカードゲーム 拡張パック テスト BOX','pokemon'),'pack')
        self.assertEqual(m.notification_product_kind('ポケモンカードゲーム スターターデッキ テスト','pokemon'),'deck')
        self.assertEqual(m.notification_product_kind('ポケモンぬいぐるみ BOX','pokemon'),'')
        self.assertEqual(m.notification_product_kind('デッキケース ピカチュウ','pokemon'),'')
        self.assertEqual(m.notification_product_kind('ONE PIECEカードゲーム ブースターパック BOX','pokemon'),'')

    def test_observe_marks_nonsealed_as_notification_ineligible(self):
        with patch.object(m,'db') as database:
            m.observe('amenity',[{'url':AM,'product':'【SR】カード 1枚','status':'available'}],'all',True)
            row=database.call_args.args[2]['p_rows'][0]
            self.assertFalse(row['notification_eligible'])
            self.assertFalse(row['notify_new'])

    def test_atomic_rpc_has_canonical_id_and_both_scopes(self):
        with patch.object(m,'db') as database:
            row={'url':AM,'product':'test','status':'available'}
            m.observe('amenity',[row],'all')
            m.observe('amenity',[row],'selected')
            a=database.call_args_list[0].args[2]['p_rows'][0]
            b=database.call_args_list[1].args[2]['p_rows'][0]
            self.assertEqual(a['id'],b['id'])
            self.assertFalse(a['notify_new'])
            self.assertEqual(database.call_args_list[0].args[0],'rpc/guerrilla_sale_observe')

    def test_biccamera_product_url_and_catalog_allowlist(self):
        product='https://www.biccamera.com/bc/item/15607965/'
        self.assertEqual(m.product_url(product+'?utm_source=toreca#details','biccamera'),product)
        self.assertEqual(m.product_url(product.rstrip('/'),'biccamera'),product)
        for u in ('http://www.biccamera.com/bc/item/15607965/',
                  'https://www.biccamera.com.evil.com/bc/item/15607965/',
                  'https://www.biccamera.com/bc/item/15607965/?variation=2',
                  'https://www.biccamera.com/bc/cart/',
                  'https://www.biccamera.com/bc/item/abc/'):
            self.assertEqual(m.product_url(u,'biccamera'),'')
        self.assertEqual(m.catalog_url('biccamera'),
                         'https://www.biccamera.com/bc/category/001/220/070/')
        with self.assertRaisesRegex(m.CheckError,'pagination_unverified'):
            m.catalog_url('biccamera',2)
        self.assertFalse(m.allowed_read('https://www.biccamera.com/bc/category/001/220/070/?q=pokemon','biccamera'))
        self.assertTrue(m.allowed_read(product,'biccamera'))

    def test_yodobashi_urls_are_fixed_and_monitor_stays_paused(self):
        url='https://www.yodobashi.com/product/100000001009191424/'
        self.assertEqual(m.product_url(url+'?utm_source=app','yodobashi'),url)
        self.assertEqual(m.product_url(url.rstrip('/'),'yodobashi'),url)
        for bad in (url+'?variant=2',
                    'http://www.yodobashi.com/product/100000001009191424/',
                    'https://www.yodobashi.com.evil.com/product/100000001009191424/',
                    'https://www.yodobashi.com/cart/'):
            self.assertEqual(m.product_url(bad,'yodobashi'),'')
        self.assertFalse(m.allowed_read(m.catalog_url('yodobashi')+'?anything=1','yodobashi'))
        with self.assertRaisesRegex(m.CheckError,'pagination_unverified'):
            m.catalog_url('yodobashi',2)
        client=type('Client',(),{'halted':{},'get':lambda *a:self.fail('unexpected request')})()
        state=m.sweep_site('yodobashi',[{'site_key':'yodobashi','mode':'all','enabled':True}],{},client)
        self.assertEqual(state['status'],'paused')
        self.assertFalse(state['catalog_enabled'])

    def test_yodobashi_probe_stops_after_a_block(self):
        import guerrilla_sale_probe as probe
        class Blocked:
            last_http={'http_status':403}
            def __init__(self):self.calls=[]
            def get(self,url,site):
                self.calls.append((url,site))
                raise m.CheckError('http_403')
        client=Blocked()
        result=probe.probe_yodobashi(client)
        self.assertEqual(result['status'],'blocked_or_unverified')
        self.assertEqual(result['reason'],'http_403')
        self.assertEqual(len(client.calls),1)

    def test_yodobashi_probe_is_diagnostic_only(self):
        import guerrilla_sale_probe as probe
        class Example:
            last_http={'http_status':200}
            def __init__(self):self.calls=[]
            def get(self,url,site):
                self.calls.append((url,site))
                if '/category/' in url:
                    return '<a href="/product/100000001009191424/">商品</a>'
                return '<h1>ポケカ 拡張パック</h1><p>販売休止中</p>'
        client=Example()
        result=probe.probe_yodobashi(client)
        self.assertEqual(result['status'],'diagnostic_only')
        self.assertTrue(result['soldout_label'])
        self.assertFalse(result['monitor_enabled'])
        self.assertEqual(len(client.calls),2)

    def test_yodobashi_missing_robots_is_not_an_access_block(self):
        client=m.StoreClient()
        def raw(url,site):
            if url.endswith('/robots.txt'):
                client.last_http={'http_status':404}
                raise m.CheckError('http_404')
            return '<h1>sample</h1>'
        with patch.object(client,'raw',side_effect=raw) as read:
            self.assertEqual(client.get(m.catalog_url('yodobashi'),'yodobashi'),'<h1>sample</h1>')
        self.assertEqual(client.robots_status['yodobashi'],404)
        self.assertEqual(read.call_count,2)

    def test_biccamera_unavailable_cart_template_is_not_sale(self):
        url='https://www.biccamera.com/bc/item/15607965/'
        base='<main><h1>【BOX】ポケモンカードゲーム MEGA 拡張パック</h1><p>商品コード 15607965</p>'
        for note in ('予約受付を終了しました','販売休止中です',
                     '予定数の販売を終了しました','この商品はご購入できません',
                     '在庫なし'):
            html=base+'<div>'+note+'</div><button>カートに入れる</button></main>'
            self.assertEqual(m.parse_detail(html,'biccamera',url)['status'],'unavailable',note)
        self.assertEqual(m.parse_detail(base+'抽選販売中<button>カートに入れる</button></main>',
                                        'biccamera',url)['status'],'lottery')

    def test_biccamera_positive_requires_stock_and_active_button(self):
        url='https://www.biccamera.com/bc/item/15607965/'
        base='<main><h1>【BOX】ポケモンカードゲーム</h1><p>商品コード: 15607965</p>'
        for html in (
            base+'<button>カートに入れる</button></main>',
            base+'在庫あり<button disabled>カートに入れる</button></main>',
            base+'在庫あり<div hidden><button>カートに入れる</button></div></main>',
            '<main><h1>ポケモンカード</h1>在庫あり<button>カートに入れる</button></main>',
            base+'予約受付中 在庫あり<button>カートに入れる</button></main>',
        ):
            self.assertNotEqual(m.parse_detail(html,'biccamera',url)['status'],'available')
        yes=base+'在庫あり<button>カートに入れる</button></main>'
        self.assertEqual(m.parse_detail(yes,'biccamera',url)['status'],'available')
        with self.assertRaisesRegex(m.CheckError,'product_identity_mismatch'):
            m.parse_detail(yes.replace('15607965</p>','15607966</p>'),'biccamera',url)

    def test_biccamera_catalog_only_discovers_and_never_assumes_stock(self):
        url='https://www.biccamera.com/bc/item/15607965/'
        html='<main><article><a href="/bc/item/15607965/">【BOX】ポケモンカードゲーム</a><button>カートに入れる</button></article></main>'
        rows,total,_=m.parse_catalog(html,'biccamera',m.catalog_url('biccamera'))
        self.assertEqual(rows[0]['url'],url)
        self.assertEqual(rows[0]['status'],'unobserved')
        self.assertEqual(total,0)

    def test_biccamera_site_scope_and_no_requests_when_disabled(self):
        bad=type('Client',(),{'halted':{},'get':lambda *args:self.fail('network must remain off')})()
        state=m.sweep_site('biccamera',[{'site_key':'biccamera','mode':'all','enabled':False}],{},bad)
        self.assertEqual(state['status'],'paused')
        self.assertFalse(state['catalog_enabled'])
        client=m.StoreClient()
        client.robots['biccamera']=(type('Robots',(),{'can_fetch':lambda *a:False})(),
                                   'User-agent: *\\nDisallow: /bc/')
        with patch.object(client,'raw',side_effect=AssertionError('must not fetch disallowed page')):
            with self.assertRaisesRegex(m.CheckError,'robots_denied'):
                client.get('https://www.biccamera.com/bc/item/15607965/','biccamera')

    def test_biccamera_filters_cannot_fake_stock_or_sale(self):
        url='https://www.biccamera.com/bc/item/15607965/'
        base='<main><h1>ポケモンカードゲーム 拡張パック BOX</h1><p>商品コード: 15607965</p>'
        controls='<button>カートに入れる</button></main>'
        # An "in stock only" filter is not the product's stock.
        self.assertEqual(m.parse_detail(base+'在庫あり商品のみ'+controls,'biccamera',url)['status'],'unknown')
        # "Include ended sales" is an ordinary sidebar filter, not a stockout.
        self.assertEqual(m.parse_detail(
            base+'販売終了商品を含める 在庫あり'+controls,'biccamera',url)['status'],'available')
        # Launch dates on a past release remain visible even during a restock.
        self.assertEqual(m.parse_detail(
            base+'メーカー発売予定日：2026年9月 在庫あり'+controls,
            'biccamera',url)['status'],'available')
        # Reservation status is not an immediately purchasable item.
        self.assertNotEqual(m.parse_detail(
            base+'予約受付中 在庫あり'+controls,'biccamera',url)['status'],'available')
        self.assertEqual(m.parse_detail(
            base+'予約受付は終了しました 在庫あり'+controls,
            'biccamera',url)['status'],'unavailable')

    def test_biccamera_robots_diagnostic_is_single_non_product_read(self):
        import guerrilla_sale_probe as probe
        class FakeClient:
            user_agent=m.UA
            last_http={'http_status':200}
            def __init__(self,body=None,issue=None):
                self.body=body;self.issue=issue;self.calls=[]
            def raw(self,url,site):
                self.calls.append((url,site))
                if self.issue:raise m.CheckError(self.issue)
                return self.body
        allowed=FakeClient('User-agent: *\nDisallow: /bc/cart/\n')
        answer=probe.probe_biccamera_robots(allowed)
        self.assertEqual(answer['status'],'robots_read')
        self.assertTrue(answer['category_allowed_by_robots'])
        self.assertTrue(answer['item_allowed_by_robots'])
        self.assertFalse(answer['monitor_enabled'])
        self.assertEqual(allowed.calls,[('https://www.biccamera.com/robots.txt','biccamera')])

        restricted=FakeClient('User-agent: *\nDisallow: /bc/item/\n')
        answer=probe.probe_biccamera_robots(restricted)
        self.assertTrue(answer['category_allowed_by_robots'])
        self.assertFalse(answer['item_allowed_by_robots'])
        self.assertEqual(len(restricted.calls),1)

        unavailable=FakeClient(issue='http_403')
        answer=probe.probe_biccamera_robots(unavailable)
        self.assertEqual(answer['status'],'unverified')
        self.assertEqual(answer['reason'],'http_403')
        self.assertFalse(answer['monitor_enabled'])
        self.assertEqual(len(unavailable.calls),1)

    def test_biccamera_only_sealed_tcg_alerts(self):
        self.assertEqual(m.notification_product_kind('ポケモンカードゲーム 拡張パック BOX','biccamera'),'pack')
        self.assertEqual(m.notification_product_kind('遊戯王OCG スターターデッキ','biccamera'),'deck')
        for title in (
            'ポケモンカードゲーム デッキシールド スリーブ BOX',
            '遊戯王OCG デッキケース BOX',
            'ポケモンカードゲーム シングルカード SR 拡張パック',
            'カメラアクセサリー ボックス',
        ):
            self.assertEqual(m.notification_product_kind(title,'biccamera'),'')


    def test_biccamera_actual_style_soldout_variant_does_not_misreport(self):
        # Compact fixture modeled on publicly visible Bic Camera page labels.
        url='https://www.biccamera.com/bc/item/13536984/'
        html=('<main><h1>ポケモンカードゲーム スタートデッキGenerations</h1>'
              '<div>バリエーション 別商品 在庫あり 販売休止中です</div>'
              '<p>閉じる</p><strong>販売休止中です</strong>'
              '<p>お届け先を変更する</p><button>カートに入れる</button>'
              '<p>この商品は在庫がなくなりました。この商品はご購入できません。</p>'
              '<p>商品について</p><p>商品コード 13536984</p>'
              '<div>選択いただいた商品の在庫がありません</div></main>')
        self.assertEqual(m.parse_detail(html,'biccamera',url)['status'],'unavailable')

    def test_biccamera_actual_style_shipping_without_instock_word(self):
        url='https://www.biccamera.com/bc/item/14656332/'
        html=('<main><h1>遊戯王OCG DUELIST BOX</h1>'
              '<div>バリエーション 別商品 販売休止中です</div>'
              '<p>閉じる</p>'
              '<p>送料無料、あと18時間21分以内のご注文で '
              '8月12日（水）お届け</p>'
              '<p>お届け先を変更する</p><label>数量</label>'
              '<button>カートに入れる</button>'
              '<p>商品について</p><p>商品コード 14656332</p>'
              '<aside>選択いただいた商品の在庫がありません</aside></main>')
        self.assertEqual(m.parse_detail(html,'biccamera',url)['status'],'available')
        no_quantity=html.replace('<label>数量</label>','')
        self.assertEqual(m.parse_detail(no_quantity,'biccamera',url)['status'],'available')
        no_checkout=html.replace('ご注文で','')
        no_checkout=no_checkout.replace('<label>数量</label>','')
        self.assertEqual(m.parse_detail(no_checkout,'biccamera',url)['status'],'unknown')
        disabled=html.replace('<button>','<button disabled>')
        self.assertEqual(m.parse_detail(disabled,'biccamera',url)['status'],'unknown')

    def test_biccamera_related_product_code_cannot_confirm_identity(self):
        url='https://www.biccamera.com/bc/item/14656332/'
        html=('<main><h1>遊戯王OCG BOX</h1>在庫あり'
              '<button>カートに入れる</button>'
              '<p>商品コード 14656332</p>'
              '<div>関連商品 商品コード 13536984</div></main>')
        got=m.parse_detail(html,'biccamera',url)
        self.assertEqual(got['status'],'unknown')
        self.assertEqual(got['reason'],'multiple_product_identifiers')


    def test_biccamera_live_smoke_is_read_only_bounded_and_fail_closed(self):
        import guerrilla_sale_probe as probe

        class FakeClient:
            halted={}
            last_http={'http_status':200}
            def __init__(self,blocked=False):
                self.blocked=blocked
                self.calls=[]
                self.halted={}
            def get(self,url,site):
                self.calls.append((url,site))
                if self.blocked:
                    self.halted[site]='robots_denied'
                    raise m.CheckError('robots_denied')
                item_id=url.split('/bc/item/')[1].strip('/')
                return ('<main><h1>遊戯王OCG BOX</h1>'
                        '<p>商品コード '+item_id+'</p>'
                        '<p>在庫あり</p><button>カートに入れる</button></main>')

        client=FakeClient()
        result=probe.probe_biccamera_sample_pages(client)
        self.assertFalse(result['monitor_enabled'])
        self.assertEqual(result['requests_max'],2)
        self.assertEqual(len(client.calls),2)
        self.assertTrue(all(site=='biccamera' for _,site in client.calls))
        self.assertEqual([row['status'] for row in result['observations']],
                         ['available','available'])
        self.assertTrue(all(row['sealed_tcg'] for row in result['observations']))
        for row in result['observations']:
            self.assertNotIn('product',row)
            self.assertNotIn('html',row)
            self.assertNotIn('url',row)

        blocked=FakeClient(blocked=True)
        result=probe.probe_biccamera_sample_pages(blocked)
        self.assertEqual(len(blocked.calls),1)
        self.assertEqual(result['observations'][0]['reason'],'robots_denied')
        self.assertFalse(result['monitor_enabled'])


    def test_biccamera_http403_pause_ignores_even_enabled_legacy_targets(self):
        client=type('Client',(),{
            'halted':{},'get':lambda *args:self.fail('Bic Camera must not be queried')
        })()
        rows=[
            {'site_key':'biccamera','mode':'all','enabled':True,'id':'all'},
            {'site_key':'biccamera','mode':'selected','enabled':True,
             'id':'selected','url':'https://www.biccamera.com/bc/item/13536984/'}
        ]
        state=m.sweep_site('biccamera',rows,{'status':'ok'},client)
        self.assertEqual(state['status'],'paused')
        self.assertFalse(state['catalog_enabled'])
        self.assertEqual(state['selected_count'],0)
        self.assertEqual(state['reason'],'official_product_http_403_manual_review_required')

    def test_biccamera_sample_pages_require_explicit_opt_in(self):
        import guerrilla_sale_probe as probe
        import os, io, contextlib, json
        with patch.dict(os.environ,{'BICCAMERA_SAMPLE_READS':'false','YODOBASHI_SAMPLE_READS':'false'}), \
             patch.object(probe,'probe',return_value={'site':'amenity','status':'ok'}), \
             patch.object(probe,'probe_biccamera_robots',return_value={'site':'biccamera','status':'robots_read'}), \
             patch.object(probe,'probe_yodobashi',side_effect=AssertionError('unexpected Yodobashi request')), \
             patch.object(probe,'probe_biccamera_sample_pages',
                          side_effect=AssertionError('unexpected item request')):
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                self.assertEqual(probe.main(),0)
        encoded=buf.getvalue().split('GUERRILLA_SALE_PROBE_BEGIN')[1].split('GUERRILLA_SALE_PROBE_END')[0]
        results=json.loads(encoded)
        self.assertEqual(results[-2]['reason'],'robots_unverified_no_automatic_retry')
        self.assertEqual(results[-1]['reason'],'product_http_403_no_automatic_retry')
        self.assertFalse(results[-1]['monitor_enabled'])

if __name__=='__main__':unittest.main()
