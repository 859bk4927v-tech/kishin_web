async function initializeLineMiniApp() {
  if (!window.liff || !window.liff.isInClient()) return false;

  try {
    await window.liff.init({
      liffId: "2011966875-s5Cau1Zz"
    });
    return true;
  } catch {
    console.error("LINEミニアプリの初期化に失敗しました");
    return false;
  }
}

// 予約時に初期化の完了を待てるようにします。
window.lineMiniAppReady = initializeLineMiniApp();

async function getLineIdTokenForBooking() {
  // 通常のブラウザではLINE情報を付けません。
  if (!window.liff || !window.liff.isInClient()) return "";

  const ready = await window.lineMiniAppReady;
  if (!ready || !window.liff.isLoggedIn()) {
    throw new Error("LINEの予約画面を開き直してください。");
  }

  // 予約する時点でトークンを取得します。
  const token = window.liff.getIDToken();
  if (!token) {
    throw new Error("LINEの本人確認ができません。予約画面を開き直してください。");
  }

  return token;
}
