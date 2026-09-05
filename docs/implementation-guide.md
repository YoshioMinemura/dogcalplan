# べぬケアごはん 実装ガイド

更新日: 2026-09-05

この文書は、次の開発スレッドや別の実装者が、現在のコードを短時間で理解するための技術資料である。利用者向けの仕様は [`../dogcalplan.md`](../dogcalplan.md)、家族同期の構築・運用手順は [`family-sync-plan.md`](./family-sync-plan.md)、今後の変更要求と引き継ぎ状況は [`dogcalplan_expansion.md`](./dogcalplan_expansion.md) を参照する。

## 1. 現在の構成

アプリはビルド工程を持たない、HTML・CSS・JavaScriptのPWAである。

```text
iPhone / Android / PCブラウザ
  ├─ index.html + ES Modules
  ├─ IndexedDB: アプリ状態と同期メタデータ
  ├─ Service Worker: アプリ本体のオフラインキャッシュ
  └─ Supabase JS
       ├─ Anonymous Auth
       ├─ Postgres: 家族ごとのstate JSON、点眼・排泄・通知テーブル
       └─ Realtime: 更新通知
       └─ Edge Function: Web Push配信と日次点眼生成

GitHub main
  └─ GitHub Actions
       └─ GitHub Pages: https://yoshiominemura.github.io/dogcalplan/
```

フレームワーク、バンドラー、npm依存の実行時パッケージは使用していない。Supabaseクライアントは `vendor/supabase.min.js` に固定して同梱している。

## 2. ファイルの役割

| ファイル | 役割 |
|---|---|
| `index.html` | アプリのシェル、4画面用のDOM、起動エラー表示 |
| `styles.css` | モバイル優先の全画面スタイル |
| `manifest.webmanifest` | PWA名、起動URL、アイコン、表示方法 |
| `sw.js` | アプリシェルのキャッシュとオフライン応答 |
| `js/defaults.js` | `SCHEMA_VERSION`、標準設定、表示ラベル |
| `js/domain.js` | 日付、イベント、集計、予定再計算、警告、データ移行 |
| `js/app.js` | 起動、画面描画、フォーム操作、保存、入出力、同期との接続 |
| `js/db.js` | IndexedDBの読込み・保存。アプリ状態と同期情報は別キー |
| `js/auth.js` | 匿名セッション、招待URL解析、家族作成・参加RPC |
| `js/sync.js` | Supabaseとのpull/flush、3-way merge、Realtime、競合処理 |
| `js/care.js` | 操作者プロフィール、排泄、点眼、通知設定、Push Subscription |
| `js/push-config.js` | ブラウザ公開用VAPID公開鍵。秘密鍵は置かない |
| `js/supabase-client.js` | 同梱ライブラリの読込みとSupabaseクライアント生成 |
| `js/supabase-config.js` | ブラウザ公開用Project URLとpublishable key |
| `supabase/migrations/*.sql` | テーブル、RLS、RPC、Realtime publication |
| `supabase/config.toml` | Supabase CLIとEdge Functionのローカル設定 |
| `supabase/functions/dispatch-notifications/index.ts` | 点眼日次生成、期限到来通知ジョブ、Web Push送信 |
| `tests.html` / `js/tests.js` | ブラウザ上で動く計算・移行・同期マージのテスト |
| `.github/workflows/pages.yml` | 公開対象だけを `_site` に集めてGitHub Pagesへ配信 |

## 3. アプリ状態と保存

状態全体は次の形のJSONとして扱う。

```text
state
  ├─ schemaVersion
  ├─ settings
  ├─ days[]
  │    ├─ settingsSnapshot
  │    ├─ events[]
  │    ├─ slots[]
  │    └─ planRevisions[]
  └─ updatedAt
```

