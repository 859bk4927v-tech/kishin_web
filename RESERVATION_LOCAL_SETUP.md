# Cloudflare Workers＋D1で予約機能を動かす

## 前提

- Node.js と npm がインストールされていること
- Cloudflare アカウントは、ローカル動作確認には不要。本番デプロイ時に必要
- 以前の `data/bookings.sqlite3` はローカル試作データです。D1へ自動移行しません

## ローカル準備

1. プロジェクトのルートへ移動します。

   ```bash
   cd /Users/takaesu/Projects/webApp/kishin
   ```

2. 依存パッケージをインストールします。

   ```bash
   npm install
   ```

3. 開発用の秘密情報ファイルを作ります。

   ```bash
   cp .dev.vars.example .dev.vars
   ```

4. `ADMIN_TOKEN` に十分長いランダム値を設定します。実際の値をGitHubやチャットに貼らないでください。

5. ローカルD1データベースにテーブルを作ります。

   ```bash
   npm run db:migrate:local
   ```

## 起動

```bash
npm run dev
```

- ホーム: `http://127.0.0.1:8000/`
- 予約: `http://127.0.0.1:8000/page/customer_page/reservation_page.html`
- 院長用管理: `http://127.0.0.1:8000/page/admin/admin_page.html`

ローカルのD1データは `.wrangler/state/` に保存されます。終了はターミナルで `Control + C` です。

## LINE通知をローカルで試す

Messaging APIの設定後、`.dev.vars` にLINEのチャネルアクセストークンと院長のLINEユーザーIDを設定してWranglerを再起動します。

```dotenv
LINE_CHANNEL_ACCESS_TOKEN=発行したChannelAccessToken
LINE_OWNER_USER_ID=院長のLINEユーザーID
```

`.dev.vars` はGit管理対象外です。実際のトークンをソースコードやブラウザ側JavaScriptに書かないでください。

## Cloudflareへデプロイする準備

1. Wrangler CLIでCloudflareへログインします。

   ```bash
   npx wrangler login
   ```

2. Cloudflareへログインした状態でD1データベースを作成します。

   ```bash
   npm run db:create
   ```

3. 出力されたDatabase IDを `wrangler.jsonc` の `d1_databases[0].database_id` に設定します。
4. 本番D1にテーブルを作成します。

   ```bash
   npm run db:migrate:remote
   ```

5. 本番用の管理トークンを登録します。

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

6. Messaging APIを使う場合は、次の秘密情報も登録します。

   ```bash
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put LINE_OWNER_USER_ID
   ```

7. Workersへデプロイします。

   ```bash
   npm run deploy
   ```

デプロイ後に表示される `workers.dev` URLで、予約・管理画面・LINE通知を確認します。独自ドメインは後からCloudflareに設定できます。

## LINEからの予約について

LINEミニアプリ内で予約画面を開き、予約時にLIFF SDKの `getIDToken()` で取得したIDトークンを送信します。サーバーはLINEの `POST https://api.line.me/oauth2/v2.1/verify` にトークンと設定済みのチャネルIDを送り、本人確認が成功した場合だけ `bookings.line_user_id` にユーザーIDを保存します。IDトークンそのものはDB・予約完了画面・ログに保存しません。

- `wrangler.jsonc` の `vars.LINE_MINIAPP_CHANNEL_ID` は、**本番用ミニアプリのチャネルID** `2011966875` です。秘密情報ではありません。LIFF ID全体やMessaging APIのチャネルIDとは異なります。
- フロント側のLIFF IDは `2011966875-s5Cau1Zz` です。開発用・審査用へ切り替える場合も、フロント側のLIFF IDとサーバー側のチャネルIDを両方そろえてください。クライアントが送ったチャネルIDは信用しません。
- 通常のブラウザからの予約はIDトークンなしで従来どおり受け付けます。トークンを送った場合、検証失敗時に通常予約へ自動的に切り替えることはありません。
- 同じ予約の再送信で、別のLINEアカウントにひも付け直すことはありません。
- 院長への既存LINE通知は継続します。新規のLINE予約では、予約保存後に患者さま本人へ日時・メニュー・予約番号も送信します。自動メール送信は未実装です。

### 患者さま向けLINE通知の送信モジュール

`src/patient_line_notifier.js` の `PatientLineNotifier.sendAndRecord(db, bookingId, env)` に、保存済み予約のIDを渡します。本人確認済みの `line_user_id` を送信先とし、既存の `LINE_CHANNEL_ACCESS_TOKEN` で日時・メニュー・予約番号を送ります。院長用の送信先や通知状態には変更を加えません。通常のWeb予約（LINEユーザーIDなし）は `skipped` になります。

予約APIは新規予約の保存・本人情報の照合・確定状態の確認が成功した後、院長向け通知に続けてこのモジュールを呼び出します。それぞれの通知失敗は独立して処理し、保存済みの予約は成功として返します。LINEユーザーIDなしのWeb予約では患者さま向け通知を呼び出しません。同じ予約リクエストの再送時は、保存済み予約と通知状態を返し、通知を再送しません。予約競合・キャンセル済み予約・別のLINEアカウントからの再送も通知対象になりません。

