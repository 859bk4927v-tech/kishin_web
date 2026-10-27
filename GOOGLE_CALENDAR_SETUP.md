# Googleカレンダーへの予約自動反映

サイトで登録した予約・私用をGoogleカレンダーに反映し、Googleで新規作成した予定はサイトの予約不可時間として取り込みます。サイト由来の患者予約の変更・取り消しは院長用ページ、Google由来の予定の変更・削除はGoogleで操作してください。サイト由来の予約をGoogleで編集しても予約情報自体は変更されません。

## 設定

1. Google Calendar APIを有効化したプロジェクトでサービスアカウントを作成します。
2. 対象カレンダーをサービスアカウントのメールアドレスに共有し、「予定の詳細を変更、表示可能」（限定公開の予定も扱える権限）を許可します。「変更可能（限定公開の予定を、予定の有無としてのみ表示）」では、今回の限定公開の予約を扱えません。「予定の変更および共有の管理」までは不要です。カレンダーの所有者は院長のままです。Google Cloudプロジェクトの「オーナー」権限やドメイン全体の委任は不要です。
3. Workers `kishin-web` のProductionに以下を設定します。
   - Secret `GOOGLE_SERVICE_ACCOUNT_JSON`: ダウンロードしたJSON全体。秘密鍵はGit・HTML・チャットに含めません。
   - Variable `GOOGLE_CALENDAR_ID`: カレンダーの設定→カレンダーの統合→カレンダーID。現在の公開設定は `yomon.harikyu@gmail.com` です。`primary` やカレンダーのURLは使いません。
4. カレンダーIDは `wrangler.jsonc` にも保存します。ダッシュボードで変更した場合はこのファイルも合わせてください。

APIの認証先は `https://oauth2.googleapis.com/token` に固定しています。認証範囲は `calendar.events` で、実際にアクセスできるカレンダーは共有設定で制限します。サービスアカウント自身がカレンダーの所有者になる操作はしません。

## 公開手順

1. テストと静的HTMLのチェックを実行し、必要な変更をコミットしてpushします。
2. 本番D1のバックアップを取得します。
3. `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm run db:migrate:remote` で未適用のマイグレーション（`0007_add_google_calendar_sync.sql`、`0008_import_google_calendar.sql`、`0009_google_calendar_watch.sql`）を適用します。
4. `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm run deploy` で公開します。
5. 管理者認証付きで `GET /api/admin/calendar-sync` を取得して、設定・件数を確認します。

マイグレーションは既存の予約・予定の内容を変更せず、同期キューとトリガーを追加します。適用時点で終了していない確定予約・院長登録予定をキューに追加するため、初回公開後には既存の今後の予約も順次Googleへ反映されます。設定不足の間はキューに保持し、Googleへの通信は行いません。

## 反映する操作・内容

- Web・LINE予約の確定、院長画面からの患者予約・私用登録
- Web予約の日時変更とキャンセル、院長登録予定の取り消し
- 患者予約: 氏名・施術コース・開始終了日時。私用: 「私用」と開始終了日時
- 電話番号・メールアドレス・メモ・LINEユーザーIDはGoogleに送りません。ゲスト招待や患者へのメール送信は行いません。
- 終了日時は予約データの実際の時刻です。30分の準備時間は予約時間に足しません。24:00終了は翌日00:00として送ります。

## Googleからの取り込み

- 対象カレンダーにGoogleで作成した「予定あり」の時間を取り込み、Web・LINE予約、院長の患者予約・私用登録の重複判定に使います。Googleの変更通知を受けたら同期を開始し、同期前に開いた画面からの予約も保存時に再判定します。反映前の時間差はあるため、Googleとサイトへの同時入力には注意してください。
- 予定の変更・削除・「予定なし」への変更も反映します。終日は日本時間の0時から翌0時まで、繰り返しはGoogleが展開した各回を扱います。取り込み範囲は本日から予約受付期間の少し先までで、毎回更新します。大量の予定では複数回の定期処理が必要です。
- Google予定は準備時間を足さず、指定された開始〜終了のみを埋めます。患者の氏名やコースを推測して患者予約を作ることはありません。LINE通知も送りません。
- 院長画面では「Google」と表示し、タップすると予定名・時間・Googleで変更する案内を表示します。一般の予約画面には予定名を返しません。
- サイトから書き出したイベントは識別情報とイベントIDの両方で除外し、再取り込みや同期ループを防ぎます。Google取り込み用テーブルからは書き出しキューを作りません。
- 既存予約とGoogle予定が重なっても予約を取り消さず、院長画面に重複件数を表示します。院長が調整してください。
- 全ページ取得完了後に一括で公開するため、途中の通信・DBエラーで既存の予約不可時間を消しません。直前の同期内容を維持し、次回取得をやり直します。

## Googleの変更通知

