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
    access: "駐車場"
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
  homePage: {
    heroLabel: "よもん はりきゅう治療院の紹介",
    heroLead: "首肩腰の痛み・眼精疲労・不眠などの自律神経の乱れに、お一人ずつ丁寧に向き合う個別施術。体の不調で、ずっと抱えているお悩みはお気軽にご相談ください。",
    reserveLink: "カレンダーから予約する",
    priceLink: "料金を見る",
    greetingEyebrow: "Greeting",
    greetingTitleLead: "はじめまして、",
    greetingTitleSuffix: "です",
    greetingBody: "体には、自らを修復する智慧があると私たちは考えています。画一的な施術を施すのではなく、まずはおつらい箇所や生活習慣、お悩みを丁寧にお伺いしたうえで、鍼・灸をはじめとする最適なアプローチを、お一人ずつの体質に合わせて選んでいきます。",
    greetingClosing: "長年つらいと感じている首肩や腰の不調、言葉にしがたいお体の違和感なども、どうか遠慮なくご相談ください。皆さまのご来院を心よりお待ちしております。",
    photoAlt: "施術者の写真（予定）",
    introMonogram: "よもん心",
    photoNote: "写真掲載予定",
    symptomEyebrow: "Symptom",
    symptomTitle: "こんなお悩みはありませんか？",
    symptomLead: "気になるお悩みを選ぶと、症状の説明と予約フォームへ進みます。",
    symptomDetailsLink: "予約へ進む →",
    bookingEyebrow: "Reservation",
    bookingTitle: "お悩みを、まずはお聞かせください",
    bookingLead: "メニューとご希望の日時を選んでご予約いただけます。施術へのご希望や不安は、ご来院時にお聞かせください。",
    featuresEyebrow: "Our care",
    featuresTitle: "施術で大切にしていること",
    introDetailsLink: "施術内容を詳しく見る →",
    features: [
      { title: "お話を丁寧に伺う", description: "気になる箇所だけでなく、生活習慣や日々のお悩みもお聞きします。" },
      { title: "一人ひとりに合わせる", description: "お体の状態やご希望を伺い、鍼・灸・経絡ケアから施術内容をご案内します。" },
      { title: "日々の過ごし方も一緒に考える", description: "施術後は、ご自宅で取り入れられるセルフケアや生活習慣の工夫をお伝えします。" }
    ],
    symptoms: {
      neckShoulderTitle: "首・肩の痛み・眼精疲労",
      neckShoulderDescription: "首や肩の痛み、目の疲れや重だるさが気になる方へ。つらくなる場面や経過を伺い、体の状態に合わせて施術します。",
      backPainTitle: "腰痛",
      backPainDescription: "座り仕事や立ち仕事、運動後などに腰の痛みが出る方へ。痛む場所や動き、経過を伺い、無理のない施術をご案内します。",
      sleepTitle: "不眠・眠りの質",
      sleepDescription: "寝つきが悪い、夜中に目が覚める、眠っても休まらないなど、眠りのお悩みをご相談ください。睡眠や体調の様子を伺い、施術内容を考えます。",
      coldTitle: "冷え性・婦人科系の悩み",
      coldDescription: "手足の冷えや更年期障害、PMSなどの月経に伴う不調、妊活中のお悩みをご相談ください。お話を丁寧に伺い、施術内容をご案内します。",
      digestionTitle: "胃腸の不調",
      digestionDescription: "胃痛や胃もたれ、便秘などが気になる方へ。胃腸障害は複数の原因があるためカウンセリングをしっかり行い、体調に合わせた施術をご案内します。",
      muscleTitle: "スポーツ傷害",
      muscleDescription: "運動中や運動後の関節・筋肉の痛み、繰り返す違和感などをご相談ください。競技や動作、痛みの経過を伺い、施術内容を考えます。"
    },
    flowEyebrow: "Flow",
    flowTitle: "当日の流れ",
    flowSteps: [
      ["01", "オンライン予約", "空き日カレンダーから日時を選んでご予約。予約を受け付けると、LINEで通知します。"],
      ["02", "カウンセリング", "不調の状態、生活習慣、既往歴などをゆっくり伺います。ご不安な点は、ぜひお聞かせください。"],
      ["03", "施術", "状態に合わせて、鍼・灸・経絡ケアなど最適なアプローチを選ばせていただきます。"],
      ["04", "セルフケアの案内", "再発を防ぐための生活習慣の改善点をご説明。状態が変わったら、いつでもご相談を。"]
    ],
    priceEyebrow: "Price List",
    priceTitle: "料金（一部）",
    priceTaxNote: "すべて税込価格です。メニューの詳細は料金表のページでご確認ください。",
    priceDetailsLink: "料金表を詳しく見る",
    accessEyebrow: "Access",
    accessTitle: "アクセス",
    parkingAvailable: "有",
    mapFrameTitle: "Googleマップ：よもん はりきゅう治療院（福島県いわき市小名浜諏訪町22-3）",
    mapDirectionsLink: "地図でルートを確認する →",
    mapDirectionsHref: "https://www.google.com/maps/search/?api=1&query=%E3%80%92971-8161%20%E7%A6%8F%E5%B3%B6%E7%9C%8C%E3%81%84%E3%82%8F%E3%81%8D%E5%B8%82%E5%B0%8F%E5%90%8D%E6%B5%9C%E8%AB%8F%E8%A8%AA%E7%94%BA22-3"
  },
  pricePage: {
    heroEyebrow: "Price List",
    title: "施術料金",
    lead: "お一人ずつのお悩みや体の状態を伺い、施術内容をご案内します。料金について気になることがあれば、ご予約前にお気軽にお問い合わせください。",
    menuEyebrow: "Menu",
    listTitle: "料金表",
    tableLabel: "施術料金（税込）",
    taxNote: "表示価格はすべて税込です。",
    paymentHeading: "お支払い方法",
    paymentCashOnly: "お支払いは現金のみです",
    paymentInstructions: "ご来院の際は現金をご用意ください。",
    reservationLink: "予約ページへ進む",
    contactEmailLink: "メールで問い合わせる"
  },
  treatmentPage: {
    heroEyebrow: "Treatment",
    title: "お一人ずつの体に合わせた施術",
    lead: "お悩みや生活習慣、その日の体の状態を丁寧に伺い、鍼・灸・経絡ケアなどから施術内容をご案内します。気になることや不安なことも、まずはお聞かせください。",
    menuEyebrow: "Menu",
    menuTitle: "施術メニュー",
    menus: {
      acupunctureTitle: "鍼（はり）",
      acupunctureDescription: "お体の状態や気になる箇所を確認しながら行います。刺激へのご希望や不安があれば、施術前にご相談ください。",
      moxaTitle: "灸（きゅう）",
      moxaDescription: "冷えやこわばりなどのお悩みを伺い、状態に合わせてご提案します。熱さが苦手な方も事前にお知らせください。",
      combinationTitle: "鍼＋灸",
      combinationDescription: "鍼と灸を組み合わせた施術です。お悩みや体の反応を見ながら、無理のない内容をご案内します。",
      meridianTitle: "経絡ケア",
      meridianDescription: "全身の状態を確認しながら行うケアです。気になる不調だけでなく、日々の過ごし方や体調の変化もお聞かせください。"
    },
    visitEyebrow: "Your Visit",
    visitTitle: "施術の流れ",
    visitSteps: [
      ["01", "お話を伺います", "お困りの症状や生活習慣、これまでの経過などを確認します。"],
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
    lead: "メニューとご希望の日時を選び、お客様情報を入力してください。予約は送信後に確定します。日曜日は休院日です。",
    formEyebrow: "Book a Visit",
    formTitle: "ご予約内容",
    contactSentenceEnd: "でお問い合わせください。",
    adminManagementLink: "院長用 予約管理"
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
