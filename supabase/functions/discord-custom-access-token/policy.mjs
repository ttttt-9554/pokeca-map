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
