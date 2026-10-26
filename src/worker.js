import { BookingApi } from "./booking_api.js";
import { SiteSeo } from "./site_seo.js";
import { GoogleCalendarSync } from "./google_calendar_sync.js";

class KishinWorker {
  static async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin/calendar-sync') {
      const authError = await BookingApi.requireAdmin(request, env);
      if (authError) return authError;
      if (request.method === 'POST') {
        if (!GoogleCalendarSync.configured(env)) return BookingApi.json(503, { error: 'Googleカレンダーの設定が未完了です。' });
        ctx.waitUntil(GoogleCalendarSync.run(env, 1));
        return BookingApi.json(202, { status: 'accepted' });
      }
      if (request.method === 'GET') return BookingApi.json(200, await GoogleCalendarSync.status(env));
      return BookingApi.json(405, { error: '対応していない操作です。' });
    }
    if (url.pathname.startsWith("/api/")) {
      const response = await BookingApi.handle(request, env);
      if (response.ok && ['POST', 'PUT', 'DELETE'].includes(request.method) && ctx && GoogleCalendarSync.configured(env)) {
        ctx.waitUntil(GoogleCalendarSync.run(env, 1));
      }
      return response;
    }
    return SiteSeo.handle(request, env);
  }
}

export default {
  fetch(request, env, ctx) {
    return KishinWorker.fetch(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(GoogleCalendarSync.run(env, 5));
  }
};
