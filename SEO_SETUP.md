# よもん はりきゅう治療院のSEO設定

## 対応した内容

- 各ページ固有のタイトル・説明文。ホームのタイトルには地域名、鍼灸院、夜24時まで営業していることを記載。
- JavaScript実行前から、本文・料金・院長紹介・住所・連絡先・ナビゲーションをHTMLに出力。表示文言の管理元は `public/js/app_ja.js` のまま。
- ホーム・施術内容・料金・予約の正規URLとサイトマップを統一。`.html` 付きURL、末尾の `/`、トップ `/` からは正規ページへ恒久転送。
- 院の構造化データ: 所在地、電話、地図座標、営業時間、金曜休診、施術料金、院長名、Instagram。治療効果や口コミ評価を作り足していない。
- 管理画面・予約完了画面・404ページを検索対象から除外。
- LINEなどでURLを共有したときに使うOGP情報と1200x630のPNG画像。画像の編集用SVGも保存。

## 公開URLが決まったら

1. `wrangler.jsonc` の `vars.SITE_URL` に実際の公開サイトのオリジンを設定する。例のドメインをそのまま使わず、契約したドメインに置き換える。

   ```json
   "vars": {
     "BOOKING_DAYS_AHEAD": "60",
     "SITE_URL": "https://あなたの実際のドメイン"
   }
   ```

   `https://` で始まり、サブディレクトリやクエリを含めない値にする。環境別にvarsを設定する場合は公開環境側にも設定する。

2. 公開前に `npm run build:static`、`npm run check:static`、`npm test` を実行する。通常の `wrangler dev` / `wrangler deploy` では静的HTML生成が自動実行される。
3. 既存のCloudflare公開手順で公開する。公開URLへのアクセスで、HTMLのcanonical・og:url・構造化データが同じ公開ドメインを示すことを確認する。
4. 公開サイトの `/robots.txt` が `Allow: /` を返し、`/sitemap.xml` に4つの正規URLが含まれることを確認する。各URLが転送なしで200を返すことも確認する。
5. Google Search Consoleにサイトを登録・所有権確認し、`https://実際のドメイン/sitemap.xml` を送信する。URL検査でホーム・料金・施術内容・予約を確認し、必要に応じてインデックス登録をリクエストする。
6. リッチリザルトテストで公開ホームの構造化データを確認する。Instagramのプロフィールにも公開サイトURLを登録する。

**SITE_URLが空欄・不正な値の場合、またはアクセス先がそのドメインと異なる場合は、テスト環境としてnoindexと巡回停止を返す。公開前に必ず設定する。** canonicalなどのURLはサーバーから返す時点で絶対URLに変換する。ローカルでもサイトの閲覧・予約動作は継続できる。

`www` あり・なし両方で公開する場合は、Cloudflare側でSITE_URLに指定したホストへの転送を設定する。ローカル確認を妨げないよう、アプリから別ホストへの強制転送は行っていない。

## 公開後に地域検索を育てる

- Googleビジネスプロフィールの所有権確認を行い、実際の院名・住所・電話・営業時間・Webサイト・予約URLを掲載する。サイトと表記を揃え、休診日の変更も更新する。
- 実際の外観・入口・駐車場・施術室・院長の写真を用意し、初めて来院する人が確認できる情報を増やす。
- 実際に受けた質問に基づく説明を追加する。地域名や症状名を隠して詰め込むことはしない。医学的な説明を増やす場合は院長が内容を確認する。
- Search Consoleで「いわき市 鍼灸」「小名浜 鍼灸」などの実際の表示回数・検索語・クリック数を確認し、利用者の疑問に沿って内容を改善する。

SEO設定は検索順位やリッチリザルト表示の保証ではない。ローカル環境だけでは一般のGoogle検索に掲載されず、公開後に巡回・評価される。

## 更新するとき

- 文言・料金・営業時間を変更したら `npm run build:static` でHTMLにも反映する。
- 住所・電話・営業時間・料金を変更する場合は、`scripts/render_static.mjs` の構造化データと予約システムの設定も確認する。
- `public/assets/og-image.svg` は共有画像の編集用。編集後はPNGも書き出し、`og-image.png` を更新する。

## 公式資料

- [Google: JavaScript SEOの基本](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics?hl=ja)
- [Google: 正規URLの指定](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls?hl=ja)
- [Google: ローカルビジネスの構造化データ](https://developers.google.com/search/docs/appearance/structured-data/local-business?hl=ja)
- [Google: サイトマップの作成と送信](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap?hl=ja)
- [リッチリザルトテスト](https://search.google.com/test/rich-results)
- [Google Search Console](https://search.google.com/search-console/)
