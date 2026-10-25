// Noorplan Push Server: speichert pro Gerät die geplanten Erinnerungen
// und schickt sie zur richtigen Minute als Web Push ans Handy.
import { DurableObject } from "cloudflare:workers";
import { createVapidKeys, sendPush } from "./webpush.js";

const SUBJECT = "https://elyasimpulslabs.github.io/noorplan/";
const ALLOWED = ["https://elyasimpulslabs.github.io", "http://localhost:8767"];
const MAX_EVENTS = 1000;

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : ALLOWED[0], "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("Noorplan Push Server läuft.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const hub = env.HUB.get(env.HUB.idFromName("main"));
    try {
      if (url.pathname === "/vapid" && req.method === "GET") return json(req, { key: await hub.publicKey() });
      if (req.method !== "POST") return json(req, { error: "Nicht gefunden" }, 404);
      if ((Number(req.headers.get("Content-Length")) || 0) > 300000) return json(req, { error: "Zu groß" }, 413);
      const body = await req.json();
      if (typeof body.id !== "string" || body.id.length < 16 || body.id.length > 64) return json(req, { error: "Ungültige Geräte ID" }, 400);
      if (url.pathname === "/sync") return json(req, await hub.sync(body));
      if (url.pathname === "/test") return json(req, await hub.test(body.id, Math.min(Math.max(Number(body.delay) || 0, 0), 300)));
      if (url.pathname === "/unsub") return json(req, await hub.unsub(body.id));
      return json(req, { error: "Nicht gefunden" }, 404);
    } catch (e) {
      return json(req, { error: String(e && e.message || e) }, 500);
    }
  }
};

export class Hub extends DurableObject {
  async vapid() {
    let v = await this.ctx.storage.get("vapid");
    if (!v) { v = await createVapidKeys(); await this.ctx.storage.put("vapid", v); }
    return v;
  }
  async publicKey() { return (await this.vapid()).publicKey; }

  async sync({ id, sub, events }) {
    if (!sub || typeof sub.endpoint !== "string" || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error("Ungültiges Push Abo");
    if (!/^https:\/\//.test(sub.endpoint)) throw new Error("Ungültiger Push Dienst");
    const now = Date.now();
    const clean = (Array.isArray(events) ? events : [])
      .filter(e => e && Number.isFinite(e.at) && e.at > now - 60000 && e.at < now + 45 * 86400000)
      .slice(0, MAX_EVENTS)
      .map(e => ({ at: Math.round(e.at), id: String(e.id || "").slice(0, 80), t: String(e.t || "Noorplan").slice(0, 120), b: String(e.b || "").slice(0, 400) }))
      .sort((a, b) => a.at - b.at);
    const old = await this.ctx.storage.get("u:" + id);
    const sent = new Set((old && old.sent) || []);
    await this.ctx.storage.put("u:" + id, { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, events: clean.filter(e => !sent.has(e.id)), sent: [...sent].slice(-300), seen: now });
    await this.schedule();
    return { ok: true, count: clean.length, next: clean.find(e => !sent.has(e.id))?.at || null };
  }

  async test(id, delay) {
    const u = await this.ctx.storage.get("u:" + id);
    if (!u) throw new Error("Gerät noch nicht verbunden");
    const ev = { at: Date.now() + delay * 1000, id: "test-" + Date.now(), t: "Test von Noorplan", b: delay ? "Diese Erinnerung kam vom Server, auch bei geschlossener App." : "Push funktioniert." };
    if (!delay) { const s = await sendPush(u.sub, ev, await this.vapid(), SUBJECT); return { ok: s < 300, status: s }; }
    u.events.push(ev); u.events.sort((a, b) => a.at - b.at);
    await this.ctx.storage.put("u:" + id, u); await this.schedule();
    return { ok: true, at: ev.at };
  }

  async unsub(id) { await this.ctx.storage.delete("u:" + id); await this.schedule(); return { ok: true }; }

  async schedule() {
    const users = await this.ctx.storage.list({ prefix: "u:" });
    let next = Infinity;
    for (const u of users.values()) if (u.events.length) next = Math.min(next, u.events[0].at);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 500));
  }

  async alarm() {
    const now = Date.now(), vapid = await this.vapid();
    const users = await this.ctx.storage.list({ prefix: "u:" });
    for (const [key, u] of users) {
      const due = u.events.filter(e => e.at <= now + 2000);
      if (!due.length) continue;
      u.events = u.events.filter(e => e.at > now + 2000);
      let gone = false;
      for (const e of due) {
        if (now - e.at > 10 * 60000) continue; // zu alt, nicht mehr senden
        try {
          const s = await sendPush(u.sub, e, vapid, SUBJECT);
          if (s === 404 || s === 410) { gone = true; break; }
        } catch (_) {}
        u.sent = [...(u.sent || []), e.id].slice(-300);
      }
      if (gone) await this.ctx.storage.delete(key); else await this.ctx.storage.put(key, u);
    }
    await this.schedule();
  }
}
