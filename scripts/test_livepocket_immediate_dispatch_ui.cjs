'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8');
const start=app.indexOf('  async function lpDevFetchOne('),end=app.indexOf('\n  }\n',start);
assert(start>=0&&end>start);
const source=app.slice(start,end+4)+'\nlpDevFetchOne';
const url='https://livepocket.jp/e/test123',id='00000000-0000-4000-8000-000000000002';

function harness(options={}){
  const calls=[],request={request_id:id,status:options.status||'pending',fields:{}};
  const client={
    rpc:async(name,args)=>{
      calls.push({name,args});
      if(name==='livepocket_individual_request_v1')return {data:request,error:null};
      if(name==='livepocket_individual_mark_dispatch_v1')return {data:options.marked!==false,error:options.markError||null};
      throw Error('Unexpected RPC');
    },
    auth:{getSession:async()=>({data:{session:options.noSession?null:{access_token:'test-token',user:{id:options.user||'developer'}}},error:null})},
    functions:{invoke:async()=>({data:{external:true},error:null})}
  };
  const context={
    isDeveloper:()=>options.developer!==false,supabaseClient:client,lotteryBaseItems:[{url}],
    isLivePocketEventUrl:u=>u.startsWith('https://livepocket.jp/'),DEVELOPER_USER_ID:'developer',
    LP_DEV_RECHECK_API:'https://example.test/admin/recheck',AbortController,
    setTimeout,clearTimeout,console:{warn:()=>{}},
    fetch:async(endpoint,init)=>{
      calls.push({name:'fetch',endpoint,init});
      if(options.networkError)throw Error('Network unavailable');
      return {ok:options.httpError!==true};
    }
  };
  return {call:vm.runInNewContext(source,context),calls};
}

(async()=>{
  let test=harness(),result=await test.call(url);
  assert.equal(result.dispatch,'started');assert.equal(result.livepocket,true);
  assert.deepEqual(test.calls.map(x=>x.name),['livepocket_individual_request_v1','livepocket_individual_mark_dispatch_v1','fetch']);
  assert.equal(test.calls[1].args.p_id,id);
  assert.equal(test.calls[2].init.headers.Authorization,'Bearer test-token');
  assert.equal(JSON.parse(test.calls[2].init.body).batch,12);

  for(const options of [{networkError:true},{httpError:true},{markError:Error('DB unavailable')},{noSession:true},{user:'other'}]){
    test=harness(options);result=await test.call(url);assert.equal(result.dispatch,'fallback');
  }
  test=harness({marked:false});result=await test.call(url);
  assert.equal(result.dispatch,'already');assert(!test.calls.some(x=>x.name==='fetch'));
  test=harness({status:'running'});result=await test.call(url);
  assert.equal(result.dispatch,'already');assert.equal(test.calls.length,1);
  test=harness({developer:false});await assert.rejects(test.call(url),/開発者ログイン/);
  console.log('Immediate LivePocket dispatch uses the authenticated endpoint, avoids duplicates and falls back safely');
})().catch(error=>{console.error(error);process.exitCode=1});
