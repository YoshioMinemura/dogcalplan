# べぬケアごはん

`dogcalplan.md` の仕様に基づく、犬の食事・点眼・排泄管理PWAです。食事はIndexedDBにも保存し、Supabaseを介して家族間で同期します。点眼と排泄はDB側の整合性制御付きで共有します。

## 起動方法

Service Workerを利用するため、ファイルを直接開かずローカルHTTPサーバー経由で起動します。

```bash
python3 -m http.server 4173
```

ブラウザで `http://localhost:4173/` を開いてください。初回読込み後は、食事の記録・集計をオフラインでも利用できます。点眼と排泄の共有操作はオンライン必須です。

## 主な機能

- kcal、実績水分、未投与薬を含む見込み水分の集計
- 水分上限を守った未来枠の自動再計算と22時調整枠
- バランスリキッド（バランスリキッド18 ml＋追加水5 ml）、普通の水、固形食、鶏ごはん、薬、スープ缶の実績記録
- 普通の水はml、固形食はkcal・g・粒で入力し、記録時刻も指定可能
- 時刻を変更できる1日2回の薬予定（初期06:00・12:00）と未記録警告
- スキップ、失敗、実績の編集・論理取消し・直前操作の取消し
- 日別履歴、日次メモ、予定変更履歴
- 栄養値・目標・時間枠などの設定スナップショット
- 食事JSONのバックアップ／取込み、介護データの閲覧用JSON、日次・明細CSV、全データ消去
- PWAインストール案内とオフラインキャッシュ
- 匿名認証と招待URLによる家族間同期、オフライン再送、同時操作の競合警告
- 小・大のワンタップ排泄記録、操作者表示、Undo、Realtime共有
- 06:00〜22:00の点眼、担当者排他、5分間隔、担当引き継ぎ
- 個人別の定時点眼／担当中タイマーWeb Push通知

## 家族間同期のセットアップ

1. Supabase DashboardのSQL Editorで [`supabase/migrations/202608290001_family_sync.sql`](./supabase/migrations/202608290001_family_sync.sql) を実行する。
2. 続いて [`supabase/migrations/202609050001_care_features.sql`](./supabase/migrations/202609050001_care_features.sql) を実行する。
3. 修正migration [`202609050002_fix_care_profile_ambiguity.sql`](./supabase/migrations/202609050002_fix_care_profile_ambiguity.sql)、[`202609060001_edit_health_event_time.sql`](./supabase/migrations/202609060001_edit_health_event_time.sql) を日付順に実行する。
4. [`docs/production-runbook.md`](./docs/production-runbook.md) に従ってVAPID、Edge Function、1分間隔の通知呼出しを設定する。
5. `main` ブランチへ変更をpushし、GitHub Pagesの再デプロイを待つ。
6. 公開URLを最初の端末で開き、表示名と点眼設定を確認する。
7. 招待URLを家族へ送り、ホーム画面版では初回だけ表示名と完全な招待URLを入力する。

Project URLとpublishable keyはブラウザ公開用設定として `js/supabase-config.js` に入っています。Database password、secret key、`service_role` key、招待URLはGitHubへ保存しないでください。

ブラウザ用Supabaseクライアントは、オフライン起動と再現性のため `vendor/` にバージョン固定して同梱しています。

## テスト

- `http://localhost:4173/tests.html` — 計算ロジックと仕様の基準値・境界値

本番更新から家族での確認までの具体的な手順は [運用開始手順書](./docs/production-runbook.md) を参照してください。

このアプリは医療判断を代替しません。設定値と投薬については、獣医師等の指示を確認してください。

家族間同期と公開方法の運用手順は [docs/family-sync-plan.md](./docs/family-sync-plan.md) にまとめています。

開発を引き継ぐ場合は、[AGENTS.md](./AGENTS.md)、[拡張・引き継ぎメモ](./docs/dogcalplan_expansion.md)、[実装ガイド](./docs/implementation-guide.md) の順に確認してください。

2026-09-06更新: メニューを「食事・排泄・点眼・履歴・設定」へ分離し、履歴も種類別に確認できます。スープ缶はmlから0.5 kcal/mlで換算します。排泄時刻の編集には追加migration [`202609060001_edit_health_event_time.sql`](./supabase/migrations/202609060001_edit_health_event_time.sql) が必要です。適用・公開手順は運用開始手順書を参照してください。

ブラウザ回帰: `node tests/browser-regression.cjs`（Playwrightが必要）。モックで同期中の編集・入力・履歴を確認し、本番Supabaseには接続しません。
