#!/usr/bin/env python3
"""Developer-only beta: catalog sweeps + priority product checks.

Public pages only. No authentication, checkout, CAPTCHA or queue bypass.
Private observations/events are persisted in Supabase; no public feed/webhook.
"""
from __future__ import annotations
import hashlib
import ipaddress
import json
import os
import re
import socket
import sys
import time
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit, urlencode, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.robotparser import RobotFileParser

SITES = {
    'pokemon': {'host': 'www.pokemoncenter-online.com', 'name': 'ポケモンセンターオンライン', 'catalog': '/pokemon-card-game/'},
    'amenity': {'host': 'www.amenitydream.com', 'name': 'アメニティードリーム', 'catalog': '/product-list'},
}
UA = 'TorecaRadarSaleMonitor/2.0'
MAX_BYTES = 2_000_000
SELECTED_BATCH = 8
DETAIL_BATCH = 4
KNOWN = ('available', 'unavailable')
VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}

class CheckError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

class Node:
    def __init__(self, tag='root', attrs=None, parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs or []), parent
        self.children = []
    def walk(self):
        yield self
        for n in self.children:
            if isinstance(n, Node):
                yield from n.walk()
    def hidden(self):
        n = self
        while n:
            a = n.attrs
            if ('hidden' in a or a.get('aria-hidden') == 'true' or
                re.search(r'(display\s*:\s*none|visibility\s*:\s*hidden)', a.get('style', ''), re.I) or
                set(a.get('class','').split()) & {'hidden','d-none','hide'}):
                return True
            n = n.parent
        return False
    def text(self, raw=False):
        if not raw and (self.tag in {'script','style','noscript','svg'} or self.hidden()):
            return ''
        return ' '.join(n.text(raw) if isinstance(n,Node) else n for n in self.children)

class Document(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)
    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(n)
        if tag not in VOID:
            self.stack.append(n)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag,attrs)
        if tag not in VOID:
            self.handle_endtag(tag)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break
    def handle_data(self,data):
        self.stack[-1].children.append(data)

def tidy(text):
    return re.sub(r'\s+',' ',text).strip()

def valid_host(url, site):
    try:
        u = urlsplit(url)
        return (site in SITES and u.scheme == 'https' and u.hostname == SITES[site]['host']
                and u.port in (None,443) and not u.username and not u.password
                and not re.search(r'[\\\s\x00-\x1f]',url))
    except (ValueError,TypeError):
        return False

def product_url(url, site):
    if not valid_host(url,site):
        return ''
    u = urlsplit(url)
    pattern = r'/[0-9]{6,20}(?:-[A-Za-z0-9_-]+)?\.html' if site == 'pokemon' else r'/product/[0-9]+'
    if not re.fullmatch(pattern,u.path.rstrip('/')):
        return ''
    # Variant parameters can affect availability; do not silently monitor a different variant.
    if any(k.startswith('dwvar_') for k in parse_qs(u.query)):
        return ''
    return 'https://' + SITES[site]['host'] + u.path.rstrip('/')

def product_id(site,url):
    return hashlib.sha256((site+'|'+url).encode()).hexdigest()

def catalog_url(site, page=1):
    base = 'https://' + SITES[site]['host'] + SITES[site]['catalog']
    if page == 1:
        return base
    return base + '?' + urlencode({'start':(page-1)*40,'sz':40} if site=='pokemon' else {'page':page})

def allowed_read(url,site):
    if not valid_host(url,site):
        return False
    parts=urlsplit(url)
    # Diagnostic reads only: two exact official first-category pages, with
    # no arbitrary query parameters. All original monitor targets remain
    # unchanged. Respect robots.txt and never follow waiting-room redirects.
    if site=='pokemon' and parts.path in (
        '/pokemon-card-game/booster-packs/',
        '/pokemon-card-game/battle-decks/'
    ) and parts.query=='inStock=1&srule=top-new-product':
        return True
    return bool(product_url(url,site)) or parts.path in (SITES[site]['catalog'],'/robots.txt')

def product_links(node,site,base):
    result = {}
    for n in node.walk():
        if n.tag == 'a' and not n.hidden():
            url = product_url(urljoin(base,n.attrs.get('href','')),site)
            if url:
                title = tidy(n.text())
                images = [x.attrs.get('alt','') for x in n.walk() if x.tag == 'img']
                title = max([title]+images,key=len)
                if len(title)>len(result.get(url,'')):
                    result[url]=title
                else:
                    result.setdefault(url,title)
    return result