- 本番は `GOOGLE_CALENDAR_WEBHOOK_ENABLED="true"` を設定します。`SITE_URL` は本番HTTPSオリジンです。追加の手動Secret設定は不要です。
- Cronと管理者の手動同期が `events.watch` を登録します。通知先は `https://yomon-harikyu.com/api/google-calendar/webhook`。Googleが通知するのは変更の発生だけなので、通知後に既存の取り込み処理で予定を読み直します。追加・変更・削除が対象です。
- 通知は完全な即時性や配送を保証しません。5分ごとの取り込みを残し、通知漏れ・通信障害・処理中の中断を補います。大量の予定や障害時は複数回の同期が必要です。開いたままのカレンダー画面の表示更新は従来の画面操作に従います。
- 通知チャンネルは7日を要求し、Googleが返した期限の24時間前から新しいチャンネルを登録します。旧チャンネルは期限まで有効にして更新失敗時の空白を避け、期限後にDBから削除します。登録失敗は1時間後から再試行します。
- ランダムな通知トークンのハッシュ、チャンネルID、対象リソースID、有効期限を検証します。登録応答より先に届く初回 `sync` 通知にも対応しています。トークン・リソースIDは管理者の状態APIにも返しません。
- 通知番号で重複・順序逆転を抑止し、DBの世代番号で同期中の変更を記録します。処理時間に余裕がある場合は一度追加取得し、残りは次回通知やCronで補います。予約DBの二重登録やLINE通知を起こしません。
- `robots.txt` は通知先だけを `/api/` の拒否から除外します。CloudflareでGoogleからのPOSTが拒否される場合はSecurity Eventsで該当パスのルールを確認してください。予約API全体の保護を解除する必要はありません。
- 公開後は管理者の手動同期を実行し、`watch.active` がtrue、`lastNotificationAt` が更新されることを確認します。初回通知の到着は接続確認であり、実際の予定変更の反映確認とは区別します。

## 障害・重複・再送

予約の保存と同じD1トランザクション内で、トリガーが同期キューを更新します。削除した予定のIDも残るので、通信障害中の取り消しを後で反映できます。予約のレスポンスはGoogleの応答を待たず返し、Google側の障害によって予約が失敗したことにはしません。

変更後のバックグラウンド処理に加え、5分おきのCronで未反映分を再送します。一度の処理は件数・時間を制限し、失敗時は最大1時間のバックオフを行います。大量の初回取り込みには複数回のCronが必要です。各項目をリースして並行実行を抑え、中断された処理のリースは2分後に回復できます。

GoogleのイベントIDは予約の種類とIDから毎回同じ値を作ります。タイムアウト後も同じイベントを取得して更新するため二重登録を避けられます。GoogleのETagによる更新条件と、D1キューの世代番号により、変更中の処理を完了扱いにせず最新状態へ再同期します。無関係なGoogle予定を上書き・削除しないよう、システム専用の識別情報も確認します。

管理者認証が必要なAPI:

- `GET /api/admin/calendar-sync`: 書き出しの `configured`, `pending`, `synced`, `failed` と、取り込みの `import`（`syncedAt`, `error`, `inProgress`, `count`）、通知の `watch`（`enabled`, `active`, `expiresAt`, `lastNotificationAt`, `error`）。予定名・患者情報・秘密鍵は返しません。
- `POST /api/admin/calendar-sync`: 書き出し・Google取り込み・通知設定の登録/期限更新を要求（202）。設定不足は503。書き出しの再送間隔を無視する操作ではありません。

`synced` は最後にGoogle APIへの反映に成功したキュー項目数で、削除完了項目も含みます。スマホやTimeTreeでの表示完了を保証する値ではありません。`configured` は設定値の有無であり、共有権限や秘密鍵の正しさは最初の同期で確認されます。

Googleからのエラー本文や資格情報は保存せず、HTTPステータス・許可リストにある理由コード・失敗段階などの制御されたエラーのみ記録します。繰り返し失敗する場合は、共有先メール・権限・カレンダーID・JSONキーを確認します。

同期済みのカレンダーIDを変更しても古いカレンダーの予定は自動移動しません。誤った場所への複製を防ぐため、キューに保存した同期先と異なる場合は停止します。変更には古い予定の整理を含めた移行が必要です。

## ローカル確認

`npm run db:migrate:local` を実行し、`.dev.vars` には `GOOGLE_CALENDAR_WEBHOOK_ENABLED="false"` を設定して本番通知先へのチャンネル登録を防ぎます。`.dev.vars` にはテスト用カレンダーとテスト用のJSONのみ設定します。公開用のJSON・カレンダーを設定すると実際の患者予定へ書き込むため、通常の自動テストではGoogleとLINEの通信を代替処理にしています。

## 公式仕様

- https://support.google.com/calendar/answer/37082?hl=ja
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/events/update
- https://developers.google.com/workspace/calendar/api/v3/reference/events/delete
- https://developers.google.com/workspace/calendar/api/v3/reference/events/list

- https://developers.google.com/workspace/calendar/api/guides/push
- https://developers.google.com/workspace/calendar/api/v3/reference/events/watch
