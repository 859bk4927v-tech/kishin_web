import { BookingApi } from "./booking_api.js";

class KishinWorker {
  static async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return BookingApi.handle(request, env);
    return env.ASSETS.fetch(request);
  }
}

export default {
  fetch(request, env) {
    return KishinWorker.fetch(request, env);
  }
};
