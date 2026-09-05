# べぬケアごはん 拡張・引き継ぎメモ

更新日: 2026-09-05

この文書は、今後の変更要求、会話で確定した判断、実装状況をスレッド間で引き継ぐために使う。現行の確定仕様は [`../dogcalplan.md`](../dogcalplan.md)、技術構成は [`implementation-guide.md`](./implementation-guide.md) を参照する。

## 現在の基準状態

- GitHub PagesとSupabaseによる家族同期版を運用中。
- 認証はSupabase匿名認証。メール・パスワード・4桁PINは使わない。
- ホーム画面版で未参加の場合は、完全な招待URLを一度貼り付ける。参加後は保存済みセッションで自動同期する。
- 通常セットは1回24 kcal／管理水分23 ml。バランスリキッド18 mlと追加水5 mlで構成する。
- 普通の水は飲水量だけ、固形食はカロリーだけを入力する。
- ボミットバスターは06:00と12:00に固定する。
- 現在の保存schemaはバージョン4。
- 過去イベントの18 ml／23 ml実績と過去日の設定は変更せず、新規日は通常セット23 mlで扱う。

## 現在の実装状況

- [x] 通常セット、普通の水、固形食の記録
- [x] 通常セットのクイック操作とタイムライン操作の共通化
- [x] 招待URLの一度限りの貼り付け参加画面
- [x] 匿名セッションと家族情報の端末保存
- [x] 旧schemaからバージョン4へのデータ移行
- [x] 計算・同期マージ・移行・点眼設定テスト33件
- [x] Service Workerキャッシュ `benu-care-v6`
- [x] 操作者プロフィール、排泄記録・取消し・Realtime
- [x] 点眼設定、日次セッション、担当排他、5分間隔、担当引き継ぎ、Realtime
- [x] 個人別通知設定、Push Subscription、通知ジョブ、Edge Function
- [x] 食事JSONの取込み互換を維持し、全期間の排泄・点眼を閲覧用介護JSONへ出力
- [x] `202609050001_care_features.sql`を本番Supabaseへ適用（ユーザー報告で成功を確認）
- [x] `202609050002_fix_care_profile_ambiguity.sql`を本番Supabaseへ適用（ユーザー報告で成功を確認）
- [x] 更新版をGitHub Pagesへ公開（ユーザー報告）
- [ ] VAPID/Edge Function/Cron設定の実運用確認
- [ ] 実Supabaseでの2端末・Push通知確認

## 次スレッド開始時

1. ユーザーの新しい要望をこの文書の「確定した変更要求」へ追記する。
2. 現行仕様との違い、既存データへの影響、同期への影響を確認する。
3. 実装前に未確定事項だけを整理する。

## 確定した変更要求

- `docs/dog_care_pwa_design_spec_ja.md` のMVPを既存PWAへ統合する。
- 食事は通常セット（バランスリキッド18 ml＋追加水5 ml）を24 kcal／管理水分23 mlとし、8回＋薬2回の192 kcal／194 mlを標準にする。
- 初回参加時と既存利用者の設定画面で表示名を保存し、新規の介護記録へ操作者を残す。
- 排泄は小・大をワンタップ記録し、論理取消しとRealtime共有を行う。
- 点眼は06:00〜22:00の2時間ごと、設定可能な順序、初期5分間隔、DB側の担当排他・早期完了拒否・担当引き継ぎを実装する。
- Web Pushは定時を通知ONの全員、次stepを担当者だけへ送り、通知設定は利用者単位とする。
- 点眼・排泄の重要操作はオンライン必須とする。

## 検討中・未確定

- 本番で使う実際の点眼薬、必要回数、時刻ごとの順番は公開後に管理者が獣医師等の指示どおり設定する。
- VAPID鍵とEdge Function Secretsはリポジトリへ保存せず、ユーザーがSupabaseへ設定する。

## 作業ログ

### 2026-09-05 ドキュメント整備

- 現行実装を `docs/implementation-guide.md` に整理した。
- 開発開始時とスレッド終了時の規約をルート `AGENTS.md` に追加した。
- コード、本番Supabase、GitHub Pagesの設定変更は行っていない。

