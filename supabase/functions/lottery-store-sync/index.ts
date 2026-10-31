import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// v21.145: Import ONLY public, already-published lottery catalog store labels.
// Never read or transmit private application accounts or user outcomes.
const CATALOGS = [
  "https://raw.githubusercontent.com/ttttt-9554/pokeca-map/main/livepocket_public.json",
  "https://raw.githubusercontent.com/ttttt-9554/pokeca-map/main/other_lottery_public.json"
];
const MAX_EVENTS = 5000;
const BATCH = 500;
type Store = { name: string; prefecture: string };
type Lottery = {
  store_name?: unknown;
  prefecture?: unknown;
  stores?: unknown;
};

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function addStore(
  map: Map<string, Store>, name: unknown, prefecture: unknown
) {
  const n = clean(name, 200);
  const pref = clean(prefecture, 30);
  if (n.length < 2 || pref.length < 2 || !/[都道府県]$/.test(pref)) return;
  const key = pref + "|" + n.toLocaleLowerCase("ja-JP")
    .replace(/[\s　・･._－（）()【】「」-]+/g, "");
  if (!map.has(key)) map.set(key, { name: n, prefecture: pref });
}

async function readCatalog(url: string): Promise<Lottery[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(url + "?store_sync=" + Date.now(), {
      cache: "no-store", signal: controller.signal
    });
    if (!response.ok) throw new Error("Public catalog HTTP " + response.status);
    const body: unknown = await response.json();
    const rows = (body as { items?: unknown })?.items;
    if (!Array.isArray(rows) || rows.length > MAX_EVENTS) {
      throw new Error("Unexpected public catalog item count");
    }
    return rows.filter((row): row is Lottery =>
      !!row && typeof row === "object" && !Array.isArray(row));
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const expected = Deno.env.get("NOTIFY_SECRET");
  const supplied = req.headers.get("x-notify-secret");
  if (!expected || !supplied || supplied !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("Sync configuration missing", { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const downloaded = await Promise.allSettled(CATALOGS.map(readCatalog));
  const stores = new Map<string, Store>();
  const errors: string[] = [];
  let eventCount = 0;
  downloaded.forEach((result, index) => {
    if (result.status !== "fulfilled") {
      errors.push("catalog " + (index + 1) + ": " + String(result.reason).slice(0, 130));
      return;
    }
    eventCount += result.value.length;
    for (const event of result.value) {
      addStore(stores, event.store_name, event.prefecture);
      if (Array.isArray(event.stores)) {
        for (const entry of event.stores) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const store = entry as Record<string, unknown>;
          addStore(stores, store.name, store.prefecture);
        }
      }
    }
  });

  if (downloaded.every(result => result.status !== "fulfilled")) {
    console.error("Lottery store catalogs unavailable:", errors.join("; "));
    return new Response(JSON.stringify({ error: "Catalogs unavailable", errors }), {
      status: 502, headers: { "Content-Type": "application/json" }
    });
  }

  const values = Array.from(stores.values());
  let accepted = 0;
  for (let offset = 0; offset < values.length; offset += BATCH) {
    const { data, error } = await supabase.rpc("lottery_store_ingest_public_v1", {
      p_stores: values.slice(offset, offset + BATCH)
    });
    if (error) {
      console.error("Lotteries store master sync failed:", error.message);
      return new Response(JSON.stringify({ error: "Store master import failed" }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
    accepted += Number(data || 0);
  }

  const result = {
    publicEvents: eventCount, candidateStores: values.length,
    accepted, sourcesOk: downloaded.length - errors.length, errors
  };
  console.log("Public lottery store master sync:", JSON.stringify(result));
  return new Response(JSON.stringify(result), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
});
