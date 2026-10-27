import { GoogleCalendarSync } from './google_calendar_sync.js';
import { GoogleCalendarImport } from './google_calendar_import.js';
import { publicOrigin } from './site_seo.js';

export class GoogleCalendarWatch {
  static path = '/api/google-calendar/webhook';

  static address(env) {
    const origin = publicOrigin(env.SITE_URL);
    return env.GOOGLE_CALENDAR_WEBHOOK_ENABLED === 'true' && GoogleCalendarSync.configured(env) && origin
      ? origin + this.path : null;
  }

  static async hash(token) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  // Keep the old channel valid during renewal. Google expires it automatically,
  // so a failed renewal never interrupts the working channel.
  static async ensure(env) {
    if (!this.address(env)) return { status: 'disabled' };
    try { return await this.register(env); }
    catch { return { status: 'failed' }; }
  }

  static async register(env) {
    const db = env.BOOKING_DB, calendar = env.GOOGLE_CALENDAR_ID.trim();
    const address = this.address(env), now = Date.now(), lease = crypto.randomUUID();
    await db.prepare('INSERT OR IGNORE INTO google_calendar_watch_state(calendar_id) VALUES(?)').bind(calendar).run();
    const claimed = await db.prepare(`UPDATE google_calendar_watch_state SET lease_token=?, lease_until=?, retry_at=?
      WHERE calendar_id=? AND lease_until<=? AND retry_at<=? AND NOT EXISTS (
        SELECT 1 FROM google_calendar_watch_channel WHERE calendar_id=? AND address=? AND confirmed=1 AND expires_at>?
      ) RETURNING calendar_id`).bind(lease, now+120000, now+3600000, calendar, now, now, calendar, address, now+86400000).first();
    if (!claimed) return { status: 'unchanged' };
    try {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
      const id = crypto.randomUUID();
      const access = await GoogleCalendarSync.accessToken(env);
      // Google may deliver its initial sync callback before the watch response.
      // Only a hash is stored; the secret is never returned by the status API.
      await db.prepare(`INSERT INTO google_calendar_watch_channel(id,calendar_id,address,token_hash,expires_at)
        VALUES(?,?,?,?,?)`).bind(id, calendar, address, await this.hash(token), now+600000).run();
      const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events/watch`, {
        method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, type:'web_hook', address, token, params:{ ttl:'604800' } }),
        redirect: 'manual', signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const channel = await response.json(), expires = Number(channel.expiration);
      if (channel.id !== id || typeof channel.resourceId !== 'string' || !channel.resourceId || channel.resourceId.length>1024 ||
          !Number.isSafeInteger(expires) || expires<=Date.now()) throw new Error('invalid_response');
      const saved = await db.prepare(`UPDATE google_calendar_watch_channel SET resource_id=?, expires_at=?, confirmed=1
        WHERE id=? AND (resource_id='' OR resource_id=?) RETURNING id`)
        .bind(channel.resourceId, expires, id, channel.resourceId).first();
      if (!saved) throw new Error('invalid_response');
      await db.prepare(`UPDATE google_calendar_watch_state SET lease_token='',lease_until=0,retry_at=0,last_error=''
        WHERE calendar_id=? AND lease_token=?`).bind(calendar,lease).run();
      await db.prepare('DELETE FROM google_calendar_watch_channel WHERE expires_at<=?').bind(now).run();
      return { status: 'active' };
    } catch(error) {
      const reason = /^HTTP \d{3}$/.test(error.message) ? error.message : '登録を完了できませんでした';
      await db.prepare(`UPDATE google_calendar_watch_state SET lease_token='',lease_until=0,last_error=?
        WHERE calendar_id=? AND lease_token=?`).bind(`Google変更通知: ${reason}`,calendar,lease).run();
      return { status: 'failed' };
    }
  }

  static async receive(request, env, ctx) {
    const reply = status => new Response(null, {status, headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex'}});
    if (request.method !== 'POST') return reply(405);
    if (!this.address(env) || new URL(request.url).origin !== publicOrigin(env.SITE_URL)) return reply(403);
    const headers = request.headers;
    const id = headers.get('X-Goog-Channel-ID') || '', token = headers.get('X-Goog-Channel-Token') || '';
    const resource = headers.get('X-Goog-Resource-ID') || '', number = headers.get('X-Goog-Message-Number') || '';
    if (!id || id.length>64 || !/^[a-f0-9]{64}$/.test(token) || !resource || resource.length>1024 ||
        !/^[1-9]\d{0,39}$/.test(number) || !['sync','exists','not_exists'].includes(headers.get('X-Goog-Resource-State'))) return reply(403);
    try {
      const db = env.BOOKING_DB, calendar = env.GOOGLE_CALENDAR_ID.trim();
      // Padding permits atomic comparison without losing precision on large numbers.
      const message = number.padStart(40,'0'), hash = await this.hash(token), now = Date.now();
      const valid = await db.prepare(`SELECT id FROM google_calendar_watch_channel
        WHERE id=? AND calendar_id=? AND address=? AND token_hash=? AND expires_at>?
        AND (resource_id='' OR resource_id=?)`).bind(id,calendar,this.address(env),hash,now,resource).first();
      if (!valid) return reply(403);
      await db.prepare('INSERT OR IGNORE INTO google_calendar_import(calendar_id) VALUES(?)').bind(calendar).run();
      const accepted = await db.batch([
        db.prepare(`UPDATE google_calendar_import SET requested_revision=requested_revision+1 WHERE calendar_id=?
          AND EXISTS(SELECT 1 FROM google_calendar_watch_channel WHERE id=? AND expires_at>? AND message_number<?
            AND (resource_id='' OR resource_id=?))`).bind(calendar,id,now,message,resource),
        db.prepare(`UPDATE google_calendar_watch_channel SET resource_id=?,message_number=?,notified_at=?
          WHERE id=? AND expires_at>? AND message_number<? AND (resource_id='' OR resource_id=?)`)
          .bind(resource,message,new Date().toISOString(),id,now,message,resource)
      ]);
      // Deduplication and the durable revision update commit together. The active
      // importer checks the revision again before finishing; cron is the fallback.
      if ((accepted[1]?.meta?.changes ?? accepted[1]?.changes) === 1) ctx.waitUntil(GoogleCalendarImport.run(env));
      return reply(204);
    } catch { return reply(503); }
  }

  static async status(env) {
    const calendar = env.GOOGLE_CALENDAR_ID?.trim() || '', address = this.address(env) || '';
    const channel = await env.BOOKING_DB.prepare(`SELECT MAX(CASE WHEN confirmed=1 THEN expires_at ELSE 0 END) AS expiration,
      MAX(notified_at) AS notified FROM google_calendar_watch_channel WHERE calendar_id=? AND address=? AND expires_at>?`)
      .bind(calendar,address,Date.now()).first();
    const state = await env.BOOKING_DB.prepare('SELECT last_error FROM google_calendar_watch_state WHERE calendar_id=?').bind(calendar).first();
    return { enabled:!!address, active:!!channel?.expiration, expiresAt:channel?.expiration ? new Date(channel.expiration).toISOString() : '',
      lastNotificationAt:channel?.notified || '', error:state?.last_error || '' };
  }
}