### 2026-09-05 点眼・排泄・Push統合

確定した判断:
- 新設計書を実装要求として採用し、食事の将来設定を通常セット23 mlへ変更した。
- 既存の食事state同期は維持し、排泄・点眼・通知は整合性確保のため正規化テーブルと専用RPCで追加した。
- schema 3から4への移行では、将来設定だけを23 mlへ変更し、過去日の設定とイベント値を保持する。

実装:
- [x] schema v4移行、通常セット計算・画面・CSV更新
- [x] 表示名と食事記録者スナップショット
- [x] 排泄記録、Undo、履歴、Realtime
- [x] 点眼設定、担当排他、DB時刻による5分間隔、引き継ぎ、Realtime
- [x] 個人別通知設定、Push登録、通知ジョブ、Edge Function、Service Worker受信
- [x] 食事JSONと閲覧用介護JSONの分離、介護履歴の論理取消し表示
- [x] `docs/production-runbook.md`運用開始手順
- [x] 本番migration適用（ユーザー報告）
- [ ] Edge Function、VAPID、Cron、Pages公開

テスト:
- Chromiumで`tests.html` 33/33件合格。
- Chromiumでアプリ本体のモジュール読込みと初期画面描画を確認。ヘッドレス環境ではIndexedDBを利用できず、一時セッション表示までの確認。
- `git diff --check`成功。
- 本番migrationはユーザーがSQL Editorで適用し、成功表示を確認した。
- Edge Function、実Supabase RPC、Realtime、Web Pushは未適用・未確認。

次に行うこと・手動確認:
- `docs/production-runbook.md`の手順3以降に従い、VAPID/Edge Function/Cron、pushを行う。
- 初回点眼設定は翌日から適用されるため、本運用開始の前日までに保存する。
- 2端末で排泄Realtime、点眼同時担当、5分前拒否、引き継ぎ、Push対象を確認する。

### 2026-09-05 migration構文修正

- `complete_eye_drop_step`で複合型recordを複数項目の`INTO`へ同時代入していたため、SQL Editorで`42601`が発生した。
- セッション行を先にロックし、続いてstep行を取得・ロックする2段階の処理へ修正した。
- ユーザーが修正版`202609050001_care_features.sql`全体を再実行し、成功表示を確認した。

### 2026-09-05 VAPID鍵生成手順の補足

- WSLにLinux版Node.jsがなく、Windows版`npx`だけがPATHへ入った混在状態を確認した。
- `docs/production-runbook.md`の手順3を、Windows PowerShellでの事前確認、`ERR_INVALID_URL`の切り分け、Node.js標準機能だけで生成する代替コマンドまで含む内容へ更新した。
- PowerShellでWSLのUNCパスを現在地にすると`npx`が`ERR_INVALID_URL`になったため、手順5をWindowsの一時フォルダーでの動作確認と、コマンドプロンプトの`pushd`による一時ドライブ割当てを使う手順へ修正した。
- `CRON_SECRET`をSQL Editorへ直接貼る手順は実行履歴に残る可能性があるため、手順6をSupabase DashboardのVault画面から登録する方式へ変更し、SQLは予備手段として残した。

### 2026-09-05 介護プロフィール初期化RPC修正

- GitHub Pages公開後、介護機能の初期化で `column reference "user_id" is ambiguous` が発生した。
- `ensure_care_profile()`の`RETURNS TABLE`出力変数`user_id`と`ON CONFLICT (user_id)`がPL/pgSQL内で衝突することを特定した。
- 適用済みmigrationは変更せず、競合対象を`ON CONFLICT ON CONSTRAINT profiles_pkey`で指定する追加migration `202609050002_fix_care_profile_ambiguity.sql`を作成した。
- ユーザーが追加migrationを本番へ適用し、成功を報告した。複数端末とPushを含む実運用確認は継続する。

## スレッド終了時の記入テンプレート

```markdown
### YYYY-MM-DD 変更名

確定した判断:
- 

実装:
- [x] 
- [ ] 

テスト:
- 

次に行うこと・手動確認:
- 
```