def page_guard(doc):
    title = ' '.join(n.text() for n in doc.root.walk() if n.tag == 'title').casefold()
    if any(s in title for s in ('仮想待合室','waiting room','queue-it')):
        raise CheckError('waiting')
    if any(s in title for s in ('access denied','just a moment','captcha','アクセス制限')):
        raise CheckError('blocked')

POKEMON_CARD_CONTEXT = re.compile(
    r'(?:ポケモンカードゲーム|ポケモンカード|ポケカ)',
    re.I,
)
CARD_CONTEXT = re.compile(
    r'(?:カードゲーム|TCG|OCG|ポケモンカード|ポケカ|ONE\\s*PIECE|ワンピース|'
    r'遊戯王|デュエル[・\\s-]*マスターズ|UNION\\s*ARENA|ユニオンアリーナ|'
    r'ガンダムカード|ヴァンガード|hololive\\s*OFFICIAL\\s*CARD\\s*GAME|'
    r'ホロライブ|Xross\\s*Stars|マジック[：:・\\s-]*ザ[・\\s-]*ギャザリング|'
    r'\\bMTG\\b|Flesh\\s*and\\s*Blood|Lycee|ヴァイスシュヴァルツ|Reバース|'
    r'ドラゴンボール|バトルスピリッツ|Disney\\s*Lorcana|ロルカナ)',
    re.I,
)
SEALED_PACK = re.compile(
    r'(?:強化拡張パック|拡張パック|ハイクラスパック|ブースターパック|エクストラブースター|'
    r'コレクターブースター|ブースターBOX|ブースターボックス|BOX|ボックス)',
    re.I,
)
SEALED_DECK = re.compile(
    r'(?:スターターデッキ|スタートデッキ|構築済みデッキ|構築デッキ|'
    r'スペシャルデッキセット|プレミアムデッキセット|アルティメットデッキ)',
    re.I,
)
SEALED_EXCLUDE = re.compile(
    r'(?:\\(予約\\)|（予約）|予約商品|予約受付|デッキケース|カードケース|スリーブ|'
    r'プレイマット|ストレージ|ローダー|サプライ|シングルカード|オリパ|福袋|'
    r'\\d+枚セット|枚セット\\b)',
    re.I,
)
SINGLE_RARITY = re.compile(
    r'^\\s*[（(]?[^】\\]]*[）)]?\\s*【(?:C|U|R|RR|RRR|SR|UR|HR|AR|SAR|SEC|PR|P|'
    r'☆パラレル|パラレル|ミラー)】',
    re.I,
)

def notification_product_kind(product, site=None):
    """Return pack/deck only for sealed TCG products worth alerting."""
    text=tidy(product or '')
    if not text or SEALED_EXCLUDE.search(text) or SINGLE_RARITY.search(text):
        return ''
    if site == 'pokemon':
        if not POKEMON_CARD_CONTEXT.search(text):
            return ''
    elif not CARD_CONTEXT.search(text):
        return ''
    # A per-card stock unit is strong evidence of a single, even when its
    # set/code happens to contain words like "スタートデッキ".
    if re.search(r'在庫数\\s*\\d+\\s*枚',text) and not SEALED_PACK.search(text):
        return ''
    if SEALED_PACK.search(text):
        return 'pack'
    if SEALED_DECK.search(text):
        return 'deck'
    return ''

def evidence(scope):
    text = tidy(scope.text()).casefold()
    if '抽選販売' in text or '抽選に応募' in text:
        return 'lottery'
    stock = [int(x.replace(',','')) for x in re.findall(r'在庫数\s*[:：]?\s*([\d,]+)\s*(?:点|個|枚|箱|パック|セット)',text)]
    negative = bool(stock and 0 in stock) or any(s in text for s in ('在庫なし','在庫切れ','品切れ','sold out','販売終了'))
    positive = any(x>0 for x in stock)
    for n in scope.walk():
        if n.tag not in ('button','input') or n.hidden():
            continue
        if 'disabled' in n.attrs or n.attrs.get('aria-disabled') == 'true' or 'disabled' in n.attrs.get('class','').split():
            continue
        label = tidy(n.text()+' '+n.attrs.get('value','')+' '+n.attrs.get('alt',''))
        if any(x in label for x in ('カートに入れる','カートへ入れる','予約する')):
            positive=True
    if positive and not negative:
        return 'available'
    if negative and not positive:
        return 'unavailable'
    return 'unknown'

