import {readFile,writeFile,rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {googleFormUrl,googleFormFields,fetchGoogleForm,GOOGLE_FORMS_PARSER_VERSION} from '../supabase/functions/lottery-individual-fetch/google-forms.mjs';

const catalogPath='other_lottery_public.json';
const retryInterval=6*60*60*1000;
const discovered=item=>Date.parse(item.discord_posted_at||item.first_detected_at||'');
export async function enrichGoogleForms(catalog,load=fetchGoogleForm,now=new Date()){
  let checked=0,updated=0;
  const items=[...catalog.items].sort((a,b)=>(discovered(b)||0)-(discovered(a)||0));
  for(const item of items){
    if(checked>=8)break;
    if(!googleFormUrl(item.url)||item.manual_page_unavailable||item.manual_card_hidden)continue;
    const endText=item.application_end_at||'';
    const end=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(endText)?endText+'T23:59:59.999+09:00':endText);
    if(Number.isFinite(end)&&end<+now)continue;
    if(Number.isFinite(discovered(item))&&discovered(item)<+now-14*86400000&&!Number.isFinite(end))continue;
    if(item.google_forms_parser_version===GOOGLE_FORMS_PARSER_VERSION&&
      +now-Date.parse(item.google_forms_checked_at||'')<retryInterval)continue;
    item.google_forms_checked_at=now.toISOString();
    item.google_forms_parser_version=GOOGLE_FORMS_PARSER_VERSION;checked++;
    try{
      const page=await load(item.url);
      const fields=googleFormFields(page.html,page.url,{referenceDate:
        item.discord_posted_at||item.first_detected_at||now.toISOString()});
      if(!fields.event_title){item.google_forms_last_error='closed_or_unavailable';continue;}
      const {product_type,...metadata}=fields;
      for(const field of ['payment_start_date','payment_start_time','payment_end_date','payment_end_time','pickup_period_note']){
        if(!(field in fields))delete item[field];
      }
      if(item.google_forms_verified_at && fields.pickup_period_note && !fields.purchase_start_date && !fields.purchase_end_date){
        for(const field of ['purchase_start_date','purchase_start_time','purchase_end_date','purchase_end_time'])delete item[field];
      }
      if(fields.google_forms_start_not_stated && item.application_start_at)item.application_start_at=null;
      // Partial official metadata is useful too: do not fabricate a missing start
      // date, time, or store. Developer review still flags each absent field.
      Object.assign(item,metadata,{
        official_event_title:fields.event_title,event_title_provisional:false,
        external_url_unverified:false,google_forms_verified_at:now.toISOString(),
        google_forms_source_url:page.url
      });
      if(product_type)item.pokemon_map_type=product_type;
      delete item.google_forms_last_error;
      updated++;
    }catch{item.google_forms_last_error='page_unavailable';}
  }
  return {checked,updated};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const catalog=JSON.parse(await readFile(catalogPath,'utf8'));
  const result=await enrichGoogleForms(catalog);
  if(result.checked){
    const temp=catalogPath+'.tmp';
    await writeFile(temp,JSON.stringify(catalog,null,2)+'\n','utf8');
    await rename(temp,catalogPath);
  }
  console.log('Google Forms lottery pages:',result);
}
