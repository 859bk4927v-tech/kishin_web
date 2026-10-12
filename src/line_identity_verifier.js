export class LineIdentityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const INVALID_IDENTITY = "LINEの本人確認ができません。LINEの予約画面を開き直してください。";
const UNAVAILABLE = "LINEの本人確認サービスに接続できません。時間をおいて再度お試しください。";

export class LineIdentityVerifier {
  static async verify(idToken, channelId) {
    // Ordinary web bookings have no LINE identity. Never accept a client-supplied user ID.
    if (idToken === undefined || idToken === "") return "";
    if (typeof idToken !== "string" || idToken.length > 8192 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) {
      throw new LineIdentityError(400, INVALID_IDENTITY);
    }
    if (typeof channelId !== "string" || !/^\d{6,20}$/.test(channelId)) {
      throw new LineIdentityError(503, "LINE予約の本人確認設定が完了していません。時間をおいて再度お試しください。");
    }

    let response;
    let identity;
    try {
      response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString(),
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) identity = await response.json();
    } catch {
      // Do not log tokens, upstream response bodies or exception details.
      throw new LineIdentityError(503, UNAVAILABLE);
    }

    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) {
        throw new LineIdentityError(401, INVALID_IDENTITY);
      }
      throw new LineIdentityError(503, UNAVAILABLE);
    }

    // LINE verifies the signature. Also bind its result to our configured channel and expiry.
    const now = Math.floor(Date.now() / 1000);
    if (!identity || identity.iss !== "https://access.line.me" || identity.aud !== channelId ||
        !Number.isInteger(identity.exp) || identity.exp <= now ||
        !Number.isInteger(identity.iat) || identity.iat > now + 60 || identity.iat >= identity.exp ||
        typeof identity.sub !== "string" || !/^U[0-9a-f]{32}$/.test(identity.sub)) {
      throw new LineIdentityError(401, INVALID_IDENTITY);
    }
    return identity.sub;
  }
}
