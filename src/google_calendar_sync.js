import { MENUS } from './booking_service.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const encoder = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

export class GoogleCalendarSync {
  static configured(env) {
    return typeof env.GOOGLE_SERVICE_ACCOUNT_JSON === 'string' && !!env.GOOGLE_SERVICE_ACCOUNT_JSON.trim() &&
      typeof env.GOOGLE_CALENDAR_ID === 'string' && !!env.GOOGLE_CALENDAR_ID.trim();
  }

  static credentials(env) {
    try {
      const value = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
      if (value.type !== 'service_account' || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(value.client_email) ||
          typeof value.private_key !== 'string' || !value.private_key.includes('BEGIN PRIVATE KEY')) throw new Error();
      // Always use Google's fixed endpoint, never a URL supplied by a credentials file.
      return value;
    } catch { throw new Error('GoogleサービスアカウントのJSON設定を確認してください。'); }
  }

  static async accessToken(env) {
    const account = this.credentials(env);
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const now = Math.floor(Date.now() / 1000);
    const claim = base64url(encoder.encode(JSON.stringify({
      iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600
    })));
    const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    let key;
    try {
      key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    } catch { throw new Error('Googleサービスアカウントの秘密鍵を確認してください。'); }
    const unsigned = `${header}.${claim}`;
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned)));
    const response = await fetch(TOKEN_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(signature)}` })
    });
    if (!response.ok) throw new Error(`Google認証 HTTP ${response.status}`);
    let data;
    try { data = await response.json(); } catch { throw new Error('Google認証の応答を確認できません。'); }
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer') {
      throw new Error('Google認証の応答を確認できません。');
    }
    return data.access_token;
  }

  static async eventId(job) {
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(`kishin:${job.source_type}:${job.source_id}`));
    return 'a' + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  static event(row, job) {
    const patient = job.source_type === 'booking' || row.block_type === 'patient';
    const course = MENUS[row.menu]?.name || '患者予約';
    return {
      summary: patient ? `${row.customer_name}さま／${course}` : '私用',
      description: '予約システムから自動反映。変更・取り消しは院長用ページで操作してください。',
      start: { dateTime: row.start_at, timeZone: 'Asia/Tokyo' },
      end: { dateTime: row.end_at, timeZone: 'Asia/Tokyo' },
      visibility: 'private', status: 'confirmed',
      extendedProperties: { private: { kishinSource: `${job.source_type}:${job.source_id}` } }
    };
  }

  static async syncJob(db, job, calendarId, token) {
    const table = job.source_type === 'booking' ? 'bookings' : 'blocked_periods';
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(job.source_id).first();
    const remove = !row || (job.source_type === 'booking' && row.status !== 'confirmed');
    const id = await this.eventId(job);
    const collection = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const url = `${collection}/${id}`;
    const call = (target, method = 'GET', body, etag) => fetch(target, {
      method, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const found = await call(url);
    let existing;
    if (found.ok) {
      existing = await found.json();
      if (existing.extendedProperties?.private?.kishinSource !== `${job.source_type}:${job.source_id}`) {
        // Deleted Google events may return a tombstone with only an ID.
        if (!(remove && existing.status === 'cancelled')) throw new Error('同期先の予定を確認できません。');
      }
    } else if (![404, 410].includes(found.status)) throw new Error(`Google予定取得 HTTP ${found.status}`);
    if (remove && (!existing || existing.status === 'cancelled')) return;
    let response;
    if (remove) response = await call(url, 'DELETE', null, existing.etag);
    else if (existing) response = await call(url, 'PUT', this.event(row, job), existing.etag);
    else response = await call(collection, 'POST', { id, ...this.event(row, job) });
    // A concurrent insert (409), edit (412) or uncertain delivery stays pending.
    // The next attempt reads the deterministic ID and reconciles the latest DB state.
    if (!response.ok && !(remove && [404, 410].includes(response.status))) {
      throw new Error(`Google予定反映 HTTP ${response.status}`);
    }
  }

  static async run(env, limit = 3) {
    if (!this.configured(env)) return { status: 'not_configured', processed: 0 };
    try { return await this.drain(env, limit); }
    catch { return { status: 'failed', processed: 0 }; }
  }

  static async drain(env, limit) {
    const db = env.BOOKING_DB;
    const calendar = env.GOOGLE_CALENDAR_ID.trim();
    if (calendar === 'primary') return { status: 'failed', processed: 0 };
    const started = Date.now();
    let token;
    let processed = 0;
    // Bound DB + Google subrequests per invocation, including initial backfills.
    for (let index = 0; index < Math.min(5, limit); index++) {
      if (Date.now() - started > 18000) break;
      const now = Date.now();
      const candidate = await db.prepare(`SELECT * FROM google_calendar_sync
        WHERE pending=1 AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,source_type,source_id LIMIT 1`)
        .bind(now, now).first();
      if (!candidate) break;
      const lease = crypto.randomUUID();
      const job = await db.prepare(`UPDATE google_calendar_sync SET lease_token=?,lease_until=?,calendar_id=?
        WHERE source_type=? AND source_id=? AND version=? AND pending=1 AND lease_until<=? RETURNING *`)
        .bind(lease, now + 120000, candidate.calendar_id || calendar,
          candidate.source_type, candidate.source_id, candidate.version, now).first();
      if (!job) continue;
      let error = '';
      try {
        if (job.calendar_id !== calendar) throw new Error('同期先カレンダーIDの変更には移行作業が必要です。');
        token ||= await this.accessToken(env);
        await this.syncJob(db, job, calendar, token);
      } catch (failure) {
        // Persist only our controlled messages; never Google response bodies, keys or contact data.
        error = /^(Google(?:認証|予定取得|予定反映) HTTP \d{3}|Googleサービスアカウントの(?:JSON設定|秘密鍵)を確認してください。|Google認証の応答を確認できません。|同期先の予定を確認できません。|同期先カレンダーIDの変更には移行作業が必要です。)$/.test(failure?.message)
          ? failure.message : 'Googleカレンダーとの通信を完了できませんでした。';
      }
      const next = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7));
      const completed = await db.prepare(`UPDATE google_calendar_sync SET
        pending=CASE WHEN version=? AND ?='' THEN 0 ELSE 1 END,
        attempts=CASE WHEN version=? THEN attempts+1 ELSE attempts END,
        next_attempt_at=CASE WHEN version=? AND ?!='' THEN ? ELSE 0 END,
        last_error=CASE WHEN version=? THEN ? ELSE last_error END,
        synced_at=CASE WHEN version=? AND ?='' THEN ? ELSE synced_at END,
        lease_token='',lease_until=0 WHERE source_type=? AND source_id=? AND lease_token=?`)
        .bind(job.version,error,job.version,job.version,error,next,job.version,error,
          job.version,error,new Date().toISOString(),job.source_type,job.source_id,lease).run();
      if ((completed.meta?.changes ?? completed.changes) === 0) {
        // An expired worker may finish after a replacement worker. Reconcile again
        // rather than trusting either response order or an already-cleared pending flag.
        await db.prepare(`UPDATE google_calendar_sync SET version=version+1,pending=1,next_attempt_at=0
          WHERE source_type=? AND source_id=?`).bind(job.source_type,job.source_id).run();
      }
      processed++;
    }
    return { status: 'complete', processed };
  }

  static async status(env) {
    const rows = await env.BOOKING_DB.prepare(`SELECT pending,COUNT(*) AS count FROM google_calendar_sync GROUP BY pending`).bind().all();
    const failures = await env.BOOKING_DB.prepare(`SELECT COUNT(*) AS count FROM google_calendar_sync WHERE pending=1 AND last_error!=''`).bind().first();
    return { configured: this.configured(env), pending: rows.results.find(r => r.pending === 1)?.count || 0,
      synced: rows.results.find(r => r.pending === 0)?.count || 0, failed: failures.count };
  }
}
