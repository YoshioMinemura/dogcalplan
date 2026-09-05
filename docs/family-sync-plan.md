# 家族間同期・公開手順

更新日: 2026-09-05

> 2026-09-05の点眼・排泄・Push追加を本番へ反映する手順は [`production-runbook.md`](./production-runbook.md) を使用する。この文書の手順1〜8は初回構築時の記録である。

## 決定した構成

このアプリは次の構成で公開・同期する。

```text
GitHubのpublicリポジトリ
  └─ GitHub Pages ── PWAをHTTPS配信

家族のスマートフォン
  ├─ IndexedDB ── オフライン記録・未送信キュー
  ├─ Supabase匿名ユーザー ── 画面上のログイン操作なし
  └─ Supabase Postgres / Realtime ── 家族間同期
```

家族には、次のような招待トークン付きURLを共有する。

```text
https://GITHUBユーザー名.github.io/dogcalplan/#invite=長いランダム文字列
```

利用者はこのURLを開くだけでよい。アプリが裏側でSupabaseへ匿名サインインし、招待トークンが正しければ家族グループへ参加する。メールアドレス、パスワード、ログイン画面は使わない。

iPhoneで招待URLをSafariから開いたあとにホーム画面へ追加すると、ホーム画面版にはURLの `#invite=...` が引き継がれないことがある。その場合、ホーム画面版に表示される参加画面へ、受け取った完全な招待URLを初回だけ貼り付ける。参加情報と匿名セッションは端末内へ保存されるため、2回目以降はホーム画面のアイコンを押すだけで同じ家族データを開き、自動同期できる。ブラウザデータやアプリデータを消した場合だけ再参加が必要になる。

URLの `#invite=...` 部分はGitHub PagesへのHTTPリクエストには送られない。アプリが読み取り、Supabaseの参加処理にだけ使用する。トークンはDBへ平文保存せず、ハッシュだけを保存する。

## 初回構築の流れ（完了済み）

初回構築では、次の4つを順番に行った。

1. 下の「手順1〜3」でGitHub Pagesを公開する。
2. 「手順4〜5」でSupabaseプロジェクトと匿名サインインを用意する。
3. GitHub Pages URL、Supabase Project URL、publishable keyを確認する。
4. その3項目を添えて「同期実装を進めて」とCodexへ依頼する。

DBのSQL、RLS、招待トークン生成、同期コードはその次の実装でCodexが用意するため、先に自分で作らなくてよい。

## あなたとCodexの担当

### あなたが行うこと

- [x] GitHubでpublicリポジトリを作る
- [x] ローカルファイルを最初にpushする
- [x] GitHub Pagesを有効にする
- [x] Supabaseプロジェクトを作る
- [x] Project URLとpublishable keyをCodexへ伝える
- [ ] 完成後、招待URLを家族へ送る
- [ ] 2台以上の端末で同期を確認する

### Codexが行うこと

- [x] GitHub Pages向けの公開設定を追加する
- [x] Supabaseのテーブル、関数、RLSをSQL migrationとして作る
- [x] 匿名サインインと招待URL参加処理を実装する
- [x] IndexedDBのデータをSupabaseへ同期する
- [x] Realtime更新を画面へ反映する
- [x] オフライン送信、二重記録、編集競合を実装・テストする
- [x] 既存ローカルデータの初回アップロード画面を作る

## 手順1: GitHubリポジトリを作る

GitHubの「New repository」から次の内容で作成する。

| 項目 | 設定値 |
|---|---|
| Repository name | `dogcalplan` |
| Visibility | `Public` |
| README追加 | しない |
| .gitignore追加 | しない |
| License追加 | しない |

publicリポジトリにはアプリのソースコードだけを置く。犬の記録、JSONバックアップ、DBパスワード、Supabase secret key、招待トークンは置かない。

## 手順2: ローカルからGitHubへpushする

GitHubでリポジトリを作成したあと、表示されたリポジトリURLを使って次を実行する。

```bash
cd /home/kgmrn/projects/dogcalplan
git init
git branch -M main
git add .
git commit -m "Initial dog care PWA"
git remote add origin https://github.com/GITHUBユーザー名/dogcalplan.git
git push -u origin main
```

`GITHUBユーザー名` は自分のGitHubユーザー名へ置き換える。

この時点ではSupabase同期はまだなく、現在と同じ端末内保存版が公開される。

## 手順3: GitHub Pagesを有効にする

リポジトリのGitHub画面で次を設定する。

1. `Settings` を開く。
2. 左側の `Pages` を開く。
3. `Build and deployment` のSourceを `GitHub Actions` にする。
4. `main` ブランチへpushすると、同梱済みの `.github/workflows/pages.yml` が公開処理を行う。
5. リポジトリの `Actions` で「Deploy べぬケアごはん to GitHub Pages」の完了を確認する。
6. 数分待ち、次のURLを開く。

```text
https://GITHUBユーザー名.github.io/dogcalplan/
```

確認項目:

