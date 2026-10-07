// Owns the Japanese strings and localization behavior used by the website.
class JapaneseCopy {
  constructor(strings) {
    this.strings = strings;
  }

  resolve(path, values = {}) {
    const value = path.split(".").reduce((item, part) => item && item[part], this.strings);
    if (typeof value !== "string") return path;
    return value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  }

  format(value) {
    return String(value).replace(/\s*([:/])\s*/g, " $1 ");
  }

  text(path, values = {}) {
    return this.format(this.resolve(path, values));
  }

  attribute(path, attribute) {
    const value = this.resolve(path);
    return ["href", "src", "action"].includes(attribute) ? value : this.format(value);
  }

  apply(root = document) {
    root.querySelectorAll("[data-app-ja]").forEach((element) => {
      element.textContent = this.text(element.dataset.appJa);
    });
    root.querySelectorAll("[data-app-ja-attr]").forEach((element) => {
      element.dataset.appJaAttr.split(",").forEach((pair) => {
        const [attribute, path] = pair.split(":");
        if (attribute && path) element.setAttribute(attribute, this.attribute(path, attribute));
      });
    });
  }
}

const japaneseStrings = {
  shopName: "よもん はりきゅう治療院",
  headerDescription: "いわき市小名浜の地域密着鍼灸院",
  directorName: "佐藤 聖真(サトウ キシン)",
  directorRole: "院長・鍼灸師",
  email: "yomon.harikyu@gmail.com",
  get emailHref() { return `mailto:${this.email}`; },
  phone: "070-8573-8131",
  phoneLink: "07085738131",
  get phoneHref() { return `tel:${this.phoneLink}`; },
  address: "〒971-8161 福島県いわき市小名浜諏訪町22-3",
  businessHours: "9:00~24:00",
  closedDays: "金曜日",
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
    closedDays: "休診日",
    access: "駐車場"
  },
  actions: {
    book: "予約する",
    call: "電話する",
    skipToContent: "本文へスキップ",
    contactByEmail: "メールで問い合わせる",
    clinicHome: "よもん はりきゅう治療院 ホームへ",
    mainNavigation: "メインメニュー",
    footerNavigation: "フッターメニュー"
  },
  pageMeta: {
    homeTitle: "いわき市小名浜の鍼灸院|夜24時まで よもん はりきゅう治療院",
    homeDescription: "福島県いわき市小名浜のよもん はりきゅう治療院。9:00~24:00まで営業、金曜休診。仕事帰りや土日にも通えます。カウンセリングで首・肩の痛み、腰痛・ギックリ腰、不眠などのお悩みを確認し、鍼・灸・経絡ケアをご案内します。",
    priceTitle: "鍼灸の料金|いわき市小名浜 よもん はりきゅう治療院",
    priceDescription: "いわき市小名浜、よもん はりきゅう治療院の施術料金。初診はカウンセリング20分と施術60分で7,000円。2回目以降は施術60分6,000円、90分9,000円です。",
    treatmentTitle: "鍼灸・経絡ケアの施術内容|いわき市小名浜 よもん",
    treatmentDescription: "いわき市小名浜のよもん はりきゅう治療院で行う鍼・灸・経絡ケアをご紹介します。カウンセリングでお悩みや体の状態、ご希望を確認し、施術内容をご案内します。",
    reservationTitle: "Web予約|いわき市小名浜 よもん はりきゅう治療院",
    reservationDescription: "いわき市小名浜、よもん はりきゅう治療院のWeb予約。営業時間は9:00~24:00、金曜休診。仕事帰りの時間も、メニューとカレンダーの空き日時を選んでご予約いただけます。",
    adminTitle: "予約管理|よもん はりきゅう治療院"
  },
  homePage: {
    heroLabel: "よもん はりきゅう治療院の紹介",
    heroLead: "首肩腰の痛み・眼精疲労・不眠などの自律神経の乱れに、一人ひとり丁寧に向き合う個別施術。体の不調で、ずっと抱えているお悩みはお気軽にご相談ください。",
    hoursHeadline: "仕事帰りにも、夜24時まで。",
    hoursDetail: "9:00~24:00 / 金曜休診",
    reserveLink: "カレンダーから予約する",
    priceLink: "料金を見る",
    greetingEyebrow: "Greeting",
    greetingTitleLead: "はじめまして、",
    greetingTitleSuffix: "です",
    greetingBody: "真心と誠実さを大切に、一人ひとりに寄り添う安心・安全な鍼灸治療をご提供します。当院では丁寧な問診を行い、その日の体調や症状に合わせて鍼の太さや深さ、お灸の熱さを細かく調整し、お悩みに最適な治療内容を事前にしっかり説明した上で施術を致します。",
    greetingLearning: "院長は毎週東京で最新の鍼灸技術を学び、日々の施術に取り入れています。",
    greetingClosing: "長年つらいと感じている首肩や腰の不調、言葉にしがたいお体の違和感なども、どうか遠慮なくご相談ください。皆さまのご来院を心よりお待ちしております。",
    instagramAccount: "Instagram : @yomon_harikyu",
    instagramHref: "https://www.instagram.com/yomon_harikyu/",
    instagramLinkLabel: "Instagram @yomon_harikyu を開く(新しいタブ)",
    symptomEyebrow: "Symptom",
    symptomTitle: "こんなお悩みはありませんか?",
    symptomLead: "気になるお悩みを選ぶと、症状の説明と予約フォームへ進みます。",
    symptomDetailsLink: "詳しく見て予約する",
    bookingEyebrow: "Reservation",
    bookingTitle: "仕事が終わってからでも、通えます",
    bookingLead: "金曜日を除き、土日も9:00~24:00まで。日中は時間を取りにくい方も、ご都合に合わせてご予約いただけます。カレンダーから夜の空き時間もご確認ください。",
    featuresEyebrow: "Our care",
    featuresTitle: "施術で大切にしていること",
    introDetailsLink: "施術内容を詳しく見る →",
    features: [
      { title: "安心安全な鍼灸治療のご提供" },
      { title: "エビデンスに基づいた鍼灸治療" },
      { title: "患者様の生活背景に沿ったご提案" },
      { title: "丁寧で誠実な問診" },
      { title: "一人ひとりに合わせた施術" }
    ],
    symptoms: {
      neckShoulderTitle: "首・肩の痛み・眼精疲労",
      neckShoulderDescription: "首や肩の痛み、目の疲れや重だるさが気になる方へ。カウンセリングでつらくなる場面や経過を確認し、体の状態に合わせて施術します。",
      backPainTitle: "腰痛・ギックリ腰",
      backPainDescription: "座り仕事や立ち仕事、運動後などに腰の痛みが出る方へ。カウンセリングで痛む場所や動き、経過を確認し、無理のない施術をご案内します。",
      sleepTitle: "不眠・眠りの質",
      sleepDescription: "寝つきが悪い、夜中に目が覚める、眠っても休まらないなど、眠りのお悩みをご相談ください。カウンセリングで睡眠や体調の様子を確認し、施術内容を考えます。",
      coldTitle: "冷え性・婦人科系の悩み",
      coldDescription: "手足の冷えや更年期障害、PMSなどの月経に伴う不調、妊活中のお悩みをご相談ください。丁寧にカウンセリングを行い、施術内容をご案内します。",
      digestionTitle: "胃腸の不調",
      digestionDescription: "胃痛や胃もたれ、便秘などが気になる方へ。胃腸障害は複数の原因があるためカウンセリングをしっかり行い、体調に合わせた施術をご案内します。",
      muscleTitle: "スポーツ傷害",
      muscleDescription: "運動中や運動後の関節・筋肉の痛み、繰り返す違和感などをご相談ください。カウンセリングで競技や動作、痛みの経過を確認し、施術内容を考えます。"
    },
    flowEyebrow: "Flow",
    flowTitle: "当日の流れ",
    flowSteps: [
      ["01", "オンライン予約", "空き日カレンダーから日時を選んでご予約。完了画面に表示される予約内容を保存し、ご来院ください。"],
      ["02", "カウンセリング", "カウンセリングでは、不調の状態、生活習慣、既往歴などを確認します。ご不安な点は、ぜひお聞かせください。"],
      ["03", "施術", "状態に合わせて、鍼・灸・経絡ケアなど最適なアプローチを選ばせていただきます。"],
      ["04", "セルフケアの案内", "再発を防ぐための生活習慣の改善点をご説明。状態が変わったら、いつでもご相談を。"]
    ],
    priceEyebrow: "Price List",
    priceTitle: "料金",
    priceTaxNote: "すべて税込価格です。初診はカウンセリング20分と施術60分で計80分です。",
    priceDetailsLink: "料金表を詳しく見る",
    accessEyebrow: "Access",
    accessTitle: "アクセス",
    parkingAvailable: "有",
    mapFrameTitle: "Googleマップ:よもん はりきゅう治療院(福島県いわき市小名浜諏訪町22-3)",
    mapDirectionsLink: "地図でルートを確認する →",
    mapDirectionsHref: "https://www.google.com/maps/search/?api=1&query=%E3%80%92971-8161%20%E7%A6%8F%E5%B3%B6%E7%9C%8C%E3%81%84%E3%82%8F%E3%81%8D%E5%B8%82%E5%B0%8F%E5%90%8D%E6%B5%9C%E8%AB%8F%E8%A8%AA%E7%94%BA22-3"
  },
  pricePage: {
    heroEyebrow: "Price List",
    title: "施術料金",
    lead: "初診は20分のカウンセリングと60分の施術。2回目以降は60分と90分からお選びいただけます。料金について気になることがあれば、ご予約前にお気軽にお問い合わせください。",
    menuEyebrow: "Menu",
    listTitle: "料金表",
    tableLabel: "施術料金(税込)",
    taxNote: "表示価格はすべて税込です。",
    paymentHeading: "お支払い方法",
    paymentCashOnly: "お支払いは現金のみです",
    paymentInstructions: "ご来院の際は現金をご用意ください。",
    reservationLink: "予約ページへ進む",
    contactEmailLink: "メールで問い合わせる"
  },
  treatmentPage: {
    heroEyebrow: "Treatment",
    title: "一人ひとりの体に合わせた施術",
    lead: "カウンセリングでお悩みや生活習慣、その日の体の状態を丁寧に確認し、鍼・灸・経絡ケアなどから施術内容をご案内します。気になることや不安なことも、まずはお聞かせください。",
    menuEyebrow: "Menu",
    menuTitle: "施術メニュー",
    menus: {
      acupunctureTitle: "鍼(はり)",
      acupunctureDescription: "お体の状態や気になる箇所を確認しながら行います。刺激へのご希望や不安があれば、施術前にご相談ください。",
      moxaTitle: "灸(きゅう)",
      moxaDescription: "カウンセリングで冷えやこわばりなどのお悩みを確認し、状態に合わせてご提案します。熱さが苦手な方も事前にお知らせください。",
      combinationTitle: "鍼+灸",
      combinationDescription: "鍼と灸を組み合わせた施術です。お悩みや体の反応を見ながら、無理のない内容をご案内します。",
      meridianTitle: "経絡ケア",
      meridianDescription: "全身の状態を確認しながら行うケアです。気になる不調だけでなく、日々の過ごし方や体調の変化もお聞かせください。"
    },
    visitEyebrow: "Your Visit",
    visitTitle: "施術の流れ",
    visitSteps: [
      ["01", "カウンセリング", "お困りの症状や生活習慣、これまでの経過などを確認します。"],
      ["02", "施術内容をご説明", "体の状態を確認し、施術の内容や進め方をご説明します。不安やご希望も遠慮なくお伝えください。"],
      ["03", "状態に合わせて施術", "ご相談した内容に沿って鍼・灸・経絡ケアなどを行います。"],
      ["04", "セルフケアをご案内", "施術後の状態を確認し、日常生活で気をつけたいことなどをご案内します。"]
    ],
    infoEyebrow: "Information",
    infoTitle: "料金・ご予約",
    guideNote: "各メニューの所要時間と料金は、料金ページをご確認ください。施術内容について迷う場合は、ご予約前のお問い合わせも承ります。",
    priceLink: "料金を見る",
    contactEmailLink: "メールで問い合わせる"
  },
  reservationPage: {
    heroEyebrow: "Reservation",
    title: "Web予約",
    lead: "メニューとご希望の日時を選び、お客様情報を入力してください。営業時間は9:00~24:00、金曜日は休診日です。予約は送信後に確定します。",
    formEyebrow: "Book a Visit",
    formTitle: "ご予約内容",
    contactSentenceEnd: "でお問い合わせください。",
    adminManagementLink: "院長用 予約管理"
  },
  menus: {
    firstVisit: "初診 : カウンセリング20分 + 施術60分",
    followup60: "2回目以降 : 施術60分",
    followup90: "2回目以降 : 施術90分"
  },
  prices: {
    firstVisit: "¥7,000",
    followup60: "¥6,000",
    followup90: "¥9,000"
  },
  form: {
    menuLabel: "施術メニュー",
    dateLabel: "予約日",
    timeLabel: "予約時間",
    nameLabel: "お名前",
    phoneLabel: "電話番号",
    emailLabel: "メールアドレス",
    emailHelp: "ご連絡用の任意項目です。予約確認メールは自動送信されません。",
    required: "必須",
    optional: "任意",
    chooseMenu: "メニューを選択してください",
    bookingDate: "予約日",
    bookingTime: "予約時間",
    customerName: "お名前",
    customerPhone: "電話番号",
    customerEmail: "メールアドレス",
    phonePlaceholder: "例 : 070-1234-5678",
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
    confirmed: "ご予約が確定しました。予約番号:{bookingNumber}。確認のため、この番号をお控えください。",
    confirmedLineFailed: "ご予約は確定しました(予約番号:{bookingNumber})。ただし院長へのLINE通知に失敗しました。お急ぎの場合はお電話でご連絡ください。",
    confirmedLineUnconfigured: "ご予約は確定しました(予約番号:{bookingNumber})。院長へのLINE通知設定はまだ完了していません。",
    receiptReminder: "現在、SMS・メールで予約内容を自動送信していません。この画面をスクリーンショットするか、予約番号・日時などをお控えください。",
    receiptLineFailed: "予約は確定しています。ただし院への予約通知に失敗しました。お急ぎの場合はお電話でご連絡ください。",
    receiptLineUnconfigured: "予約は確定しています。院への予約通知はまだ設定されていません。",
    receiptLinePending: "予約は確定しています。院への予約通知は未送信です。",
    dateHelp: "本日から{daysAhead}日先まで選択できます。9:00~24:00、金曜休診。最終開始は初診と90分施術が22:30、60分施術が23:00です。"
  },
  admin: {
    noBookings: "この日の予約はありません。",
    communicationError: "通信に失敗しました。",
    statusConfirmed: "確定",
    statusCancelled: "キャンセル済み",
    emailMissing: "未入力",
    notificationSent: "送信済み",
    notificationFailed: "失敗(再送できます)",
    notificationNotConfigured: "未設定",
    notificationPending: "未送信",
    changeDateTime: "日時を変更",
    cancel: "キャンセル",
    confirmCancel: "{bookingNumber} の予約をキャンセルしますか?",
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
