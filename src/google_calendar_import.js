import { BookingService } from './booking_service.js';
import { GoogleCalendarSync } from './google_calendar_sync.js';

export class GoogleCalendarImport {
  static async period(event) {
    if (event.status === 'cancelled' || event.transparency === 'transparent' ||
        ['birthday', 'workingLocation'].includes(event.eventType) ||
        event.attendees?.some(person => person.self && person.responseStatus === 'declined')) return null;
    const source = event.extendedProperties?.private?.kishinSource;
    const match = typeof source === 'string' && source.match(/^(booking|block):(.+)$/);
    if (match && event.id === await GoogleCalendarSync.eventId({source_type:match[1],source_id:match[2]})) return null;
    if (typeof event.id !== 'string' || !event.id || event.id.length > 1024) throw new Error('invalid_event');
    const date = (value, end = false) => {
      if (value?.date) return `${BookingService.parseCalendarDate(value.date)}T00:00:00+09:00`;
      if (typeof value?.dateTime !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value.dateTime) ||
          !Number.isFinite(Date.parse(value.dateTime))) throw new Error('invalid_event');
      const seconds=Date.parse(value.dateTime)/1000;
      return new Date((end ? Math.ceil(seconds) : Math.floor(seconds))*1000+9*3600000).toISOString().slice(0,19)+'+09:00';
    };
    const start = date(event.start), end = date(event.end,true);
    if (end <= start) throw new Error('invalid_event');
    return {id:event.id,start,end,title:typeof event.summary === 'string' ? event.summary.slice(0,200) : 'Googleの予定'};
  }

  static async run(env) {
    if (!GoogleCalendarSync.configured(env)) return {status:'not_configured'};
    try {
      const started = Date.now();
      for (let attempt=0; attempt<2; attempt++) {
        const result = await this.importPages(env);
        if (result.status !== 'complete' || attempt === 1 || Date.now()-started>5000) return result;
        const state = await env.BOOKING_DB.prepare(`SELECT requested_revision,completed_revision
          FROM google_calendar_import WHERE calendar_id=?`).bind(env.GOOGLE_CALENDAR_ID.trim()).first();
        if (state.requested_revision === state.completed_revision) return result;
        // A notification arrived while reading Google. Recheck once promptly;
        // remaining changes still reconcile through the five-minute cron.
      }
    }
    catch { return {status:'failed'}; }
  }

  static async importPages(env) {
    const db=env.BOOKING_DB, calendar=env.GOOGLE_CALENDAR_ID.trim();
    if (calendar === 'primary') return {status:'failed'};
    await db.prepare('INSERT OR IGNORE INTO google_calendar_import(calendar_id) VALUES(?)').bind(calendar).run();
    const now=Date.now(), lease=crypto.randomUUID();
    let state=await db.prepare(`UPDATE google_calendar_import SET lease_token=?,lease_until=?
      WHERE calendar_id=? AND lease_until<=? RETURNING *`).bind(lease,now+120000,calendar,now).first();
    if (!state) return {status:'busy'};
    try {
      if (!state.run_id || now-state.started_at>86400000) {
        const days=Number(env.BOOKING_DAYS_AHEAD);
        const ahead=Number.isInteger(days) && days>0 && days<=365 ? days : 60;
        const today=BookingService.todayJst();
        state={...state,run_id:crypto.randomUUID(),page_token:'',window_start:`${today}T00:00:00+09:00`,
          window_end:`${BookingService.addDays(today,ahead+2)}T00:00:00+09:00`};
        await db.batch([
          db.prepare(`DELETE FROM google_calendar_import_stage WHERE calendar_id=? AND
            EXISTS(SELECT 1 FROM google_calendar_import WHERE calendar_id=? AND lease_token=?)`).bind(calendar,calendar,lease),
          db.prepare(`UPDATE google_calendar_import SET run_id=?,page_token='',window_start=?,window_end=?,started_at=?,run_revision=requested_revision
            WHERE calendar_id=? AND lease_token=?`).bind(state.run_id,state.window_start,state.window_end,now,calendar,lease)
        ]);
      }
      const token=await GoogleCalendarSync.accessToken(env);
      // Two pages per invocation; pagination resumes on the next cron without publishing partial data.
      for (let page=0;page<2;page++) {
        const url=new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`);
        url.search=new URLSearchParams({singleEvents:'true',showDeleted:'false',timeMin:state.window_start,
          timeMax:state.window_end,timeZone:'Asia/Tokyo',maxResults:'250',
          fields:'kind,items(id,status,transparency,eventType,start,end,summary,extendedProperties/private,attendees(self,responseStatus)),nextPageToken',
          ...(state.page_token ? {pageToken:state.page_token} : {})}).toString();
        const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(8000)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data=await response.json();
        if (data.kind !== 'calendar#events' || (data.items !== undefined && !Array.isArray(data.items)) ||
            (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')) throw new Error('invalid_response');
        const periods=[];
        for (const event of data.items || []) {
          const period=await this.period(event);
          if (period && period.start<state.window_end && period.end>state.window_start) periods.push(period);
        }
        const next=data.nextPageToken || '';
        if (next && next === state.page_token) throw new Error('invalid_response');
        await db.batch([
          db.prepare(`INSERT OR REPLACE INTO google_calendar_import_stage(calendar_id,run_id,event_id,start_at,end_at,title)
            SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.start'),json_extract(value,'$.end'),json_extract(value,'$.title')
            FROM json_each(?) WHERE EXISTS(SELECT 1 FROM google_calendar_import WHERE calendar_id=? AND lease_token=? AND run_id=?)`)
            .bind(calendar,state.run_id,JSON.stringify(periods),calendar,lease,state.run_id),
          db.prepare('UPDATE google_calendar_import SET page_token=? WHERE calendar_id=? AND lease_token=? AND run_id=?')
            .bind(next,calendar,lease,state.run_id)
        ]);
        if (!next) {
          const guard='EXISTS(SELECT 1 FROM google_calendar_import WHERE calendar_id=? AND lease_token=? AND run_id=?)';
          const published=await db.batch([
            db.prepare(`DELETE FROM google_calendar_busy WHERE calendar_id=? AND ${guard}`).bind(calendar,calendar,lease,state.run_id),
            db.prepare(`INSERT INTO google_calendar_busy(calendar_id,event_id,start_at,end_at,title)
              SELECT calendar_id,event_id,start_at,end_at,title FROM google_calendar_import_stage WHERE calendar_id=? AND run_id=? AND ${guard}`)
              .bind(calendar,state.run_id,calendar,lease,state.run_id),
            db.prepare(`UPDATE google_calendar_import SET run_id='',page_token='',synced_at=?,last_error='',lease_token='',lease_until=0,completed_revision=run_revision
              WHERE calendar_id=? AND lease_token=? AND run_id=?`).bind(new Date().toISOString(),calendar,lease,state.run_id)
          ]);
          if ((published[2]?.meta?.changes ?? published[2]?.changes) !== 1) return {status:'superseded'};
          // Old runs have separate IDs, so late cleanup cannot delete a newer import.
          await db.prepare('DELETE FROM google_calendar_import_stage WHERE calendar_id=? AND run_id=?').bind(calendar,state.run_id).run();
          return {status:'complete'};
        }
        state.page_token=next;
        if (Date.now()-now>18000) break;
      }
      await db.prepare("UPDATE google_calendar_import SET lease_token='',lease_until=0 WHERE calendar_id=? AND lease_token=?")
        .bind(calendar,lease).run();
      return {status:'pending'};
    } catch (error) {
      const reason=/^HTTP \d{3}$/.test(error.message) ? error.message : '取得を完了できませんでした';
      await db.prepare(`UPDATE google_calendar_import SET last_error=?,lease_token='',lease_until=0,
        run_id='',page_token='' WHERE calendar_id=? AND lease_token=?`)
        .bind(`Google予定取込: ${reason}`,calendar,lease).run();
      return {status:'failed'};
    }
  }

  static async status(env) {
    const calendar=env.GOOGLE_CALENDAR_ID?.trim() || '';
    const state=await env.BOOKING_DB.prepare('SELECT synced_at,last_error,run_id FROM google_calendar_import WHERE calendar_id=?').bind(calendar).first();
    const count=await env.BOOKING_DB.prepare('SELECT COUNT(*) AS count FROM google_calendar_busy WHERE calendar_id=?').bind(calendar).first();
    return {syncedAt:state?.synced_at || '',error:state?.last_error || '',inProgress:!!state?.run_id,count:count.count};
  }
}
