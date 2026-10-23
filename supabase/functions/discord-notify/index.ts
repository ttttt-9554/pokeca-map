import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// v21.49: Every shared report is delivered to Discord as its own embed.
// DB trigger enqueues (atomically with INSERT); Supabase Cron calls DRAIN each
// minute. This avoids losing 6th+ messages when Discord rate-limits bursts.
const APP_URL = "https://ttttt-9554.github.io/pokeca-map/";
const MAX_DRAIN = 10;
const LOTTERY_MAX_DRAIN = 5;
const LIVEPOCKET_PUBLIC_JSON = "https://raw.githubusercontent.com/ttttt-9554/pokeca-map/main/livepocket_public.json";
const SPACING_MS = 1250;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Report = {
  id: string;
  user_id: string | null;
  shop: string | null;
  product: string | null;
  category: string | null;
  status: string | null;
  found_at: string | null;
  memo: string | null;
};
type UserCache = Map<string, string>;
const clean = (value: unknown, max = 1000) =>
  (String(value ?? "").trim() || "記載なし").slice(0, max);

function firstName(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return clean(value, 100);
  }
  return "不明";
}

async function authorName(supabase: ReturnType<typeof createClient>, report: Report, cache: UserCache) {
  if (!report.user_id) return "不明";
  if (cache.has(report.user_id)) return cache.get(report.user_id)!;
  let finder = "不明";
  try {
    const { data, error } = await supabase.auth.admin.getUserById(report.user_id);
    if (!error && data.user) {
      const meta = data.user.user_metadata ?? {};
      const discord = data.user.identities?.find((i) => i.provider === "discord")?.identity_data ?? {};
      finder = firstName(
        discord.global_name, meta.global_name, meta.custom_claims?.global_name,
        discord.full_name, meta.full_name, discord.name, meta.name,
        meta.preferred_username, meta.user_name, discord.user_name, discord.username
      );
    }
  } catch (e) {
    console.warn("Discord author lookup skipped:", String(e));
  }
  cache.set(report.user_id, finder);
  return finder;
}

async function buildMessage(supabase: ReturnType<typeof createClient>, report: Report, cache: UserCache) {
  const finder = await authorName(supabase, report, cache);
  const category = report.category === "pack" ? "パック" :
    report.category === "deck" ? "デッキ" : clean(report.category, 100);
  let foundAt = "不明";
  if (report.found_at) {
    const d = new Date(report.found_at);
    if (!Number.isNaN(d.getTime())) {
      foundAt = d.toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit"
      });
    }
  }
  return {
    username: "ポケカ発見マップ",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "📦 ポケカ販売情報が投稿されました！",
      color: 5793266,
      fields: [
        { name: "👤 発見者", value: clean(finder, 100), inline: false },
        { name: "🏪 店舗", value: clean(report.shop, 1000), inline: false },
        { name: "🎴 商品", value: clean(report.product, 1000), inline: false },
        { name: "📂 カテゴリ", value: category, inline: true },
        { name: "📢 販売状況", value: clean(report.status, 1000), inline: true },
        { name: "🕒 発見日時", value: foundAt, inline: false },
        { name: "📝 メモ", value: clean(report.memo, 1000), inline: false }
      ],
      url: APP_URL,
      footer: { text: "ポケカ発見マップ" }
    }]
  };
}


type LotteryJob = {
  source: "livepocket" | "app";
  event_key: string;
  attempts: number;
  payload: Record<string, unknown>;
};

function lotteryDate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未確認";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "未確認";
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

function buildLotteryMessage(job: LotteryJob) {
  const p = job.payload || {};
  const isApp = job.source === "app";
  const id = isApp ? job.event_key : "";
  const url = isApp
    ? APP_URL + "?app_lottery=" + encodeURIComponent(id)
    : job.event_key;
  const title = clean(p.event_title || p.product_name || (isApp ? "アプリ内抽選" : "LivePocket新着"), 220);
  const fields = [
    ...(isApp ? [{ name: "📱 アプリ名", value: clean(p.app_name, 100), inline: false }] : []),
    { name: "🏪 店舗", value: clean(p.store_name, 200), inline: false },
    { name: "📍 地域", value: clean(p.prefecture, 40), inline: true },
    { name: "🎴 商品", value: clean(p.product_name, 200), inline: false },
    { name: "🕒 応募開始", value: lotteryDate(p.application_start_at), inline: true },
    { name: "⌛ 応募締切", value: lotteryDate(p.application_end_at), inline: true }
  ];
  return {
    username: "ポケカ発見マップ",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: (isApp ? "📱 アプリ抽選が登録されました" : "🎟️ LivePocket抽選が追加されました"),
      description: title,
      color: isApp ? 3845453 : 5793266,
      url,
      fields,
      footer: { text: isApp
        ? "抽選タブで確認・応募は公式アプリで"
        : "LivePocket公式ページで条件・期間を確認してください" }
    }]
  };
}

