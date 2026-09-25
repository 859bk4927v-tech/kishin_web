# 予約機能をローカルで起動する

## 初回準備

1. ターミナルでプロジェクトフォルダに移動します。

   ```bash
   cd /Users/takaesu/Projects/webApp/kishin
   ```

2. 設定ファイルのひな形をコピーします。

   ```bash
   cp .env.example .env
   ```

3. 管理用トークンを作ります。

   ```bash
   python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
   ```

4. 表示された値を `.env` の `ADMIN_TOKEN=` の右側に設定します。実際のトークンをGitHubやチャットへ貼らないでください。`.env` はGit管理対象外です。

## 起動と確認

1. プロジェクトフォルダでサーバーを起動します。

   ```bash
   python3 server.py
   ```

2. MacまたはiPhone SimulatorのSafariで `http://localhost:8000/page/customer_page/reservation_page.html` を開き、日時を選んでテスト予約を作ります。
3. `http://localhost:8000/page/admin/admin_page.html` を開き、`.env` に設定した管理用トークンで予約を確認・変更・キャンセルします。
4. テスト終了後、ターミナルで `Control + C` を押して停止します。

予約データは `data/bookings.sqlite3` に保存されます。このファイルはGitに追加されません。ローカルで作った予約情報を本番に自動で移す機能はありません。

## LINE通知の有効化

Messaging APIの設定が完了した後に、`.env` の次の2項目を埋め、サーバーを再起動します。

```dotenv
LINE_CHANNEL_ACCESS_TOKEN=発行したChannelAccessToken
LINE_OWNER_USER_ID=院長のLINEユーザーID
```

設定前でも予約データは保存されますが、院長へのLINE通知は送信されません。設定後は、実際の予約を使う前に少額・テスト環境で通知を確認してください。

## このローカルサーバーの注意点

`server.py` は開発用です。インターネットから予約を受け付ける本番サーバーとして公開しないでください。公開前に、既存サイトのホスティング先を調べ、HTTPS、永続データベース、管理者認証、秘密情報の管理、バックアップができる構成へ移します。ホスティング先が決まるまでは、本番公開は未完了です。