予約APIの `notificationStatus` は従来どおり院長向けです。患者さま向けには別の `patientLineNotificationStatus` を返します。通常のWeb予約は `skipped` です。予約完了画面の既存表示は変更しておらず、いずれの通知状態でも患者さまへの到達や既読を保証する表示は追加していません。自動メール送信も未実装です。

使用前に `0004_add_patient_line_notification.sql` を適用します。追加する5列は患者さま向けの通知状態・エラー・再送キー・キー作成日時・送信内容です。既存予約と院長向け通知の値は保持します。最初の通信より前に送信先・本文・キーをDBに保存することで、並行呼び出しや通信障害後の再試行でも同じ内容とキーを使います。24時間を過ぎたキーは作り直さず送信を止めます。

戻り値は `{ status, error }` です。`sent` はLINE APIが受理した状態で、実際の配信・既読を保証しません。`failed` は通信・保存の失敗、`not_configured` はトークン未設定、`rejected` はLINEの400番台エラーです（受理済みを示すヘッダー付き409は `sent`）。`rejected` と `sent` は再送しません。`failed` の再試行は同じ関数を呼び出しますが、自動再試行や予約変更通知は実装していません。

公式アカウントとミニアプリは同じプロバイダーに置き、テスト用LINEで公式アカウントを友だち追加しておきます。重複防止は [LINE公式の再試行仕様](https://developers.line.biz/ja/docs/messaging-api/retrying-api-request/) に従います。

### 既存サイトにこの変更を反映する順番

まずローカルで追加マイグレーションとテストを実行します。既存予約を削除する操作はありません。

```bash
npm run db:migrate:local
npm run build:static
npm test
npm run check:static
```

本番へ反映するときは、**コードのデプロイより先に** `0003_add_booking_line_user_id.sql` と `0004_add_patient_line_notification.sql` を本番D1へ適用する必要があります。通常のWeb予約も `0003` の列を使い、LINE予約の患者さま向け通知は `0004` の列を使います。本番DBをバックアップしてから、次の順番で実行してください。

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm run db:migrate:remote
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm run deploy
```

`0003` では `line_user_id TEXT NOT NULL DEFAULT ''` の1列を追加し、既存予約は空欄のまま保持します。上記のマイグレーションコマンドは未適用のファイルすべてを処理するため、`0004` の患者さま向け通知用5列も追加します。このドキュメントの更新や `npm test` だけでは本番DBには反映されません。

本番用LIFF URLは `https://miniapp.line.me/2011966875-s5Cau1Zz` です。LINE Developersの本番用エンドポイントURLを `https://yomon-harikyu.com/page/customer_page/reservation_page` に設定してください。通常のWeb予約URLはそのまま使えます。公開サイトを接続先にして予約を確定すると本番DBへの登録と、設定・送信条件に応じて院長および患者さまへの通知が発生するため、自動テストではメモリ内DBと通信の代替処理のみを使います。ローカルでも実際のLINEトークンが設定されていれば通知を送るため、テスト用の設定を使ってください。

## 院長が登録する私用・患者予約

管理画面の予定登録では「私用」または「患者予約」を選びます。私用は開始・終了時刻を入力します。患者予約は施術コースを選び、管理カレンダーの空き枠をタップして日時を指定します。初診80分・再診60分・再診90分の終了時刻はサーバーで計算し、施術間の30分バッファも確保します。お名前は必須（80文字以内）、電話番号は任意です。管理カレンダーでは患者名、詳細画面ではコース・所要時間も確認できます。氏名・電話番号・メモを返すAPIは管理者認証が必要で、公開カレンダーには空き状況のみ返します。3時間以内の登録も可能です。

`0005_add_admin_patient_appointments.sql` は `blocked_periods` に種類・氏名・電話番号を追加します。既存の日時とメモは保ち、既存予定は「私用」になります。既存のWeb予約データは変更しません。

`0006_add_admin_appointment_menu.sql` は予定のコースを保存する列を追加します。既存予定のコースは未設定とし、保存済みの日時・枠の扱いは変えません。新しくコースを選んで登録した患者予約から30分バッファを適用します。

ローカルでは `npm run db:migrate:local` を実行します。本番公開時はDBをバックアップし、`npm run db:migrate:remote` で `0005`・`0006` を適用してからコードをデプロイしてください。新しいコードの予定登録・空き状況の取得は追加した列を使います。

## データと本番利用について

- 以前のSQLiteファイルは自動では移行されません。必要な予約が含まれている場合は、公開前に個別に移行してください。
- 無料枠は小規模な試作に使えますが、予約運用を始める前にD1の上限、復元期間、秘密情報の設定、個人情報の扱いを確認してください。
- 予約ページでは予約に必要な氏名・電話番号・任意のメールだけを扱います。症状や病歴は収集しません。

## 自動テスト

プロジェクトのルートで実行します。

```bash
npm test
```

テスト用のメモリ内データベースと通信の代替処理を使います。実際の予約データの変更やLINEへの通知送信は行いません。
