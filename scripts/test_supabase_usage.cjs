'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const js=fs.readFileSync(path.join(root,'supabase_usage_v1.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const sql=fs.readFileSync(path.join(root,'supabase','toreca_developer_usage_v1.sql'),'utf8');
assert.match(html,/id="sbUsagePanel"/);
assert.match(html,/id="sbUsageReload"/);
assert.match(html,/supabase_usage_v1\.js/);
assert.match(app,/TorecaSupabaseUsage\?\.init/);
assert.match(app,/TorecaSupabaseUsage\?\.onAuthChanged/);
assert.match(sql,/Developer access required/);
assert.match(sql,/REVOKE ALL ON FUNCTION public\.toreca_developer_usage_v1/);
assert.match(sql,/pg_database_size/);
assert.match(sql,/cron_failed_24h/);
function node(){
  const handlers={};
  return {handlers,hidden:true,disabled:false,innerHTML:'',textContent:'',
    addEventListener(name,fn){handlers[name]=fn;},closest(){return null;}};
}
const ids=['sbUsagePanel','sbUsageReload','sbUsageStatus','sbUsageContent',
  'sbUsageCapacity','sbUsageStats','sbUsageTables'];
const nodes=Object.fromEntries(ids.map(x=>[x,node()]));
let developer=false,user='',rpcCalls=0;
const mock={schema_version:1,observed_at:'2026-11-01T22:00:00Z',
  database_bytes:47600000,database_free_reference_bytes:500000000,
  storage_bytes:0,storage_free_reference_bytes:1000000000,
  storage_objects:0,storage_buckets:0,auth_users:5,auth_signed_in_30d:4,
  connections:13,max_connections:60,cron_jobs:8,cron_active:8,
  cron_runs_24h:5050,cron_failed_24h:0,
  top_tables:[{name:'public.test<script>',bytes:204800,approx_rows:35}]};
const context={window:{},document:{getElementById:id=>nodes[id]||null},
  console,Date,Number,Math,String,Boolean};
vm.runInNewContext(js,context,{timeout:1000});
const usage=context.window.TorecaSupabaseUsage;
assert.equal(typeof usage?.init,'function');
usage.init({isDev:()=>developer,getUserId:()=>user,
  getClient:()=>({rpc:async name=>{
    assert.equal(name,'toreca_developer_usage_v1');
    rpcCalls++;
    return {data:mock,error:null};
  }})});
(async()=>{
  assert.equal(await usage.refresh(true),false,'Guest must not fetch usage');
  assert.equal(rpcCalls,0);
  developer=true;user='developer';
  assert.equal(await usage.refresh(),true);
  assert.equal(rpcCalls,1);
  assert.equal(nodes.sbUsageContent.hidden,false);
  assert.match(nodes.sbUsageCapacity.innerHTML,/500\.0 MB/);
  assert.match(nodes.sbUsageCapacity.innerHTML,/9\.5%/);
  assert.match(nodes.sbUsageStats.innerHTML,/定期ジョブ/);
  assert.match(nodes.sbUsageStats.innerHTML,/Cron失敗/);
  assert.doesNotMatch(nodes.sbUsageTables.innerHTML,/<script>/);
  assert.match(nodes.sbUsageTables.innerHTML,/&lt;script&gt;/);
  assert.equal(await usage.refresh(),true,'Cache the snapshot for 60 seconds');
  assert.equal(rpcCalls,1);
  assert.equal(await usage.refresh(true),true,'Manual refresh must fetch');
  assert.equal(rpcCalls,2);
  user='';developer=false;usage.onAuthChanged();
  assert.equal(nodes.sbUsageContent.hidden,true,'Clear sensitive stats on logout');
  assert.equal(await usage.refresh(true),false);
  assert.equal(rpcCalls,2);
  console.log('Supabase usage: developer only, quota bars, safe rendering, cache and logout passed');
})().catch(e=>{console.error(e);process.exitCode=1});