def parse_catalog(html,site,url):
    doc=Document(html); page_guard(doc)
    links=product_links(doc.root,site,url)
    if not links:
        raise CheckError('catalog_markup_unverified')
    items={u:{'url':u,'product':name[:500],'status':'unobserved'} for u,name in links.items()}
    for a in doc.root.walk():
        if a.tag!='a':
            continue
        u=product_url(urljoin(url,a.attrs.get('href','')),site)
        if not u or u not in items:
            continue
        n=a
        for _ in range(7):
            if not n or n.tag in ('body','html','root'):
                break
            if set(product_links(n,site,url))-{u}:
                break
            state=evidence(n)
            if state!='unknown':
                previous=items[u]['status']
                items[u]['status']=state if previous in ('unobserved',state) else 'unknown'
                break
            n=n.parent
    text=tidy(doc.root.text())
    counts=[int(n.replace(',','')) for n in re.findall(r'([\d,]+)\s*件',text)]
    total=max(counts,default=0)
    next_links=[]
    for n in doc.root.walk():
        if n.tag=='a' and (n.attrs.get('rel')=='next' or re.match(r'^(?:次|next|もっと見る)',tidy(n.text()),re.I)):
            dest=urljoin(url,n.attrs.get('href',''))
            if valid_host(dest,site) and urlsplit(dest).path==SITES[site]['catalog']:
                next_links.append(dest)
    return list(items.values()),total,next_links

def parse_detail(html,site,url):
    doc=Document(html); page_guard(doc)
    h1=next((n for n in doc.root.walk() if n.tag=='h1' and not n.hidden()),None)
    if not h1:
        raise CheckError('product_markup_unverified')
    for n in doc.root.walk():
        if n.tag=='link' and n.attrs.get('rel')=='canonical':
            canonical=product_url(urljoin(url,n.attrs.get('href','')),site)
            if canonical and canonical!=url:
                raise CheckError('product_identity_mismatch')
    title=tidy(h1.text())[:500]
    n=h1.parent
    while n and n.tag not in ('root','html'):
        if set(product_links(n,site,url))-{url}:
            break
        state=evidence(n)
        if state!='unknown':
            return {'url':url,'product':title,'status':state}
        n=n.parent
    return {'url':url,'product':title,'status':'unknown','reason':'在庫表示を商品単位で確定できません'}

def redirect_reason(dest, site):
    """Classify a refused redirect without following it."""
    try:
        u = urlsplit(dest)
    except (ValueError, TypeError):
        return 'redirect_blocked'
    host = (u.hostname or '').lower()
    if site == 'pokemon' and host == 'wr.pokemoncenter-online.com':
        return 'waiting'
    if any(x in dest.lower() for x in ('queue', 'waiting', 'queue-it')):
        return 'waiting'
    return 'redirect_blocked'

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        return None

