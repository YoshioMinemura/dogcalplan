# べぬケアごはん

`dogcalplan.md` の仕様に基づく、犬の食事・水分管理PWAです。IndexedDBへ端末保存し、設定後はSupabaseを介して家族間で同期します。

## 起動方法

Service Workerを利用するため、ファイルを直接開かずローカルHTTPサーバー経由で起動します。

```bash
python3 -m http.server 4173
```

ブラウザで `http://localhost:4173/` を開いてください。初回読込み後は、主要機能をオフラインで利用できます。

## 主な機能

- kcal、実績水分、未投与薬を含む見込み水分の集計
- 水分上限を守った未来枠の自動再計算と22時調整枠
- バランスリキッド、普通の水、固形食、鶏ごはん、薬、スープ缶の実績記録
- 普通の水は飲水量だけ、固形食はカロリーだけを入力
- 06:00・12:00固定の薬予定と未記録警告
- スキップ、失敗、実績の編集・論理取消し・直前操作の取消し
- 日別履歴、日次メモ、予定変更履歴
- 栄養値・目標・時間枠などの設定スナップショット
- JSONバックアップ／取込み、日次・明細CSV、全データ消去
- PWAインストール案内とオフラインキャッシュ
- 匿名認証と招待URLによる家族間同期、オフライン再送、同時操作の競合警告

## 家族間同期のセットアップ

1. Supabase DashboardのSQL Editorで [`supabase/migrations/202608290001_family_sync.sql`](./supabase/migrations/202608290001_family_sync.sql) を実行する。
2. `main` ブランチへ変更をpushし、GitHub Pagesの再デプロイを待つ。
3. 公開URLを最初の端末で開き、「設定」→「この端末のデータで家族同期を開始」を押す。
4. 表示された招待URLを家族へ送る。
5. ホーム画面版で同期されない場合は、受け取った招待URLを初回だけ貼り付ける。以後はアイコンからワンタップで起動・自動同期できる。

Project URLとpublishable keyはブラウザ公開用設定として `js/supabase-config.js` に入っています。Database password、secret key、`service_role` key、招待URLはGitHubへ保存しないでください。

ブラウザ用Supabaseクライアントは、オフライン起動と再現性のため `vendor/` にバージョン固定して同梱しています。

## テスト

- `http://localhost:4173/tests.html` — 計算ロジックと仕様の基準値・境界値

このアプリは医療判断を代替しません。設定値と投薬については、獣医師等の指示を確認してください。

家族間同期と公開方法の設計案は [docs/family-sync-plan.md](./docs/family-sync-plan.md) にまとめています。