- [ ] 今日画面が表示される
- [ ] 鶏ごはん等を記録できる
- [ ] 再読込み後も同じ端末の記録が残る
- [ ] スマートフォンで「ホーム画面に追加」できる
- [ ] オフラインで起動できる

GitHub Pagesのサイトは公開サイトである。リポジトリをprivateにするだけでは、通常の個人プランでPagesまで家族限定にはならない。

公開ワークフローはアプリ実行に必要なファイルだけを配信する。仕様書、設計書、README、単体テストはpublicリポジトリでは閲覧できるが、GitHub Pagesのサイトには配置しない。

## 手順4: Supabaseプロジェクトを作る

Supabase Dashboardで `New project` を選び、次を設定する。

| 項目 | 推奨値 |
|---|---|
| Project name | `dogcalplan` |
| Database password | パスワードマネージャーで生成・保管 |
| Region | 利用可能な中で日本に最も近いリージョン |
| Plan | 最初はFree |

作成後、Projectの `Connect` またはAPI設定画面から次の2つを確認する。

- Project URL: `https://xxxxxxxx.supabase.co`
- Publishable key: `sb_publishable_...`

この2つはブラウザアプリで使う公開用設定なのでCodexへ渡してよい。

以下はCodexへ渡さず、GitHubにも保存しない。

- Database password
- Secret key
- `service_role` key
- 招待トークン

## 手順5: Supabaseの匿名サインインを有効にする

Supabase Dashboardで次を設定する。

1. `Authentication` を開く。
2. Sign In / Providersの設定を開く。
3. Anonymous Sign-Insを有効にする。
4. メール、Google等のログインは今回は設定しない。

匿名ユーザーは端末ごとに作られ、セッションはブラウザへ保存される。ブラウザデータを消した場合は別ユーザーになるため、元の招待URLをもう一度開けば家族グループへ再参加できるようにする。

公開サイトから匿名ユーザー作成APIが呼べるため、不要ユーザーが大量作成されるようならCloudflare Turnstileを後から追加する。最初から必須にはしない。

## 手順6: ここでCodexへ依頼する

次の3項目を伝えて、同期実装を依頼する。

```text
GitHub Pages URL:
Supabase Project URL:
Supabase Publishable key:
```

publishable keyは公開用だが、チャットへ残したくない場合はローカルの設定ファイルへ自分で貼り付ける方法でもよい。その場合はCodexがテンプレートを作る。

Codexは次を追加する。

```text
supabase/migrations/     DBテーブル・関数・RLS
js/supabase-client.js   Supabase接続
js/sync.js              IndexedDB・DB同期
js/auth.js              匿名サインイン・招待参加
```

## 手順7: DBと招待URLを作る

初回公開時に行った手順は次のとおりである。

1. Supabase Dashboardで作成済みの `dogcalplan` プロジェクトを開く。
2. 左側の `SQL Editor` を開き、`New query` を押す。
3. [`../supabase/migrations/202608290001_family_sync.sql`](../supabase/migrations/202608290001_family_sync.sql) の内容をすべて貼り付ける。
4. `Run` を1回押し、エラーが出ないことを確認する。同じSQLは再実行してもよい。
5. 次のコマンドで今回の変更をGitHubへ送る。

```bash
cd /home/kgmrn/projects/dogcalplan
git add .
git commit -m "Add Supabase family sync"
git push
```

