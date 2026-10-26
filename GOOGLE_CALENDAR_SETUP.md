# Googleカレンダーへの予約自動反映

予約システムからGoogleカレンダーへの一方向連携です。予約の変更・取り消しは院長用ページから操作してください。Googleカレンダーで直接編集した内容は予約サイトへ反映されず、次の同期で上書きされる場合があります。外部の空き時間から予約可否を決める処理は追加していません。

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
3. `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm run db:migrate:remote` で `0007_add_google_calendar_sync.sql` を適用します。
4. `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm run deploy` で公開します。
5. 管理者認証付きで `GET /api/admin/calendar-sync` を取得して、設定・件数を確認します。

マイグレーションは既存の予約・予定の内容を変更せず、同期キューとトリガーを追加します。適用時点で終了していない確定予約・院長登録予定をキューに追加するため、初回公開後には既存の今後の予約も順次Googleへ反映されます。設定不足の間はキューに保持し、Googleへの通信は行いません。

## 反映する操作・内容

- Web・LINE予約の確定、院長画面からの患者予約・私用登録
- Web予約の日時変更とキャンセル、院長登録予定の取り消し
- 患者予約: 氏名・施術コース・開始終了日時。私用: 「私用」と開始終了日時
- 電話番号・メールアドレス・メモ・LINEユーザーIDはGoogleに送りません。ゲスト招待や患者へのメール送信は行いません。
- 終了日時は予約データの実際の時刻です。30分の準備時間は予約時間に足しません。24:00終了は翌日00:00として送ります。

## 障害・重複・再送

予約の保存と同じD1トランザクション内で、トリガーが同期キューを更新します。削除した予定のIDも残るので、通信障害中の取り消しを後で反映できます。予約のレスポンスはGoogleの応答を待たず返し、Google側の障害によって予約が失敗したことにはしません。

変更後のバックグラウンド処理に加え、5分おきのCronで未反映分を再送します。一度の処理は件数・時間を制限し、失敗時は最大1時間のバックオフを行います。大量の初回取り込みには複数回のCronが必要です。各項目をリースして並行実行を抑え、中断された処理のリースは2分後に回復できます。

GoogleのイベントIDは予約の種類とIDから毎回同じ値を作ります。タイムアウト後も同じイベントを取得して更新するため二重登録を避けられます。GoogleのETagによる更新条件と、D1キューの世代番号により、変更中の処理を完了扱いにせず最新状態へ再同期します。無関係なGoogle予定を上書き・削除しないよう、システム専用の識別情報も確認します。

管理者認証が必要なAPI:

- `GET /api/admin/calendar-sync`: `configured`, `pending`, `synced`, `failed` の集計のみ。患者情報・秘密鍵は返しません。
- `POST /api/admin/calendar-sync`: 未反映分のバックグラウンド処理を要求（202）。設定不足は503。再送間隔を無視する操作ではありません。

`synced` は最後にGoogle APIへの反映に成功したキュー項目数で、削除完了項目も含みます。スマホやTimeTreeでの表示完了を保証する値ではありません。`configured` は設定値の有無であり、共有権限や秘密鍵の正しさは最初の同期で確認されます。

Googleからのエラー本文や資格情報は保存せず、HTTPステータス・許可リストにある理由コード・失敗段階などの制御されたエラーのみ記録します。繰り返し失敗する場合は、共有先メール・権限・カレンダーID・JSONキーを確認します。

同期済みのカレンダーIDを変更しても古いカレンダーの予定は自動移動しません。誤った場所への複製を防ぐため、キューに保存した同期先と異なる場合は停止します。変更には古い予定の整理を含めた移行が必要です。

## ローカル確認

`npm run db:migrate:local` を実行し、`.dev.vars` にはテスト用カレンダーとテスト用のJSONのみ設定します。公開用のJSON・カレンダーを設定すると実際の患者予定へ書き込むため、通常の自動テストではGoogleとLINEの通信を代替処理にしています。

## 公式仕様

- https://support.google.com/calendar/answer/37082?hl=ja
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/events/update
- https://developers.google.com/workspace/calendar/api/v3/reference/events/delete