// The GitHub Actions collector publishes this JSON after it has gathered new
// URLs. Only exact, never-before-seen URLs enqueue notifications. Preexisting
// catalog entries were baselined before enabling this scanner.
async function scanLivePocket(supabase: ReturnType<typeof createClient>) {
  const controller = new AbortController();
  const stop = setTimeout(() => controller.abort(), 16000);
  let catalog: unknown;
  try {
    const res = await fetch(LIVEPOCKET_PUBLIC_JSON + "?t=" + Date.now(), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) throw Error("LivePocket JSON HTTP " + res.status);
    catalog = await res.json();
  } finally {
    clearTimeout(stop);
  }
  const items = (catalog as {items?:unknown})?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 2500) {
    throw Error("Invalid LivePocket public catalog");
  }
  const accepted = items.filter((item: unknown): item is Record<string, unknown> => {
    if (!item || typeof item !== "object") return false;
    const url = (item as Record<string, unknown>).url;
    return typeof url === "string" && /^https:\/\/livepocket\.jp\/e\/[A-Za-z0-9_-]{4,64}$/.test(url);
  });
  const {data, error} = await supabase.rpc("lottery_register_new_livepocket", {
    p_events: accepted.map(item => ({
      url: item.url,
      event_title: typeof item.event_title === "string" ? item.event_title : "",
      product_name: typeof item.product_name === "string" ? item.product_name : "",
      store_name: typeof item.store_name === "string" ? item.store_name : "",
      prefecture: typeof item.prefecture === "string" ? item.prefecture : "",
      application_start_at: typeof item.application_start_at === "string" ? item.application_start_at : null,
      application_end_at: typeof item.application_end_at === "string" ? item.application_end_at : null
    }))
  });
  if (error) throw Error("LivePocket scan could not record new URLs: " + error.message);
  return {total: accepted.length, newlyQueued: Number(data || 0)};
}

async function drainLotteryNotifications(
  supabase: ReturnType<typeof createClient>,
  webhookUrl: string
) {
  const {data, error} = await supabase.rpc("lottery_claim_discord_notifications", {
    p_limit: LOTTERY_MAX_DRAIN
  });
  if (error) throw Error("Lottery claim failed: " + error.message);
  const jobs = (data || []) as LotteryJob[];
  let sent = 0, retried = 0, skipped = 0;
  for (const job of jobs) {
    let errorMessage: string | null = null;
    try {
      if (job.source === "app") {
        // Do not notify after the author has hidden or deleted a registration
        // before this queue entry is processed.
        const {data: entry,error: entryError} = await supabase.from("lottery_app_events")
          .select("id,is_hidden").eq("id",job.event_key).maybeSingle();
        if (entryError) throw Error(entryError.message);
        if (!entry || entry.is_hidden) {
          skipped++;
        } else {
          await sendDiscord(webhookUrl, buildLotteryMessage(job));
          sent++;
        }
      } else {
        await sendDiscord(webhookUrl, buildLotteryMessage(job));
        sent++;
      }
    } catch (err) {
      errorMessage = String(err).slice(0, 400);
      retried++;
      console.error("Lottery notification delivery failed:", errorMessage);
    }
    const {error: settleError} = await supabase.rpc("lottery_settle_discord_notification", {
      p_source: job.source,
      p_event_key: job.event_key,
      p_attempts: job.attempts,
      p_sent: errorMessage === null,
      p_error: errorMessage,
      p_retry_seconds: Math.min(3600, Math.max(60, 60 * (2 ** Math.min(job.attempts - 1, 6))))
    });
    if (settleError) console.error("Lottery settle failed:",settleError.message);
    await sleep(SPACING_MS);
  }
  return {claimed: jobs.length, sent, retried, skipped};
}

