import { BookingApi } from "./booking_api.js";
import { SiteSeo } from "./site_seo.js";

class KishinWorker {
  static async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return BookingApi.handle(request, env);
    return SiteSeo.handle(request, env);
  }
}

export default {
  fetch(request, env) {
    return KishinWorker.fetch(request, env);
  }
};
