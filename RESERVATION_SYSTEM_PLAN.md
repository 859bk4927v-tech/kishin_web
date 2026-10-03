# 予約管理・LINE通知の作業手順書

このファイルは、よもん はりきゅう治療院のWebサイトに予約管理を追加するための実装計画です。ローカルLLMや開発者が、上から順に作業できるようにまとめています。

## 目標

- お客様がWebサイトから空き日時と施術メニューを選び、予約を送信できる。
- 予約が確定したら、院長にLINEで予約内容が届く。
- 院長が予約を確認し、必要に応じて変更・キャンセルできる。
- 同じ時間枠に予約が重複しない。
- スマートフォンでも見やすく、操作しやすい。

## 現在わかっていること

- Webサイトは `/Users/takaesu/Projects/webApp/kishin` にある。静的HTML/CSS/JavaScriptは `public/`、Cloudflare Workerは `src/` に置く。
- `public/page/customer_page/reservation_page.html` とローカル用Cloudflare Worker APIは準備済み。Cloudflareへのデプロイはまだ。
- 公開済みの料金メニューは、初回30分、鍼30分、鍼＋灸30分、経絡ケア60分。
- 営業時間は10:00〜19:00、最終受付は18:00、休院日は日曜日とサイトに記載されている。
- 予約データはCloudflare D1に保存する構成を準備済み。

## 院長から確認した運用ルール

- 予約はフォーム送信時に確定する。
- 1つの時間帯は1件まで。同じ時間に重なる予約は受け付けない。
- 予約は60日先まで、30分単位で受け付ける。
- 院のLINE公式アカウントはある。Messaging APIの有効化状況・通知先IDは未確認。
- Cloudflare Workers＋D1を公開先に決定。独自ドメインは未設定。
- 暫定の実装では氏名と電話番号を必須、メールアドレスを任意にする。症状や病歴はフォームで収集しない。
- 現行サイトに書かれている営業時間10:00〜19:00、最終受付18:00、日曜休院を使う。祝日・臨時休院のルールは未確認。

## 実装状況

- 予約画面、JavaScript Worker API、D1スキーマ、院長用管理画面（一覧・日時変更・キャンセル）を用意した。
- 予約の重複はWorker側とD1の原子的な書き込み時に再確認する。
- LINE Messaging APIによる院長への通知処理を追加したが、認証情報が未設定のため現在は通知されない。
- 予約データはローカルではWranglerのD1（`.wrangler/state/`）、本番ではCloudflare D1に保存する。以前の `data/bookings.sqlite3` は自動移行しない。
- Cloudflare Workers＋D1へJavaScriptで移行済み。ローカルではWranglerを使う。LINE Push通知はWorkersから送信する。
- LINE Messaging APIのPush通知には、同一リクエストの安全な再試行用キーを付ける。LINEは再試行キーを24時間管理するため、期限後の自動再送はしない。[LINEの再試行仕様](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)

## 大事なLINEの前提

