#!/usr/bin/env python3
"""Developer-requested single-event observation using the normal collector.

No alternate endpoint, access-control bypass, or raw page persistence. A page
already visited by the scheduled collector is reused during the same run.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import sys
from datetime import timedelta
import urllib.request
import urllib.error
import livepocket_master_prefecture as master
import livepocket_v14 as v14
import livepocket_v12 as v12

REQUEST_PATH = Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'toreca-livepocket-individual-request.json'
RESULT_PATH = Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'toreca-livepocket-individual-result.json'


def rpc(name, data):
    base=master.check_base(os.environ.get('SUPABASE_URL',''))
    key=os.environ.get('SUPABASE_SERVICE_ROLE_KEY','')
    headers=dict(master.headers_for(key), **{'Content-Type':'application/json'})
    request=urllib.request.Request(base+'/rest/v1/rpc/'+name,
        data=json.dumps(data).encode(),headers=headers,method='POST')
    return master.read_json(request)


def finish(item, status, fields, message):
    if not isinstance(item,dict) or not re.fullmatch(r'[0-9a-f-]{36}',str(item.get('request_id',''))):
        raise ValueError('Invalid individual request')
    ok=rpc('livepocket_individual_finish_v1',{'p_id':item['request_id'],
        'p_status':status,'p_fields':fields,'p_message':message})
    if ok is not True: raise RuntimeError('Individual result was not saved')


def extract(v21, url, page):
    """Produce review candidates only from a confirmed exact event page."""
    page=v21.normalize_verification_page(page)
    page=v21.normalize_event_title_observation(page,url)
    page=v21.quarantine_unconfirmed_event(page,url)
    status=page.get('status') if isinstance(page,dict) else 'browser_error'
    if status in ('browser_blocked','browser_blocked_or_empty'):
        return {'status':'blocked','fields':{},'message':'アクセス制限が表示されたため取得を停止しました。元ページをご確認ください。'}
    if status!='ok' or v12.exact_event_url(page.get('final_url'))!=url:
        return {'status':'unavailable','fields':{},'message':'対象ページを確認できませんでした。元ページをご確認ください。'}
    fields={}
    title,_=v21.verified_title(page,url)
    product,_=v21.verified_product(page,url)
    if title:fields['event_title']=title
    if product:fields['product_name']=product
    body=page.get('text') or ''
    start,end=v21.v14.v13.extract_deadline(body)
    if start:fields['application_start_at']=v21.v11.iso(start)
    if end:fields['application_end_at']=v21.v11.iso(end)
    stores=v21.v19.page_stores(body)
    if not stores:
        name,_=v21.v20.v15.explicit_store(body)
        store=v21.v19.store_part(name) or v21.v19.overview_store(page)
        if store:stores=[store]
    if stores:
        fields['stores']=[{'name':s['name'],'prefecture':s.get('prefecture','')} for s in stores[:35]]
    return {'status':'success','fields':fields,'message':(
        '取得した候補を確認してください。' if fields else '読み取れる項目が見つかりませんでした。元ページをご確認ください。')}


def output(**values):
    if os.getenv('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as out:
            for key,value in values.items():out.write(key+'='+str(value)+'\n')


def route():
    item=rpc('livepocket_individual_take_dispatch_v1',{})
    if item is None:
        output(mode='normal')
        print('Manual run: standard review')
        return
    request_id=str(item.get('request_id','')) if isinstance(item,dict) else ''
    if not re.fullmatch(r'[0-9a-f-]{36}',request_id):raise ValueError('Invalid route')
    output(mode='individual',request_id=request_id)
    print('Manual run: single-event review')


def prepare(specific_id=None):
    # Clear only our own run-scoped scratch files; never alter saved events.
    REQUEST_PATH.unlink(missing_ok=True);RESULT_PATH.unlink(missing_ok=True)
    if specific_id is not None:
        if not re.fullmatch(r'[0-9a-f-]{36}',str(specific_id)):
            raise ValueError('Invalid individual request')
        item=rpc('livepocket_individual_claim_one_v1',{'p_id':specific_id})
    else:
        item=rpc('livepocket_individual_claim_v1',{})
    needed=False
    if item:
        try:
            raw,public=v14.read_pair()
            url=item.get('url') if isinstance(item,dict) else None
            known={r.get('url') for r in raw.get('items',[]) if isinstance(r,dict)}
            published={r.get('url') for r in public.get('items',[]) if isinstance(r,dict)}
            if not isinstance(url,str) or v12.exact_event_url(url)!=url or url not in known or url not in published:
                finish(item,'unavailable',{},'登録済みの抽選が見つかりませんでした。')
            elif v14._cooldown_active(raw.get('collector_state',{}).get('v14',{}),v14._utc()):
                finish(item,'blocked',{},'アクセス制限中のため取得を停止しています。時間を置いて確認してください。')
            else:
                REQUEST_PATH.write_text(json.dumps(item,ensure_ascii=False),encoding='utf-8')
                needed=True
        except Exception:
            try:finish(item,'error',{},'自動取得の準備に失敗しました。後ほどお試しください。')
            except Exception:pass  # stale claims are made eligible again after 30 minutes
            raise
    output(requested=('true' if needed else 'false'))
    print('Individual recheck:', 'scheduled' if needed else 'none')


def execute_direct():
    """One exact URL, through the same normal browser and cooldown policy."""
    if not REQUEST_PATH.exists():return
    import livepocket_v21 as v21
    item=json.loads(REQUEST_PATH.read_text(encoding='utf-8'))
    url=item.get('url')
    result={'status':'error','fields':{},'message':'自動取得を完了できませんでした。後ほどお試しください。'}
    raw,public=v14.read_pair()
    known={x.get('url') for x in raw.get('items',[]) if isinstance(x,dict)}
    published={x.get('url') for x in public.get('items',[]) if isinstance(x,dict)}
    if not isinstance(url,str) or v12.exact_event_url(url)!=url or url not in known or url not in published:
        result={'status':'unavailable','fields':{},'message':'登録済みの抽選が見つかりませんでした。'}
    elif v14._cooldown_active(raw.get('collector_state',{}).get('v14',{}),v14._utc()):
        result={'status':'blocked','fields':{},'message':'アクセス制限中のため取得を停止しています。時間を置いて確認してください。'}
    else:
        try:
            fetch,close=v21.browser_fetcher()
            try:page=fetch(url)
            finally:close()
            result=extract(v21,url,page)
        except Exception:
            pass
        if result['status']=='blocked':
            raw.setdefault('collector_state',{}).setdefault('v14',{})['blocked_until']=(
                v14._utc()+timedelta(hours=v14.BLOCK_DELAY_HOURS)).isoformat()
            v21.v11.write_json(v14.RAW_PATH,raw)
    result['request_id']=item['request_id']
    RESULT_PATH.write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    print('Individual exact-event result:',result['status'])


def complete():
    if not REQUEST_PATH.exists():return
    item=json.loads(REQUEST_PATH.read_text(encoding='utf-8'))
    result={'status':'error','fields':{},'message':'自動取得を完了できませんでした。後ほどもう一度お試しください。'}
    if RESULT_PATH.exists():
        try:data=json.loads(RESULT_PATH.read_text(encoding='utf-8'))
        except (OSError,ValueError):data=None
        if isinstance(data,dict) and data.get('request_id')==item.get('request_id'):
            result=data
    fields = result.get('fields', {})
    stores = fields.get('stores', [])
    if any(not store.get('prefecture') for store in stores):
        try:
            regions = master.fetch_regions(os.getenv('SUPABASE_URL', ''),
                                           os.getenv('SUPABASE_SERVICE_ROLE_KEY', ''))
        except (OSError, RuntimeError, ValueError) as err:
            print('Store master lookup unavailable:', type(err).__name__)
        else:
            master.apply_one({'stores': stores}, {}, regions)
    finish(item,result['status'],fields,result.get('message',''))
    REQUEST_PATH.unlink(missing_ok=True);RESULT_PATH.unlink(missing_ok=True)
    print('Individual recheck result saved:',result['status'])


if __name__=='__main__':
    if len(sys.argv)!=2 or sys.argv[1] not in ('route','prepare','prepare-one','execute','complete'):
        raise SystemExit('Usage: livepocket_individual_fetch.py route|prepare|prepare-one|execute|complete')
    try:
        if sys.argv[1]=='prepare-one':prepare(os.environ.get('INDIVIDUAL_REQUEST_ID',''))
        else:{'route':route,'prepare':prepare,'execute':execute_direct,'complete':complete}[sys.argv[1]]()
    except Exception as err:
        # Do not print authorization headers, page content, or private responses.
        print('Individual recheck unavailable:',type(err).__name__,file=sys.stderr)
        sys.exit(1)