- IndexedDB名は `benu-care-meal-planner`、object storeは `app`。
- アプリ状態はキー `state`、同期情報はキー `sync-metadata` に保存する。
- Supabaseには同じ状態全体を `household_states.state` のJSONBとして保存する。
- 集計値は保存せず、イベントから `summarizeDay()` と `recalculatePlan()` で算出する。
- 各管理日は設定のスナップショットを持つ。後日の設定変更で過去記録の栄養値を変えない。
- イベントにも記録時点のkcalと水分をコピーする。設定変更後も既存イベントは書き換えない。
- 実績取消しは削除ではなく `status: "VOIDED"` として履歴を残す。

### schemaVersionと移行

現在の `SCHEMA_VERSION` は4である。起動時とJSONインポート時に `migrateStateToCurrent()` を通す。

バージョン2以前の「通常セット」は次のように移行する。

- 設定を `foods.balanceLiquid` へ変更する。
- schema 3の標準将来設定は、通常セット24 kcal／管理水分23 ml（バランスリキッド18 ml＋追加水5 ml）へ移行する。
- 旧イベントの種別は `BALANCE_LIQUID` へ変更する。
- 既存管理日の設定スナップショットと各イベントが持つ18 ml／23 mlは履歴の正確性のため変更しない。

保存形式を変更するときは、既存端末とSupabase上の旧データを壊さない移行関数を先に用意し、`SCHEMA_VERSION` を上げる。

## 4. 計算ロジック

計算の中心は `js/domain.js` の `recalculatePlan()` である。

現在の標準値:

| 項目 | kcal | 管理水分 |
|---|---:|---:|
| 通常セット1回 | 24 | 23 ml |
| 普通の水 | 0 | 入力したml |
| 固形食 | 入力したkcal | 0 ml |
| 鶏のスープごはん1食 | 39.9 | 0 ml |
| ボミットバスター1回 | 0 | 5 ml |
| スープ缶シリンジ1回 | 4 | 10 ml |

重要な不変条件:

- カロリーは0.1 kcal単位の整数で保持する。例: 39.9 kcalは399。
- 水分上限200 mlを最優先する。
- 未投与の薬は、1回5 mlを予約水分として計算へ含める。
- 薬は06:00と12:00の2回固定。
- 通常セットは不可分の1回単位。
- 完了済み・スキップ済み・失敗済みの過去枠を再計算で変更しない。
- 未来の通常枠へ必要回数を均等配置し、足りない場合だけ22:00調整枠を使う。
- 普通の水や固形食も記録直後に未来予定を再計算する。

標準状態では通常セット8回、192 kcal、薬込み194 mlとなる。9回目は217 mlになるため、22:00は調整待ちのままにする。

## 5. 記録操作の実装

### バランスリキッド

クイックボタンとタイムラインの「与えた」は、どちらも `recordBalanceLiquid()` を呼ぶ。現在時刻で24 kcal／管理水分23 mlを記録する。上限超過時だけ事実記録であることを確認する。クイックボタンは、遅延枠を優先し、その後もっとも早い予定枠へ紐づける。

### 普通の水と固形食

どちらも `openSimpleAmountDialog()` を使う。

- `PLAIN_WATER`: 飲水量だけを入力し、カロリーは0。
- `SOLID_FOOD`: カロリーだけを入力し、管理水分は0。

入力時刻は現在時刻で、保存後すぐ予定を再計算する。編集画面でもそれぞれ必要な1項目だけを表示する。

### その他

鶏ごはん、薬、スープ缶は `openRecordDialog()` を使う。薬は `medicineScheduledTime` により06:00または12:00の予定と結び付ける。

## 6. 起動と画面更新

`js/app.js` の `init()` はおおむね次の順で動く。

1. IndexedDBからローカル状態を読む。
2. 現行schemaへ移行する。
3. 当日の管理日がなければ作成し、予定を再計算する。
4. ローカル状態を保存する。
5. `familySync.initialize()` で匿名セッションと家族情報を確認する。
6. 接続済みならSupabaseと調停し、未参加なら招待URL入力画面を表示する。
7. Service Workerを登録する。