async function sendDiscord(webhookUrl: string, body: unknown): Promise<void> {
  let lastError = "Unknown Discord error";
  for (let attempt = 1; attempt <= 4; attempt++) {
    let response: Response;
    try {
      response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      lastError = "Network failure: " + String(error).slice(0, 250);
      if (attempt < 4) { await sleep(1500 * attempt); continue; }
      break;
    }
    if (response.ok) return;
    const responseText = (await response.text()).slice(0, 400);
    lastError = "Discord HTTP " + response.status + ": " + responseText;
    if (response.status !== 429 && response.status < 500) break;
    if (attempt === 4) break;
    let delay = 1600 * attempt;
    if (response.status === 429) {
      const retryHeader = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryHeader) && retryHeader > 0) {
        // Discord Retry-After is in seconds.
        delay = retryHeader * 1000;
      } else {
        try {
          const detail = JSON.parse(responseText);
          if (typeof detail.retry_after === "number") delay = detail.retry_after * 1000;
        } catch (_) { /* no JSON body */ }
      }
    }
    await sleep(Math.max(1250, Math.min(delay + 300, 20000)));
  }
  throw Error(lastError);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const secret = Deno.env.get("NOTIFY_SECRET");
  const provided = req.headers.get("x-notify-secret");
  if (!secret || !provided || provided !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }
  const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookUrl || !supabaseUrl || !serviceKey) {
    return new Response("Notification configuration missing", { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const cache: UserCache = new Map();
  let payload: Record<string, unknown>;
  try { payload = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  // Legacy webhook handling during deployment transition; removed after the
  // database queue trigger replaces the per-row HTTP webhook.
  if (payload.type === "INSERT" && payload.table === "shared_reports" && payload.record) {
    try {
      const message = await buildMessage(supabase, payload.record as Report, cache);
      await sendDiscord(webhookUrl, message);
      return new Response("Legacy notification sent", { status: 200 });
    } catch (error) {
      console.error("Legacy Discord error:", String(error));
      return new Response("Discord notification failed", { status: 502 });
    }
  }
  if (payload.type === "LOTTERY_SCAN") {
    try {
      const summary = await scanLivePocket(supabase);
      console.log("LivePocket catalog scan:", summary);
      return new Response(JSON.stringify(summary), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      console.error("LivePocket catalog scan failed:", String(error));
      return new Response("LivePocket scan unavailable", { status: 503 });
    }
  }
  if (payload.type !== "DRAIN") return new Response("Ignored", { status: 200 });

  const { data: claims, error: claimError } = await supabase
    .rpc("discord_claim_notifications", { p_limit: MAX_DRAIN });
  if (claimError) {
    console.error("Claim failed:", claimError.message);
    return new Response("Notification queue unavailable", { status: 503 });
  }
  const jobs = (claims ?? []) as { report_id: string; attempts: number }[];
  let sent = 0, retry = 0;
  for (const job of jobs) {
    let errorMessage: string | null = null;
    try {
      const { data: report, error: reportError } = await supabase
        .from("shared_reports")
        .select("id,user_id,shop,product,category,status,found_at,memo")
        .eq("id", job.report_id)
        .maybeSingle();
      if (reportError) throw Error(reportError.message);
      if (!report) throw Error("Source report was deleted");
      await sendDiscord(webhookUrl, await buildMessage(supabase, report, cache));
      sent++;
    } catch (error) {
      errorMessage = String(error).slice(0, 400);
      retry++;
      console.error("Discord item delivery failed:", errorMessage);
    }
    // A successful send is recorded before attempting the next webhook.
    const { error: settleError } = await supabase.rpc("discord_settle_notification", {
      p_report_id: job.report_id,
      p_attempts: job.attempts,
      p_sent: errorMessage === null,
      p_error: errorMessage,
      p_retry_seconds: Math.min(3600, Math.max(60, 60 * (2 ** Math.min(job.attempts - 1, 6))))
    });
    if (settleError) console.error("Queue status update failed:", settleError.message);
    // Respect the Discord webhook rate limit; never fire 10 at once.
    await sleep(SPACING_MS);
  }
  let lotteryResult: Record<string,number>;
  try {
    // Lottery alerts MUST use the dedicated webhook, never the sales channel.
    // If it is missing, leave notices queued for retry rather than misroute them.
    const lotteryWebhook = Deno.env.get("LOTTERY_DISCORD_WEBHOOK_URL");
    if (!lotteryWebhook) throw Error("Dedicated lottery webhook not configured");
    lotteryResult = await drainLotteryNotifications(supabase, lotteryWebhook);
  } catch (error) {
    console.error("Lottery notification queue failed:", String(error));
    return new Response("Lottery notification queue unavailable", { status: 503 });
  }
  console.log("Discord queued notifications:", { claimed: jobs.length, sent, retry, lotteryResult });
  return new Response(JSON.stringify({ claimed: jobs.length, sent, retry, lottery: lotteryResult }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
});