**LINE Notifyは2025年3月31日に終了しています。新規開発では使いません。** 予約通知には、院のLINE公式アカウントとLINE Messaging APIを使います。[LINE Notify終了のお知らせ](https://developers.line.biz/en/news/2025/04/01/line-notify/)

Messaging APIで院長個人にPush通知を送るには、通知先となる院長のLINEユーザーIDと、送信元のLINE公式アカウントの友だち登録が必要です。[メッセージ送信の説明](https://developers.line.biz/en/docs/messaging-api/sending-messages/)

LINEから届くWebhookを受け取る機能を作る場合は、Webhook署名を検証します。Channel secretやChannel access tokenはブラウザ側のコードやGitHubに置かず、サーバーの秘密情報として管理します。[Webhook署名の検証](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)、[Channel access token](https://developers.line.biz/en/docs/basics/channel-access-token/)

## 実装を始める前に決めること

以下のうち未決定の運用項目は、推測せず実装前に確認してください。回答はこの表に追記します。ホスティング先はCloudflare Workers＋D1に決定済みです。

| 決めること | 選択・回答 |
|---|---|
| 予約は何日前から何日先まで受け付けるか | 60日先まで（院長回答） |
| 営業日の予約枠の開始時刻と間隔（例：30分ごと） | 10:00〜18:00開始、30分間隔（暫定実装） |
| 施術メニューごとの予約占有時間（準備・片付け時間を含むか） | 掲載中の30分・60分（準備・片付け時間は未確認） |
| 同じ時間帯に何件まで予約を受けるか | 1件（院長回答） |
| 日曜日以外の臨時休院・祝日の扱い | 未決定 |
| お客様から受け取る情報（氏名、電話、メールなど） | 未決定。必要最小限にする |
| 予約は送信時点で確定か、院長の確認後に確定か | 送信時点で確定（院長回答） |
| お客様への予約確認・変更・キャンセル連絡方法 | 画面で予約番号を表示。メール通知・顧客向け変更リンクは未実装 |
| 院長が予約を確認・変更・キャンセルする方法 | 試作の `public/page/admin/admin_page.html` で管理用トークン認証（ローカルのみ） |
| 現在のWebサイトを公開しているホスティング先・ドメイン | Cloudflare Workers＋D1を採用。独自ドメインは未決定 |
| サーバー・データベースの希望、月額費用の上限 | Cloudflare Workers＋D1。無料枠で試作 |
| LINE公式アカウントはすでにあるか。Messaging APIを有効化できるか | 公式アカウントあり（院長回答）。Messaging APIの状態は未確認 |

## 推奨する仕組み

既存サイトは静的ページなので、予約情報を安全に保存する**サーバー機能とデータベース**を追加します。予約一覧をブラウザだけに保存する作りにはしません。ブラウザの保存領域では院長と予約を共有できず、端末変更やデータ消失にも弱いためです。

全体の流れは次のとおりです。

```text
お客様のスマートフォン
  ↓ 空き枠確認・予約送信
予約ページ（`public/page/customer_page/reservation_page.html`）
  ↓ サーバーで入力確認・空き枠再確認
予約API ──→ データベースに予約を保存
  ↓ 保存成功後に通知
LINE Messaging API ──→ 院長のLINE
```

Cloudflare Workers＋D1を利用します。ローカルで動作を確認してから無料枠へデプロイし、本番予約開始前に無料枠の上限・復元期間を確認します。独自ドメイン取得費用は別途です。

## 作業手順

### 1. 現状と公開環境を調べる

- [x] リポジトリのファイル、Gitの状態、既存の予約リンクと画面を確認する。
- [ ] Webサイトの公開先、ドメイン、デプロイ手順を確認する。
- [x] 予約運用ルールの未決定項目を院長に質問する。
- [x] 上の「実装を始める前に決めること」を回答に合わせて更新する。
- [x] Cloudflare Workers＋D1を採用する。

**完了条件：** 営業時間、枠の作り方、同時予約数、確定方法、管理方法、公開先が明らかになっている。Cloudflareデプロイ設定は準備済み。

### 2. LINE公式アカウントを通知できる状態にする

- [x] 院のLINE公式アカウントがあることを確認した。
- [ ] LINE Official Account ManagerからMessaging APIを有効にし、LINE Developers ConsoleにMessaging APIチャネルを用意する。
- [ ] 院長本人がそのLINE公式アカウントを友だち追加する。
- [ ] Messaging APIチャネルの設定から通知先となる院長のLINEユーザーIDを確認する。必要に応じ、院長が公式アカウントへメッセージを送った際のWebhookからユーザーIDを取得する。
- [ ] Channel secretとChannel access tokenを発行し、WorkersのSecretとして安全に保管する。
- [ ] トークン類をHTML、JavaScript、Git管理下の設定ファイル、チャット、ログに貼らない。
- [ ] LINEの料金・月間メッセージ数の最新条件を確認する。

Messaging APIチャネルの作成手順：[LINE公式アカウントでMessaging APIを始める](https://developers.line.biz/en/docs/messaging-api/getting-started/)

**完了条件：** 本番Workerから、院長のLINEにテスト通知を1件送れる。失敗時にサーバーログで原因を調べられる。

### 3. 予約ページと予約APIを作る

- [x] `public/page/customer_page/reservation_page.html` を作成し、日付、空き時間、メニュー、お客様情報を入力できるようにする。
- [x] 入力欄にラベル、必須項目、形式確認、エラー表示を追加する。
- [x] 空き状況はサーバーから取得する。
- [x] 予約送信時にサーバー側で入力を検証し、空き状況を再確認してから保存する。
- [x] 同時送信時の二重予約をD1の原子的なINSERTと重なり確認で防ぐ。
- [x] 予約番号を画面に表示し、LINE通知失敗時も予約を保存する。
- [x] 予約送信の二重登録を冪等キーで防ぎ、LINE Push通知にはLINEの再試行キーを使う。

実装ファイル：`public/page/customer_page/reservation_page.html`、`public/page/admin/admin_page.html`、`src/worker.js`、`public/js/reservation_page.js`。ローカル起動手順は `RESERVATION_LOCAL_SETUP.md` を参照。

### 4. 予約データと管理方法を作る

- [x] 予約番号、開始・終了時刻、メニュー、氏名、連絡先、状態、作成日時をD1に保存する。
- [x] 「確定」「キャンセル」を区別する。
- [x] 院長用管理画面で予約一覧、日時変更、キャンセルを行えるようにする。
- [x] 管理用トークンで管理APIを保護する。
- [x] 日時変更・キャンセル・LINE通知の再送操作を用意する。
- [ ] 予約変更・キャンセル時の空き枠反映と、お客様への連絡方法を決めたとおりに実装する。
- [ ] 不要な個人情報や症状の詳細を収集・保存しない。必要な情報、利用目的、保管期間をサイト上で説明する。

### 5. LINE通知をつなぐ

- [x] 保存後にサーバーからMessaging APIのPush messageを送るコードを追加する。
- [x] 通知に予約番号、日時、メニュー、氏名、電話番号を含める。
- [x] Channel access tokenと通知先LINEユーザーIDはWorkersのSecretから読む。
- [x] 予約と通知状態を別々に保存し、通知失敗で予約を消さない。
- [x] 管理画面から通知を再送できるようにし、LINE再試行キーを使う。
- [ ] Messaging APIを有効化し、秘密情報を設定して実際のLINE通知を確認する。
- [ ] Messaging APIを使うWebhookを受ける場合は、受け取ったリクエストの署名を検証する。

### 6. テストする

- [ ] スマートフォン幅で予約ページを操作できる。
- [ ] 営業時間、最終受付、休院日、予約枠、メニューの所要時間が決めたルールどおりに表示される。
- [ ] 空き枠を1件予約すると、空き状況からその枠が消える。
- [ ] 同じ枠への同時予約を試しても、確定するのは許可された件数だけ。
- [ ] 入力漏れや不正な値では予約が保存されず、修正方法が画面に表示される。
- [ ] 予約確定後に院長のLINEへ正しい内容が1回届く。
- [ ] LINE送信失敗時も予約が保存され、再送できる。
- [ ] キャンセル後、ルールどおりに枠が再び空きになる。
- [ ] 未ログインの人が管理機能を使えない。
- [ ] Channel secretやChannel access tokenがHTML、JavaScript、Git履歴、画面表示に含まれていない。

Worker・D1への移行後の構文確認・ローカル起動・ブラウザ操作・予約APIの実動作確認はまだ。作業後にこの一覧で確認します。

### 7. 公開する

- [ ] 本番用のLINE SecretとD1を設定する。
- [ ] HTTPSで予約ページとAPIを公開する。
- [ ] 公開URLで予約、管理、通知を一通り確認する。
- [ ] データベースのバックアップと、障害・通知失敗時の確認手順を記録する。
- [ ] 公開後はテスト予約を削除またはキャンセルし、院長へ操作方法を引き継ぐ。

## Cloudflare Workers＋D1の構成

- サイトと静的ファイルは `public/` から配信する。
- WorkerのAPIは `src/` に置き、D1 binding `BOOKING_DB` を利用する。
- D1スキーマは `migrations/` のSQLで管理する。
- 本番のトークンはWrangler Secrets、ローカルのトークンは `.dev.vars` に置き、Gitへ登録しない。
- Web予約と将来追加するLINE予約Webhookは、共通の `BookingService` を通して予約枠を確保する。

## 予約データの設計メモ

まずは必要最小限の項目にします。実装時に決めた運用ルールに合わせて変更してください。

| 項目 | 説明 |
|---|---|
| `id` | 内部識別子 |
| `booking_number` | お客様・院長が問い合わせに使う予約番号 |
| `start_at` / `end_at` | 予約開始・終了日時。保存形式と表示タイムゾーンを統一する |
| `menu_code` | 選択した施術メニュー |
| `customer_name` | お客様の氏名 |
| `customer_phone` / `customer_email` | 決定した連絡手段。両方を必須にしない |
| `status` | 予約状態（確定・キャンセルなど） |
| `created_at` / `updated_at` | 作成・更新日時 |
| `notification_status` | LINE通知の未送信・成功・失敗など |

## ローカルLLMに作業させるときの指示

このファイルを渡すときは、次の指示も一緒に伝えてください。

> `RESERVATION_SYSTEM_PLAN.md` を読んで、現在のリポジトリを確認してから作業してください。「実装を始める前に決めること」の未決定の運用項目を列挙し、仕様が必要な箇所は推測せず質問してください。回答できる独立作業（現状確認、既存ページの整理、画面案の作成など）は先に進めてください。LINEやホスティングの秘密情報をソースコードやGitに保存しないでください。アカウント作成、有料契約、本番公開は、選択肢と費用を示して院長が決めてから進めてください。作業後は変更点、確認した項目、未完了事項をこの計画に反映してください。

## 公式資料

- [LINE Notifyサービス終了のお知らせ](https://developers.line.biz/en/news/2025/04/01/line-notify/)
- [Messaging APIを始める](https://developers.line.biz/en/docs/messaging-api/getting-started/)
- [Messaging APIでメッセージを送る](https://developers.line.biz/en/docs/messaging-api/sending-messages/)
- [LINE Webhook署名を検証する](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Channel access tokenについて](https://developers.line.biz/en/docs/basics/channel-access-token/)
- [LINE Messaging APIで失敗したリクエストを再試行する](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)
- [Messaging APIの料金・プラン](https://developers.line.biz/en/docs/messaging-api/pricing/)
