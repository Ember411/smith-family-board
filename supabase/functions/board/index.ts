import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-board-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const norm = (x: string) => x.replace(/[‘’]/g, "'").trim();

const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TW_FROM = Deno.env.get("TWILIO_FROM") ?? "";
const smsEnabled = () => !!(TW_SID && TW_TOKEN && TW_FROM);

type Member = { id: string; name: string; phone?: string };
type State = { jobs?: { id: string; name: string; who: string | null }[]; members?: Member[]; rotation?: { month: string; assign: Record<string, string | null> } };

async function key(name: string) {
  const { data } = await sb.from("board_keys").select("value").eq("name", name).single();
  return data?.value as string | undefined;
}
async function loadState(): Promise<State> {
  const { data } = await sb.from("board_state").select("data").eq("id", "home").maybeSingle();
  return (data?.data ?? {}) as State;
}
function e164(p: string) {
  const d = (p || "").replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(d)) return d;
  const digits = d.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "";
}
async function sendSms(to: string, body: string) {
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${TW_SID}:${TW_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: TW_FROM, Body: body }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: (j as { status?: string }).status ?? String(r.status), error: r.ok ? null : ((j as { message?: string }).message ?? "send failed") };
}

const MSG: Record<string, (n: string) => string> = {
  garbage: (n) => `Hey ${n}, it's Sunday night. Please take the garbage cans out to the street before bed. Thanks!`,
  dishwasher: (n) => `Hey ${n}, reminder: you're on loading the dishwasher tonight.`,
  sweeping: (n) => `Hey ${n}, reminder: you're on sweeping today.`,
};

