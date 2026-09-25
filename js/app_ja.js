// Owns the Japanese strings and localization behavior used by the website.
class JapaneseCopy {
  constructor(strings) {
    this.strings = strings;
  }

  text(path, values = {}) {
    const value = path.split(".").reduce((item, part) => item && item[part], this.strings);
    if (typeof value !== "string") return path;
    return value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  }

  apply(root = document) {
    root.querySelectorAll("[data-app-ja]").forEach((element) => {
      element.textContent = this.text(element.dataset.appJa);
    });
    root.querySelectorAll("[data-app-ja-attr]").forEach((element) => {
      element.dataset.appJaAttr.split(",").forEach((pair) => {
        const [attribute, path] = pair.split(":");
        if (attribute && path) element.setAttribute(attribute, this.text(path));
      });
    });
  }
}

const japaneseStrings = {
  shopName: "よもん はりきゅう治療院",
  shopBrand: "KISHIN",
  directorName: "佐藤 聖真（サトウ キシン）",
  directorRole: "院長・鍼灸師",
  email: "yomon.harikyu@gmail.com",
  phone: "070-8573-8131",
  phoneLink: "07085738131",
  address: "〒971-8161 福島県いわき市小名浜諏訪町22-3",
  businessHours: "10:00〜19:00（最終受付 18:00）",
  closedDays: "日曜日",
  tagline: "心と体が、\nすっきり軽くなる毎日",
  copyright: "Yomon Harikyu. All rights reserved.",

  navigation: {
    home: "ホーム",
    price: "料金",
    treatment: "施術内容",
    reservation: "予約",
    menuTitle: "メニュー",
    contactTitle: "CONTACT"
  },
  contactLabels: {
    address: "住所",
    director: "院長",
    phone: "電話",
    email: "メール",
    businessHours: "営業時間",
    closedDays: "休院日",
    access: "アクセス"
  },
  actions: {
    book: "予約する",
    call: "電話する",
    skipToContent: "本文へスキップ",
    contactByEmail: "メールで問い合わせる",
    menuOpen: "メニューを開く",
    menuClose: "メニューを閉じる",
    clinicHome: "よもん はりきゅう治療院 ホームへ",
    mainNavigation: "メインメニュー",
    footerNavigation: "フッターメニュー"
  },
  pageMeta: {
    homeTitle: "よもん はりきゅう治療院｜首肩こり・腰痛・不眠に、お一人ずつ体に合った施術",
    homeDescription: "よもん はりきゅう治療院。院長・佐藤聖真（サトウ キシン）が、首肩のこり、腰痛、不眠、冷え性にお一人ずつ体質に合わせた鍼・灸の個別施術を行います。",
    priceTitle: "料金案内｜よもん はりきゅう治療院",
    priceDescription: "よもん はりきゅう治療院の施術料金をご案内します。初回カウンセリング、鍼、鍼と灸、経絡ケアの料金をご確認いただけます。",
    treatmentTitle: "施術内容｜よもん はりきゅう治療院",
    treatmentDescription: "よもん はりきゅう治療院の施術内容をご紹介します。お悩みや体の状態を伺い、鍼・灸・経絡ケアを組み合わせた施術をご案内します。",
    reservationTitle: "ご予約｜よもん はりきゅう治療院",
    reservationDescription: "よもん はりきゅう治療院のWeb予約ページです。メニューと日時を選んでご予約ください。",
    adminTitle: "予約管理｜よもん はりきゅう治療院"
  },
  menus: {
    first: "初回：カウンセリング＋施術 30分",
    acupuncture: "鍼 30分",
    acupunctureMoxa: "鍼＋灸 30分",
    meridian: "経絡ケア 60分"
  },
  prices: {
    first: "¥3,850",
    acupuncture: "¥3,300",
    acupunctureMoxa: "¥3,850",
    meridian: "¥6,600"
  },
  form: {
    menuLabel: "施術メニュー",
    dateLabel: "予約日",
    timeLabel: "予約時間",
    nameLabel: "お名前",
    phoneLabel: "電話番号",
    emailLabel: "メールアドレス",
    required: "必須",
    optional: "任意",
    chooseMenu: "メニューを選択してください",
    bookingDate: "予約日",
    bookingTime: "予約時間",
    customerName: "お名前",
    customerPhone: "電話番号",
    customerEmail: "メールアドレス",
    phonePlaceholder: "例：070-1234-5678",
    dateHelp: "予約可能な日付を選択してください。",
    privacyNotice: "ご入力いただいた情報は、ご予約の受付・確認・連絡に使用します。症状や病歴などの情報はこのフォームでは収集しません。",
    honeypot: "この欄は入力しないでください",
    bookingContact: "ご不明な点は",
    contactOr: "または",
    emailLink: "メール",
    adminLoginLabel: "管理用トークン",
    adminSubmit: "予約を表示",
    adminTokenHelp: "トークンは院長だけが管理し、GitHubや共有チャットに貼らないでください。",
    adminDate: "予約日",
    refresh: "一覧を更新",
    logout: "ログアウト",
    changedDate: "変更後の日付",
    changedStartTime: "変更後の開始時刻"
  },
  booking: {
    communicationError: "通信に失敗しました。時間をおいて再度お試しください。",
    noAvailability: "この日の空き時間はありません。別の日をお選びください。",
    chooseMenuAndDate: "先にメニューと予約日を選択してください。",
    checkingAvailability: "空き時間を確認しています…",
    chooseTime: "ご希望の時間を選択してください。",
    sending: "予約を送信しています…",
    submit: "予約を確定する",
    confirmed: "ご予約が確定しました。予約番号：{bookingNumber}。確認のため、この番号をお控えください。",
    confirmedLineFailed: "ご予約は確定しました（予約番号：{bookingNumber}）。ただし院長へのLINE通知に失敗しました。お急ぎの場合はお電話でご連絡ください。",
    confirmedLineUnconfigured: "ご予約は確定しました（予約番号：{bookingNumber}）。院長へのLINE通知設定はまだ完了していません。",
    dateHelp: "本日から{daysAhead}日先まで選択できます。日曜日は休院日です。"
  },
  admin: {
    noBookings: "この日の予約はありません。",
    communicationError: "通信に失敗しました。",
    statusConfirmed: "確定",
    statusCancelled: "キャンセル済み",
    emailMissing: "未入力",
    notificationSent: "送信済み",
    notificationFailed: "失敗（再送できます）",
    notificationNotConfigured: "未設定",
    notificationPending: "未送信",
    changeDateTime: "日時を変更",
    cancel: "キャンセル",
    confirmCancel: "{bookingNumber} の予約をキャンセルしますか？",
    resendLine: "LINE通知を再送",
    saveDateTime: "日時を保存",
    labelBookingNumber: "予約番号",
    labelMenu: "メニュー",
    labelPhone: "電話番号",
    labelEmail: "メール",
    labelStatus: "状態",
    labelLineNotification: "LINE通知",
    changed: "予約日時を変更しました。",
    cancelled: "予約をキャンセルしました。",
    lineSent: "LINE通知を送信しました。"
  }
};

window.appJa = new JapaneseCopy(japaneseStrings);