6. GitHubの `Actions` でデプロイ完了を待つ。
7. [公開中のアプリ](https://yoshiominemura.github.io/dogcalplan/) を最初の端末で開く。ホーム画面版を開いている場合は、一度ブラウザで開いて最新版へ更新する。
8. 「設定」→「この端末のデータで家族同期を開始」を押す。現在の端末内データが最初の家族データになる。
9. 表示された「家族へ送る招待URL」をコピーし、家族へ個別に送る。
10. 家族は招待URLをそのまま開く。招待URLは再参加に使えるよう、安全なメッセージ内などに残しておく。
11. ホーム画面版で「家族データに参加」が表示された場合は、表示名と完全な招待URLを入力して「家族データに参加」を1回押す。
12. 参加後にホーム画面版を終了・再起動し、URLの再入力なしで同期済みの今日画面が開くことを確認する。

DBには次の4種類を作成する。

- `households`: 家族グループ
- `household_members`: 匿名ユーザーと家族グループの対応
- `household_invites`: 招待トークンのハッシュと有効状態
- `household_states`: アプリ全体の正本と更新番号

食事、薬、日別記録、予定変更履歴は `household_states.state` のJSON内に、既存バックアップと同じ構造で保存する。家族全体を1トランザクションで更新するため、途中までしか保存されない状態を避けられる。更新番号が一致しない同時操作はクライアントでマージし、二重投薬等は1件を取消し履歴にして画面へ警告する。

最初の招待トークンは、同期開始ボタンを押したブラウザが暗号学的乱数として1回生成する。DBにはハッシュだけを保存し、平文は家族へ送る招待URLと最初の端末内にだけ残す。

RLSでは、現在の匿名ユーザーが `household_members` に存在する家族データだけを読み書きできるようにする。単純な未認証 `anon` アクセスは許可しない。

## 手順8: 同期の仕様

サーバーでは実績イベントを正とし、予定は実績から再計算する。

- 操作は最初にIndexedDBへ保存し、すぐ画面へ反映する。
- オンラインならSupabaseへ送信する。
- オフラインなら `PENDING` として保存し、復帰後に送信する。
- クライアント生成UUIDにより、再送されても1件だけにする。
- 同じバランスリキッド枠の有効実績は1件だけにする。
- 薬は同じ管理日・06:00または12:00ごとに有効実績を1件だけにする。
- 競合した場合は黙って上書きせず、「別端末で記録済み」と表示する。
- 取消しはDELETEせず `VOIDED` として保存する。
- Realtime通知後はDBから最新イベントを再取得して再計算する。

点眼・排泄追加後は、食事のstate JSONに加えて次の正規化テーブルもRealtime購読する。

- `health_events`: 小・大、記録時刻、記録者、取消し状態
- `eye_drop_settings`: 点眼薬、必要回数、時刻別順序、間隔
- `eye_drop_sessions` / `eye_drop_steps`: 担当者、進捗、サーバー時刻、次回可能時刻
- `notification_preferences` / `push_subscriptions` / `notification_jobs`: 個人設定、端末、配信待ちジョブ

点眼の担当取得・完了・引き継ぎは専用RPCで行い、オフラインでは操作できない。食事は従来どおりオフライン保存・復帰後同期が可能である。

## 手順9: 家族へ共有する前のテスト

スマートフォンまたはブラウザを2台用意する。

- [ ] 両方で同じ招待URLを開ける
- [ ] ログイン画面なしで今日画面へ入れる
- [ ] ホーム画面版へ招待URLを1回貼り付け、再起動後は入力なしで同期済み画面へ入れる
- [ ] 端末Aの鶏ごはん記録が端末Bへ反映される
- [ ] 端末Aのバランスリキッド完了後、端末Bの予定も再計算される
- [ ] 普通の水は飲水量だけ、固形食はカロリーだけで記録でき、端末Bにも反映される
- [ ] 06:00または12:00の薬を同時入力しても二重登録されない
- [ ] 一方をオフラインにして記録し、復帰後に同期される
- [ ] 同じ実績を両端末で編集した場合に競合が表示される
- [ ] 実績取消しが両方へ反映される
- [ ] アプリを終了・再起動しても記録が残る
- [ ] 食事JSONと介護JSONを出力でき、食事JSONを再取込みできる

## 日常運用

- 家族には必ず `#invite=...` を含む完全なURLを送る。
- 招待URLをSNSや公開Issueへ貼らない。
- 新端末、ブラウザデータ消去後、またはアプリデータ消去後は、招待URLをもう一度開くか参加画面へ貼り付ける。
- 月1回を目安に食事JSONと閲覧用介護JSONをダウンロードする。
- 家族外へURLが漏れた場合は招待トークンを無効化し、新しいURLを発行する。
- すでに参加済みの不明ユーザーがいる場合は `household_members` から無効化する。

## 費用

家族数人・犬1頭なら、GitHub PagesとSupabase Freeで開始できる。

Supabase Freeは1週間の非アクティブで停止する可能性があり、自動バックアップも含まれない。毎日使う間は停止しにくいが、無料運用では食事JSONと閲覧用介護JSONの出力を継続する。介護JSONは画面復元用ではないため、停止なし・DBの日次バックアップが必要になったらSupabase Proを検討する。

## 現在地

- [x] ローカル版PWA
- [x] IndexedDB保存
- [x] オフラインキャッシュ
- [x] 06:00・12:00固定の薬予定
- [x] 同期・公開方式の決定
- [x] GitHubリポジトリ作成
- [x] GitHub Pages公開
- [x] Supabaseプロジェクト作成
- [x] Supabase同期実装（コード・migration）
- [x] Supabaseでmigrationを実行
- [x] 同期版をGitHubへpush
- [x] 家族へ共有して運用開始
- [x] 点眼・排泄・Pushのコードと追加migrationを作成
- [x] `202609050001_care_features.sql`を本番へ適用
- [x] `202609050002_fix_care_profile_ambiguity.sql`を本番へ適用（ユーザー報告）
- [x] VAPID、Edge Function、1分間隔の通知呼出しを設定（ユーザー報告）
- [x] 更新版をGitHub Pagesへ公開（ユーザー報告）
- [ ] 今回の更新後、複数端末、点眼排他、Push、ホーム画面版の再参加を確認

## 公式資料

- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages
- GitHub Pages publishing source: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- Supabase Anonymous Sign-Ins: https://supabase.com/docs/guides/auth/auth-anonymous
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Realtime: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- Supabase Pricing: https://supabase.com/pricing
- Supabase Backups: https://supabase.com/docs/guides/platform/backups
