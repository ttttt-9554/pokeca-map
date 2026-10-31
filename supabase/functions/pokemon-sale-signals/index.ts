import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Independent of the stock monitor and its waiting-room cooldown.
// Only anonymous, already-correlated sale URLs are read from the existing
// owner-controlled public catalog. No Discord user IDs, bodies or tokens.
const SOURCE =
  "https://raw.githubusercontent.com/ttttt-9554/pokeca-map/main/other_lottery_public.json";
const PRODUCT_URL =
  /^https:\/\/www\.pokemoncenter-online\.com\/[0-9]{6,20}(?:-[A-Za-z0-9_-]+)?\.html$/;

type Signal = {
  url: string; report_kind: "pack" | "deck";
  independent_reporters: number; independent_statements: number;
  independent_channels: number; latest_at: string;
};

function approved(row: unknown): row is Signal {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const r = row as Record<string,unknown>;
  return typeof r.url === "string" && PRODUCT_URL.test(r.url) &&
    (r.report_kind === "pack" || r.report_kind === "deck") &&
    Number.isInteger(r.independent_reporters) &&
    (r.independent_reporters as number)>=2 &&
    (r.independent_reporters as number)<=20 &&
    Number.isInteger(r.independent_statements) &&
    (r.independent_statements as number)>=2 &&
    (r.independent_statements as number)<=20 &&
    Number.isInteger(r.independent_channels) &&
    (r.independent_channels as number)>=1 &&
    (r.independent_channels as number)<=20 &&
    typeof r.latest_at === "string" &&
    Number.isFinite(Date.parse(r.latest_at)) &&
    Date.parse(r.latest_at) >= Date.now()-15*60000 &&
    Date.parse(r.latest_at) <= Date.now()+90000;
}

Deno.serve(async (req:Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed",{status:405});
  const secret = Deno.env.get("NOTIFY_SECRET");
  if (!secret || req.headers.get("x-notify-secret") !== secret)
    return new Response("Unauthorized",{status:401});
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey)
    return new Response("Backend configuration missing",{status:500});

  const ac = new AbortController();
  const timeout = setTimeout(()=>ac.abort(),18000);
  let document:unknown;
  try {
    const response = await fetch(SOURCE+"?nocache="+Date.now(),{
      signal:ac.signal,cache:"no-store",
      headers:{"Accept":"application/json"}
    });
    if (!response.ok) throw new Error("Source HTTP " + response.status);
    const len=Number(response.headers.get("content-length")||"0");
    if (len>2000000) throw new Error("Public source too large");
    const text=await response.text();
    if (text.length>2000000) throw new Error("Public source too large");
    document=JSON.parse(text);
  } catch (err) {
    console.error("Pokemon report source unavailable:",String(err).slice(0,140));
    return Response.json({status:"source_unavailable"},{status:502});
  } finally {
    clearTimeout(timeout);
  }

  const root=document as {schema_version?:unknown,sale_report_signals?:unknown}|null;
  if (!root || typeof root!=="object" || root.schema_version!==1) {
    return Response.json({status:"invalid_source"},{status:502});
  }
  const raw=root.sale_report_signals ?? [];
  if (!Array.isArray(raw) || raw.length>30) {
    return Response.json({status:"invalid_report_list"},{status:502});
  }
  const signals=raw.filter(approved).slice(0,30);
  const supabase=createClient(supabaseUrl,serviceKey,{
    auth:{persistSession:false,autoRefreshToken:false}
  });
  const {data,error}=await supabase.rpc("guerrilla_sale_ingest_aggregates_v1",{
    p_signals:signals
  });
  if(error) {
    console.error("Pokemon report ingest error:",error.code||"unknown");
    return Response.json({status:"ingest_failed"},{status:503});
  }
  // Never represent unconfirmed reports as available stock.
  return Response.json({
    status:"ok",reports_in_source:raw.length,corroborated:signals.length,
    ...((data&&typeof data==="object")?data:{})
  });
});
