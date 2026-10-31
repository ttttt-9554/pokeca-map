import unittest
from unittest.mock import patch
import guerrilla_sale_monitor as m

PC='https://www.pokemoncenter-online.com/4521329463261.html'
AM='https://www.amenitydream.com/product/273649'

def card(url,label='在庫数 3点',title='対象商品'):
    return '<li><a href="'+url+'">'+title+'</a><span>'+label+'</span></li>'

class MonitorTests(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
