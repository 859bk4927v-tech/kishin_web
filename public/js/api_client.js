// Shared JSON transport. Mutating requests are never retried automatically.
class ApiClient {
  static async request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(path, { ...options, headers });
    } catch {
      throw new Error(appJa.text('booking.communicationError'));
    }
    let data;
    try {
      data = await response.json();
    } catch {
      const error = new Error(appJa.text('booking.communicationError'));
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(data?.error || appJa.text('booking.communicationError'));
      error.status = response.status;
      throw error;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(appJa.text('booking.communicationError'));
    }
    return data;
  }
}
