// Server-only logic for the signed Supabase Custom Access Token Hook.
export function snowflake(s){return typeof s==='string'&&/^\d{15,22}$/.test(s);}
export function roles(raw){
  if(typeof raw!=='string')return [];
  const all=raw.split(/[\s,]+/).filter(Boolean);
  return all.length&&all.every(snowflake)?[...new Set(all)]:[];
}
export function isHookEvent(event){
  return !!event&&typeof event==='object'&&
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(event.user_id||'')&&
    event.claims&&event.claims.sub===event.user_id&&
    event.claims.role==='authenticated'&&event.claims.is_anonymous===false;
}
export function discordId(identities){
  if(!Array.isArray(identities))return null;
  const i=identities.find(r=>r?.provider==='discord');
  const id=i?.identity_data?.provider_id||i?.identity_data?.sub;
  return snowflake(id)?id:null;
}
export function permitted(member,allowed){
  return !!member&&member.pending!==true&&Array.isArray(member.roles)&&
    allowed.length>0&&member.roles.some(role=>snowflake(role)&&allowed.includes(role));
}

export const REMEMBER_DAYS=14;
export const REMEMBER_MS=REMEMBER_DAYS*24*60*60*1000;
export function uuid(value){
  return typeof value==='string'&&
    /^[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}$/i.test(value);
}
export function rememberedSessionAllowed(event,row,now=Date.now()){
  if(!event||event.authentication_method!=='token_refresh'||!row||
     !uuid(event.claims?.session_id)||row.session_id!==event.claims.session_id||
     row.user_id!==event.user_id)return false;
  const until=Date.parse(row.authorized_until||'');
  // Never trust an indefinite or malformatted allow record.
  return Number.isFinite(until)&&until>now&&until<=now+REMEMBER_MS;
}
export function authorizedClaims(claims,until){
  const unix=Math.floor(Date.parse(until)/1000);
  if(!Number.isFinite(unix)||unix<=0)throw Error('Invalid access expiry');
  return {...claims,toreca_discord_role_until:unix};
}