class StoreClient:
    def __init__(self,user_agent=UA,accept='text/html,text/plain'):
        self.opener=build_opener(NoRedirect())
        self.robots={};self.last={};self.delays={};self.halted={}
        self.user_agent=user_agent
        self.accept=accept
        self.last_http={}
        self.deadline=time.monotonic()+300
    def raw(self,url,site):
        if not allowed_read(url,site):
            raise CheckError('url_not_allowed')
        if time.monotonic()>self.deadline:
            raise CheckError('run_budget_exceeded')
        wait=self.delays.get(site,3)-(time.monotonic()-self.last.get(site,0))
        if wait>0:time.sleep(wait)
        host=SITES[site]['host']
        # Fixed allowlisted retailer host + reject non-public DNS destinations.
        try:
            ips=socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)
            if not ips or any(not ipaddress.ip_address(x[4][0]).is_global for x in ips):
                raise CheckError('unsafe_dns')
        except OSError:
            raise CheckError('dns_failed') from None
        self.last[site]=time.monotonic()
        try:
            with self.opener.open(Request(url,headers={'User-Agent':self.user_agent,'Accept':self.accept}),timeout=12) as res:
                self.last_http={'http_status':res.status,'redirect_to':'none',
                    'cookie_headers':min(len(res.headers.get_all('Set-Cookie',[])),20),
                    'cookie_sent':False}
                if not allowed_read(res.geturl(),site):raise CheckError('redirect_blocked')
                data=res.read(MAX_BYTES+1)
                if len(data)>MAX_BYTES:raise CheckError('response_too_large')
                return data.decode(res.headers.get_content_charset() or 'utf-8',errors='replace')
        except HTTPError as e:
            dest=urljoin(url,e.headers.get('Location','')) if 300<=e.code<400 else ''
            reason=redirect_reason(dest,site) if dest else ''
            self.last_http={
                'http_status':e.code,
                'redirect_to':'official_waiting_room' if reason=='waiting' else
                  'other_redirect' if 300<=e.code<400 else 'none',
                'cookie_headers':min(len(e.headers.get_all('Set-Cookie',[])),20),
                'cookie_sent':False
            }
            if 300<=e.code<400:
                # Never follow the queue. Do not log redirect URLs or
                # received cookie contents; these can contain session tokens.
                raise CheckError(reason) from None
            raise CheckError('http_'+str(e.code)) from None
        except (OSError,TimeoutError):
            raise CheckError('network_error') from None
    def get(self,url,site):
        if site in self.halted:raise CheckError(self.halted[site])
        try:
            if site not in self.robots:
                try:
                    text=self.raw('https://'+SITES[site]['host']+'/robots.txt',site)
                except CheckError as e:
                    if e.code=='http_404':text='User-agent: *\nAllow: /'
                    else:raise CheckError('robots_unavailable') from None
                if 'user-agent:' not in text.casefold():raise CheckError('robots_unverified')
                rp=RobotFileParser();rp.parse(text.splitlines())
                self.robots[site]=(rp,text)
                self.delays[site]=max(3,rp.crawl_delay(self.user_agent) or rp.crawl_delay('*') or 0)
            rp,text=self.robots[site]
            if not rp.can_fetch(self.user_agent,url):raise CheckError('robots_denied')
            # robotparser does not implement every wildcard dialect. Conservatively
            # honor wildcard disallows, even when written for a different crawler.
            path=urlsplit(url).path+('?' + urlsplit(url).query if urlsplit(url).query else '')
            for pattern in re.findall(r'^\s*Disallow:\s*(\S+)',text,re.I|re.M):
                if '*' in pattern:
                    rx='^'+re.escape(pattern.rstrip('$')).replace(r'\*','.*')+('$' if pattern.endswith('$') else '')
                    if re.search(rx,path):raise CheckError('robots_denied')
            return self.raw(url,site)
        except CheckError as e:
            if e.code in ('http_403','http_429','http_500','http_502','http_503','http_504',
                           'waiting','robots_denied','robots_unavailable','robots_unverified','redirect_blocked'):
                # Stop this site's remaining requests for the run. 5xx is
                # temporary service trouble, not a reason to keep probing.
                self.halted[site]=e.code
            raise