画面はテンプレート文字列で再描画する。利用者が入力した文字列は `escapeHtml()` を通して表示する。

### 点眼・排泄・通知

`js/care.js` は食事state同期とは別に、正規化したSupabaseテーブルを直接扱う。

- 排泄は`record_health_event`でUUID、時刻、操作者スナップショットを保存し、取消しは`VOIDED`にする。
- 点眼設定は管理者だけが変更でき、生成済みセッションには影響しない。
- `claim_eye_drop_session`は未担当セッションだけを原子的に取得する。
- `complete_eye_drop_step`は担当者、順序、DBサーバー時刻が`available_at`以後であることを検証する。
- `takeover_eye_drop_session`は担当者と未送信の次step通知先を同時に変更する。
- 排泄・点眼はRealtime再取得で家族全員へ反映する。排他性のある点眼操作と排泄記録はオンライン必須とする。
- 新しい食事イベントにはプロフィールのuser IDと表示名をスナップショット保存する。
- 食事JSONは取込み可能なバックアップ、介護JSONは全期間の排泄・点眼をページング取得する閲覧用控えとして分ける。介護JSONの画面復元は未対応。

## 7. 家族同期

### 認証と参加

- Supabase Anonymous Authを使用し、メールやパスワードは求めない。
- 招待URLは `#invite=長いトークン` を含む。
- URL fragmentはGitHub PagesへのHTTPリクエストには送られない。
- DBにはトークンのSHA-256ハッシュだけを保存する。
- 招待URLから参加できないホーム画面版では、完全なURLを初回だけ貼り付ける。
- 参加後は匿名セッションと `householdId` を端末へ保存するため、通常は以後の入力不要で自動同期する。
- ブラウザデータまたはPWAのアプリデータを消すと再参加が必要になる。

### 同期単位

家族全体のstate JSONを1単位として保存する。`household_states.revision` を楽観ロックに使い、保存時の期待revisionが古ければ最新stateを返してクライアント側でマージする。

### マージ

`mergeFamilyStates(remote, local, base)` は最後に同期したstateをbaseにする3-way mergeである。

- Supabase・ローカル・baseの各stateを個別に現行schemaへ移行してから比較し、旧stateとの初回マージで将来設定の移行を取りこぼさない。
- 日は `localDate`、枠は `scheduledTime|role`、イベントと変更履歴はIDで突き合わせる。
- 片側だけの新規イベントは両方残す。
- 同じ項目を両端末で変更した場合は `updatedAt` が新しい方を採用し、警告する。
- 同一バランスリキッド枠または同一薬予定への二重実績は、1件だけをACTIVEにし、もう1件をVOIDEDの競合履歴として残す。
- Realtimeは変更の通知に使い、通知後にDBからstateを再取得する。
- オフライン時はローカル保存してpendingにし、`online` 復帰後にflushする。

### Supabase側

`202608290001_family_sync.sql` は次を作成する。

- `households`
- `household_members`
- `household_invites`
- `household_states`
- `create_household`
- `join_household`
- `get_my_household`
- `save_household_state`

RLSにより、匿名認証済みで、かつ `household_members` に属する家族のstateだけを読める。書込みは権限確認を含むRPC経由で行う。

`202609050001_care_features.sql` はプロフィール、役割、排泄、点眼設定・セッション・step、通知設定、Push Subscription、通知ジョブ、および専用RPC/RLSを追加する。既存migrationは変更せず、必ず日付順に適用する。

`dispatch-notifications` Edge Functionは1分ごとに呼び出す。Asia/Tokyoの当日点眼セッションを冪等生成し、期限到来ジョブを通知設定に従って配信する。定時通知は通知ONの全員、次step通知は担当者だけが対象である。

## 8. PWAと公開

`main` へのpushで `.github/workflows/pages.yml` が動き、実行に必要なファイルだけをGitHub Pagesへ公開する。仕様書、テストページ、SQLはPages成果物へ含めない。

