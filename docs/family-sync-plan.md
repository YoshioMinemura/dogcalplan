# 家族間同期・公開手順

更新日: 2026-08-28

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

URLの `#invite=...` 部分はGitHub PagesへのHTTPリクエストには送られない。アプリが読み取り、Supabaseの参加処理にだけ使用する。トークンはDBへ平文保存せず、ハッシュだけを保存する。

## まず今やること

迷った場合は、次の4つだけを順番に行う。

1. 下の「手順1〜3」でGitHub Pagesを公開する。
2. 「手順4〜5」でSupabaseプロジェクトと匿名サインインを用意する。
3. GitHub Pages URL、Supabase Project URL、publishable keyを確認する。
4. その3項目を添えて「同期実装を進めて」とCodexへ依頼する。

DBのSQL、RLS、招待トークン生成、同期コードはその次の実装でCodexが用意するため、先に自分で作らなくてよい。

## あなたとCodexの担当

### あなたが行うこと

- [ ] GitHubでpublicリポジトリを作る
- [ ] ローカルファイルを最初にpushする
- [ ] GitHub Pagesを有効にする
- [ ] Supabaseプロジェクトを作る
- [ ] Project URLとpublishable keyをCodexへ伝える
- [ ] 完成後、招待URLを家族へ送る
- [ ] 2台以上の端末で同期を確認する

### Codexが行うこと

- [ ] GitHub Pages向けの公開設定を追加する
- [ ] Supabaseのテーブル、関数、RLSをSQL migrationとして作る
- [ ] 匿名サインインと招待URL参加処理を実装する
- [ ] IndexedDBのデータをSupabaseへ同期する
- [ ] Realtime更新を画面へ反映する
- [ ] オフライン送信、二重記録、編集競合を実装・テストする
- [ ] 既存ローカルデータの初回アップロード画面を作る

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

同期実装で次のテーブルを作る。

- `households`: 家族グループ
- `household_members`: 匿名ユーザーと家族グループの対応
- `household_invites`: 招待トークンのハッシュと有効状態
- `dogs`: 犬と現在設定
- `day_records`: 管理日と設定スナップショット
- `schedule_slots`: 通常枠、調整枠、スキップ、失敗
- `intake_events`: 食事・薬の実績と取消し
- `plan_revisions`: 予定変更履歴

最初の招待トークンは十分に長いランダム値として1回生成する。DBにはハッシュだけを保存し、平文は家族へ送る招待URLにだけ使う。

RLSでは、現在の匿名ユーザーが `household_members` に存在する家族データだけを読み書きできるようにする。単純な未認証 `anon` アクセスは許可しない。

## 手順8: 同期の仕様

サーバーでは実績イベントを正とし、予定は実績から再計算する。

- 操作は最初にIndexedDBへ保存し、すぐ画面へ反映する。
- オンラインならSupabaseへ送信する。
- オフラインなら `PENDING` として保存し、復帰後に送信する。
- クライアント生成UUIDにより、再送されても1件だけにする。
- 同じ通常枠の有効実績は1件だけにする。
- 薬は同じ管理日・06:00または12:00ごとに有効実績を1件だけにする。
- 競合した場合は黙って上書きせず、「別端末で記録済み」と表示する。
- 取消しはDELETEせず `VOIDED` として保存する。
- Realtime通知後はDBから最新イベントを再取得して再計算する。

## 手順9: 家族へ共有する前のテスト

スマートフォンまたはブラウザを2台用意する。

- [ ] 両方で同じ招待URLを開ける
- [ ] ログイン画面なしで今日画面へ入れる
- [ ] 端末Aの鶏ごはん記録が端末Bへ反映される
- [ ] 端末Aの通常セット完了後、端末Bの予定も再計算される
- [ ] 06:00または12:00の薬を同時入力しても二重登録されない
- [ ] 一方をオフラインにして記録し、復帰後に同期される
- [ ] 同じ実績を両端末で編集した場合に競合が表示される
- [ ] 実績取消しが両方へ反映される
- [ ] アプリを終了・再起動しても記録が残る
- [ ] JSONバックアップを出力できる

## 日常運用

- 家族には必ず `#invite=...` を含む完全なURLを送る。
- 招待URLをSNSや公開Issueへ貼らない。
- 新端末またはブラウザデータ消去後は、招待URLをもう一度開く。
- 月1回を目安にJSONバックアップをダウンロードする。
- 家族外へURLが漏れた場合は招待トークンを無効化し、新しいURLを発行する。
- すでに参加済みの不明ユーザーがいる場合は `household_members` から無効化する。

## 費用

家族数人・犬1頭なら、GitHub PagesとSupabase Freeで開始できる。

Supabase Freeは1週間の非アクティブで停止する可能性があり、自動バックアップも含まれない。毎日使う間は停止しにくいが、無料運用ではJSONバックアップを継続する。停止なし・日次バックアップが必要になったらSupabase Proを検討する。

## 現在地

- [x] ローカル版PWA
- [x] IndexedDB保存
- [x] オフラインキャッシュ
- [x] 06:00・12:00固定の薬予定
- [x] 同期・公開方式の決定
- [ ] GitHubリポジトリ作成
- [ ] GitHub Pages公開
- [ ] Supabaseプロジェクト作成
- [ ] Supabase同期実装
- [ ] 複数端末テスト
- [ ] 家族へ共有

## 公式資料

- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages
- GitHub Pages publishing source: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- Supabase Anonymous Sign-Ins: https://supabase.com/docs/guides/auth/auth-anonymous
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Realtime: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- Supabase Pricing: https://supabase.com/pricing
- Supabase Backups: https://supabase.com/docs/guides/platform/backups
