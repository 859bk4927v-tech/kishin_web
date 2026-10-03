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

現時点で実装済みなのは、Web予約後に院長へLINE通知する機能です。LINEのトーク上で予約を受け付ける機能はまだありません。後からWebhookを追加し、Web予約とLINE予約が同じD1の空き枠確認・予約作成処理を使う設計にします。Webhookを公開する際は署名検証を必ず実装してください。

## データと本番利用について

- 以前のSQLiteファイルは自動では移行されません。必要な予約が含まれている場合は、公開前に個別に移行してください。
- 無料枠は小規模な試作に使えますが、予約運用を始める前にD1の上限、復元期間、秘密情報の設定、個人情報の扱いを確認してください。
- 予約ページでは予約に必要な氏名・電話番号・任意のメールだけを扱います。症状や病歴は収集しません。