現在のService Workerキャッシュ名は`benu-care-v6`で、`care.js`と`push-config.js`もアプリシェルに含む。

アプリ本体を変更した場合は `sw.js` の `CACHE_NAME` を必ず更新する。更新しないと、既存のホーム画面版が古いJavaScriptやCSSを使い続ける可能性がある。

新しい実行時ファイルを追加した場合は、次の両方へ追加する。

1. `sw.js` の `APP_SHELL`
2. `.github/workflows/pages.yml` のコピー対象

公開用の `js/supabase-config.js` へ置けるのはProject URLとpublishable keyだけである。Database password、secret key、`service_role` key、招待トークンを置いてはいけない。

## 9. ローカル開発とテスト

Service WorkerとES Modulesを使うため、`index.html` を直接開かずHTTPサーバーを使う。

```bash
npm run serve
```

または:

```bash
python3 -m http.server 4173
```

- アプリ: `http://localhost:4173/`
- テスト: `http://localhost:4173/tests.html`

変更時の最低確認:

1. `tests.html` の33件が全件合格する。
2. `git diff --check` が成功する。
3. 今日画面、履歴、設定がスマートフォン幅で表示できる。
4. 記録、編集、取消し、再読込み後の復元を確認する。
5. 同期変更なら2ブラウザまたは2端末で反映、オフライン復帰、二重操作を確認する。
6. PWA変更なら既存ホーム画面版が新しいキャッシュへ更新されることを確認する。

本番Supabaseのstateを使う試験は実データを変更し得る。利用者から明示的に依頼されない限り、読み書きやテスト用家族の作成を行わない。

## 10. 変更時によく必要になる作業

### 新しい実績種別を追加する

1. `EVENT_LABELS` と必要なら既定値を追加する。
2. `eventNutrition()` と `reasonForType()` を更新する。
3. 集計・予定への影響を `summarizeDay()` / `recalculatePlan()` に実装する。
4. 記録、タイムライン、編集、CSV表示を `app.js` に追加する。
5. 同期の重複判定が必要なら `sync.js` を更新する。
6. 既存stateとの互換性が必要なら移行処理を追加する。
7. `js/tests.js` と仕様書を更新する。

### 保存形式を変える

1. 新旧両方を受け付ける移行を実装する。
2. 過去イベントの記録時栄養値を保つ。
3. `SCHEMA_VERSION` を上げる。
4. ローカル旧state、JSONバックアップ、Supabase旧stateの移行をテストする。

### 画面・JavaScript・CSSを変える

1. アクセシビリティと入力値のHTMLエスケープを維持する。
2. 二重タップ防止の `withMutationLock()` を経由する。
3. 保存が必要な操作は `commit()` を通す。
4. `sw.js` のキャッシュ名を上げる。

## 11. 現在の制約

- 招待URLを知っている人は参加できる簡易方式で、個別ログインや4桁PINはない。
- 参加済み端末や招待トークンをアプリ画面から無効化する管理機能はまだない。
- Supabaseでは家族全体を1つのJSONとして保存するため、記録量が大きくなった場合は分割テーブル化を検討する。
- 自動ブラウザE2E環境はなく、UIと実Supabase同期には手動確認が必要。
- Service Workerはcache-firstであり、更新反映には新しいキャッシュ名と再起動が必要になることがある。
- Web PushはVAPID鍵、Edge Function Secrets、1分間隔の呼出しを設定するまで動作しない。
- Edge Functionの日次生成は現在Asia/Tokyoを前提とする。

## 12. 次スレッドへの引き継ぎ

次の変更要求、検討中事項、完了状況は [`dogcalplan_expansion.md`](./dogcalplan_expansion.md) に記録する。スレッド終了時は、コードだけでなく、仕様・実装ガイド・テスト結果・未完了事項が次の担当者から見て一致している状態にする。
