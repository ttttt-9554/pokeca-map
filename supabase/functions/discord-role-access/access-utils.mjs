// Shared, side-effect-free Discord role checks. No account data is logged.
export const snowflake = value => typeof value === "string" && /^\d{15,22}$/.test(value);
export function allowedRoleIds(raw) {
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(/[\s,]+/).map(s=>s.trim()).filter(snowflake))];
}
export function discordIdentityId(identities) {
  if (!Array.isArray(identities)) return null;
  const discord = identities.find(row=>row?.provider==="discord");
  if (!discord) return null;
  // identity_data is authenticated by Supabase Auth, unlike user_metadata.
  const id=discord.identity_data?.provider_id || discord.identity_data?.sub || "";
  return snowflake(id) ? id : null;
}
export function hasAccess(member, allowedRoles) {
  if (!member || typeof member!=="object" || member.pending===true ||
      !Array.isArray(member.roles) || !Array.isArray(allowedRoles) ||
      !allowedRoles.length) return false;
  const roles=new Set(member.roles.filter(snowflake));
  return allowedRoles.some(id=>roles.has(id));
}