def db(path,method='GET',data=None):
    base=os.environ.get('SUPABASE_URL','https://aypcmtlaaygmiexboypk.supabase.co').rstrip('/')
    secret=os.environ.get('SUPABASE_SERVICE_ROLE_KEY','').strip()
    if base!='https://aypcmtlaaygmiexboypk.supabase.co' or not secret:
        raise CheckError('private_database_not_configured')
    headers={'apikey':secret,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'}
    if not secret.startswith('sb_secret_'):headers['Authorization']='Bearer '+secret
    request=Request(base+'/rest/v1/'+path,headers=headers,method=method,
                    data=json.dumps(data,ensure_ascii=False).encode() if data is not None else None)
    try:
        with build_opener(NoRedirect()).open(request,timeout=20) as res:
            raw=res.read(MAX_BYTES+1)
            if len(raw)>MAX_BYTES:raise CheckError('database_response_too_large')
            return json.loads(raw) if raw else None
    except HTTPError as e:
        raise CheckError('database_http_'+str(e.code)) from None

def all_targets():
    rows=[];offset=0
    while True:
        part=db('guerrilla_sale_monitor_targets?select=*&enabled=eq.true&order=id&limit=500&offset='+str(offset)) or []
        rows+=part
        if len(part)<500:return rows
        offset+=500

def observe(site,rows,scope,notify_new=False,cooldown=60):
    clean=[]
    for row in rows:
        url=product_url(row.get('url',''),site)
        if not url:continue
        product=row.get('product','')
        kind=notification_product_kind(product,site)
        clean.append({**row,'url':url,'id':product_id(site,url),'site_key':site,'scopes':[scope],
                      'notify_new':notify_new and bool(kind),
                      'notification_eligible':bool(kind),
                      'notification_kind':kind,
                      'cooldown_minutes':cooldown})
    for start in range(0,len(clean),100):
        db('rpc/guerrilla_sale_observe','POST',{'p_rows':clean[start:start+100]})

def iso():return datetime.now(timezone.utc).isoformat(timespec='seconds')

def sweep_site(site,targets,state,client):
    state=dict(state or {})
    active=[x for x in targets if x.get('site_key')==site and x.get('enabled') is True]
    if not active:return {**state,'status':'paused','selected_count':0,'catalog_enabled':False}
    until=state.get('retry_after')
    if until:
        try:
            if datetime.fromisoformat(until)>datetime.now(timezone.utc):return state
        except ValueError:pass
    state.update(status='checking',retry_after=None,selected_count=sum(x.get('mode')=='selected' for x in active),catalog_enabled=any(x.get('mode')=='all' for x in active))
    checked=set();errors=[];checked_count=0
    selected=sorted([x for x in active if x.get('mode')=='selected'],key=lambda x:x['id'])
    start=int(state.get('selected_cursor',0))%max(1,len(selected))
    ordered=(selected[start:]+selected[:start])[:SELECTED_BATCH]
    def detail(row,scope):
        nonlocal checked_count
        url=product_url(row.get('url',''),site)
        if not url:return
        if url in checked:return
        try:
            result=parse_detail(client.get(url,site),site,url)
        except CheckError as e:
            errors.append(e.code)
            result={'url':url,'product':row.get('product',''),'status':('waiting' if e.code=='waiting' else 'blocked' if e.code in ('http_403','http_429','robots_denied') else 'unknown'),'reason':e.code}
        observe(site,[result],scope,cooldown=row.get('cooldown_minutes',60))
        checked.add(url);checked_count+=1
    for row in ordered:detail(row,'selected')
    state['selected_cursor']=(start+len(ordered))%max(1,len(selected))
    if state['catalog_enabled'] and site not in client.halted:
        cursor=max(1,int(state.get('next_page',1)))
        for page in sorted({1,cursor}):
            if site in client.halted:break
            try:
                url=catalog_url(site,page)
                rows,total,links=parse_catalog(client.get(url,site),site,url)
                fingerprint=hashlib.sha256('|'.join(sorted(r['url'] for r in rows)).encode()).hexdigest()
                if page>1 and fingerprint==state.get('first_page_fingerprint'):
                    raise CheckError('pagination_not_advancing')
                if page==1:state['first_page_fingerprint']=fingerprint
                # Front-page baseline: the first successful page-1 read records
                # the current catalog without emitting a flood of "new product"
                # events. After that baseline, a genuinely new available product
                # appearing on page 1 is eligible for a developer-only event.
                front_ready=bool(state.get('front_baseline_ready'))
                notify_new = page == 1 and front_ready
                observe(site,[r for r in rows if r['url'] not in checked],'all',notify_new)
                if page == 1 and not front_ready:
                    state['front_baseline_ready']=True
                    state['front_baseline_at']=iso()
                state['catalog_total']=total or state.get('catalog_total',0)
                state['last_catalog_at']=iso()
                if page==cursor:
                    size=40 if site=='pokemon' else 50
                    next_exists=bool(links) or (total>page*size)
                    terminal=total>0 and page*size>=total
                    if next_exists:
                        state['next_page']=page+1
                    elif terminal:
                        state['next_page']=1
                        state['completed_cycles']=int(state.get('completed_cycles',0))+1
                        state['last_cycle_at']=iso()
                    else:
                        errors.append('pagination_unverified')
                    state['last_page']=page
            except CheckError as e:
                errors.append(e.code)
                break
        if site not in client.halted:
            due=db('guerrilla_sale_products?select=url,product&site_key=eq.'+site+'&order=checked_at.asc.nullsfirst,id&limit='+str(DETAIL_BATCH+SELECTED_BATCH)) or []
            for row in [r for r in due if r['url'] not in checked][:DETAIL_BATCH]:detail(row,'all')
    state.update(status='partial' if errors else 'ok',last_run_at=iso(),details_checked=checked_count,errors=list(dict.fromkeys(errors))[:8])
    if site in client.halted:
        state['status']='blocked'
        state['retry_after']=(datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat(timespec='seconds')
    return state

def main():
    targets=all_targets()
    stored=db('guerrilla_sale_monitor_snapshot?select=payload&id=eq.current&limit=1') or []
    old=stored[0].get('payload',{}) if stored else {}
    states=old.get('sites',{})
    client=StoreClient()
    for site in SITES:
        states[site]=sweep_site(site,targets,states.get(site,{}),client)
    payload={'schema_version':2,'visibility':'developer','notification_delivery':'developer_in_app_only','sites':states,'items':[],'events':[]}
    db('guerrilla_sale_monitor_snapshot?on_conflict=id','POST',[{'id':'current','payload':payload,'updated_at':iso()}])
    print('Developer-only sale monitor finished. Results stored privately.')

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('Sale monitor stopped: '+(e.code if isinstance(e,CheckError) else type(e).__name__),file=sys.stderr)
        sys.exit(1)