// Monthly rotation: garbage -> sweeping -> dishwasher -> garbage (Denver calendar months)
const ROT = ["garbage", "sweeping", "dishwasher"];
function denverMonthIndex(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "numeric" }).formatToParts(d);
  const y = Number(p.find((x) => x.type === "year")!.value), m = Number(p.find((x) => x.type === "month")!.value);
  return y * 12 + (m - 1);
}
function rotated(r: State["rotation"]) {
  if (!r?.assign || !r.month) return null;
  const [y, m] = r.month.split("-").map(Number);
  const k = (((denverMonthIndex() - (y * 12 + m - 1)) % 3) + 3) % 3;
  const out: Record<string, string | null> = {};
  for (const [job, who] of Object.entries(r.assign)) {
    const i = ROT.indexOf(job);
    if (i >= 0) out[ROT[(i + k) % 3]] = who;
  }
  return out;
}
function jobAssignee(s: State, id: string) {
  const job = (s.jobs ?? []).find((j) => j.id === id);
  if (!job) return null;
  const rot = rotated(s.rotation);
  const whoId = rot && id in rot ? rot[id] : job.who;
  const m = (s.members ?? []).find((x) => x.id === whoId);
  return { job, m };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url);
  const given = (req.headers.get("x-board-key") || url.searchParams.get("key") || "").trim().toLowerCase();
  const action = url.searchParams.get("action");

  // Board saves its shared state
  if (req.method === "POST" && action === "state") {
    if (!given || given !== (await key("read"))) return json({ error: "bad key" }, 401);
    const body = await req.text();
    if (body.length > 1500000) return json({ error: "too large" }, 413);
    let data: unknown;
    try { data = JSON.parse(body); } catch { return json({ error: "bad json" }, 400); }
    const at = new Date().toISOString();
    const { error } = await sb.from("board_state").upsert({ id: "home", data, updated_at: at });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, stateAt: at });
  }

  // Board sends a text through Twilio to chosen family members
  if (req.method === "POST" && action === "sms") {
    if (!given || given !== (await key("read"))) return json({ error: "bad key" }, 401);
    if (!smsEnabled()) return json({ error: "texting not set up" }, 503);
    let p: { to?: string[]; body?: string };
    try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const body = String(p.body ?? "").trim().slice(0, 600);
    const ids = Array.isArray(p.to) ? p.to.slice(0, 20).map(String) : [];
    if (!body || !ids.length) return json({ error: "need recipients and a message" }, 400);
    const s = await loadState();
    const results = [];
    for (const id of ids) {
      const m = (s.members ?? []).find((x) => x.id === id);
      const to = e164(m?.phone ?? "");
      if (!m || !to) { results.push({ id, name: m?.name ?? id, ok: false, error: "no number" }); continue; }
      const r = await sendSms(to, body);
      await sb.from("sms_log").insert({ to_member: m.name, to_phone: to, body, status: r.status, error: r.error });
      results.push({ id, name: m.name, ok: r.ok, error: r.error });
    }
    return json({ ok: results.some((r) => r.ok), results });
  }

  // Scheduled job reminder sent straight from the server (cron)
  if (req.method === "POST" && action === "remind") {
    if (!given || given !== (await key("sync"))) return json({ error: "bad key" }, 401);
    if (!smsEnabled()) return json({ error: "texting not set up" }, 503);
    const id = (url.searchParams.get("id") || "garbage").toLowerCase();
    const a = jobAssignee(await loadState(), id);
    const to = e164(a?.m?.phone ?? "");
    if (!a?.m || !to) return json({ ok: false, error: "nobody with a number assigned" });
    const body = (MSG[id] ?? ((n: string) => `Hey ${n}, reminder: ${a.job.name}.`))(a.m.name);
    const r = await sendSms(to, body);
    await sb.from("sms_log").insert({ to_member: a.m.name, to_phone: to, body, status: r.status, error: r.error });
    return json({ ok: r.ok, to: a.m.name, error: r.error });
  }

  // iPhone Shortcut pushes calendar events
  if (req.method === "POST") {
    if (!given || given !== (await key("sync"))) return json({ error: "bad key" }, 401);
    const { data: cals } = await sb.from("board_calendars").select("name");
    const allowed = new Set((cals ?? []).map((c: { name: string }) => norm(c.name).toLowerCase()));
    const text = await req.text();
    const rows: Record<string, unknown>[] = [];
    let skipped = 0, ignored = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const [title, s, e, allDay, cal] = line.split("|||").map((x) => norm(x ?? ""));
      if (!allowed.has((cal || "").toLowerCase())) { ignored++; continue; }
      const st = Date.parse(s), en = Date.parse(e);
      if (!title || isNaN(st)) { skipped++; continue; }
      rows.push({ title: title.slice(0, 200), calendar: cal.slice(0, 100), starts_at: new Date(st).toISOString(), ends_at: isNaN(en) ? null : new Date(en).toISOString(), all_day: /^(yes|true|1)$/i.test(allDay || "") });
    }
    if (!rows.length) return json({ ok: false, error: "no board events found", skipped, ignored }, 400);
    const del = await sb.from("cal_events").delete().gte("id", 0);
    if (del.error) return json({ error: del.error.message }, 500);
    const ins = await sb.from("cal_events").insert(rows);
    if (ins.error) return json({ error: ins.error.message }, 500);
    await sb.from("sync_log").insert({ count: rows.length, note: `skipped ${skipped}, ignored ${ignored}` });
    return json({ ok: true, saved: rows.length, skipped, ignored });
  }

  // Who has a job right now (used by the phone Shortcut)
  if (req.method === "GET" && action === "job") {
    if (!given || given !== (await key("read"))) return json({ error: "bad key" }, 401);
    const id = (url.searchParams.get("id") || "garbage").toLowerCase();
    const a = jobAssignee(await loadState(), id);
    if (!a) return json({ assigned: false, error: "no such job" }, 404);
    if (!a.m) return json({ assigned: false, job: a.job.name, name: "", phone: "", message: "" });
    const phone = (a.m.phone || "").replace(/[^\d+]/g, "");
    return json({ assigned: !!phone, job: a.job.name, name: a.m.name, phone, message: (MSG[id] ?? ((n: string) => `Hey ${n}, reminder: ${a.job.name}.`))(a.m.name) });
  }

  if (req.method === "GET") {
    if (!given || given !== (await key("read"))) return json({ error: "bad key" }, 401);
    const from = new Date(Date.now() - 4 * 864e5).toISOString();
    const [ev, log, st] = await Promise.all([
      sb.from("cal_events").select("calendar,title,starts_at,ends_at,all_day").gte("starts_at", from).order("starts_at").limit(1000),
      sb.from("sync_log").select("at").order("id", { ascending: false }).limit(1),
      sb.from("board_state").select("data,updated_at").eq("id", "home").maybeSingle(),
    ]);
    if (ev.error) return json({ error: ev.error.message }, 500);
    return json({ events: ev.data, lastSync: log.data?.[0]?.at ?? null, state: st.data?.data ?? null, stateAt: st.data?.updated_at ?? null, sms: smsEnabled() });
  }
  return json({ error: "method" }, 405);
});
