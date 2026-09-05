# べぬケアごはん 運用開始手順書

更新日: 2026-09-05

この手順書は、2026-09-05追加の通常セット、排泄、点眼、Web Pushを本番の家族端末で使い始めるまでの作業を、実施順にまとめたものです。本番DBへのSQL実行、秘密情報の登録、GitHubへのpushは利用者が行います。

## 0. 先に確認すること

- 点眼薬の名称、1日の必要回数、各時刻の順序は獣医師等の実際の指示を手元に用意してください。
- `Database password`、Supabaseのsecret key、VAPID秘密鍵、`CRON_SECRET`、家族招待URLはGitHubへ保存しないでください。
- SupabaseのProject URLとpublishable key、VAPID公開鍵だけはブラウザへ配布される公開情報です。
- 点眼と排泄の更新にはオンライン接続が必要です。食事記録は従来どおりオフライン保存できます。
- 作業中にエラーが出た場合は、次の手順へ進まず、エラー全文と実行した手順を控えてください。

## 1. 現在の記録を退避する

公開中のアプリを、現在もっとも新しい記録が入っている端末で開きます。

1. 画面上部の同期表示が「同期済み」になるまで待ちます。
2. 「設定」→「JSONバックアップ」を押し、食事記録のJSONを安全な場所へ保存します。
3. 現在使っている完全な招待URLを、安全なメッセージまたはパスワードマネージャーに残します。
4. 可能ならSupabase DashboardのDatabase Backupsで、利用中プランのバックアップ状態も確認します。

既存JSONは食事・投薬・日別メモの復元用です。新しい排泄・点眼データは正規化テーブルに保存されるため、公開後はアプリの「介護JSON（閲覧用）」も定期的に保存してください。この介護JSONは記録の控えであり、アプリ画面からの復元には対応していません。

## 2. Supabaseへ追加migrationを適用する

1. Supabase Dashboardで `dogcalplan` プロジェクトを開きます。
2. `SQL Editor` → `New query` を開きます。
3. [`202609050001_care_features.sql`](../supabase/migrations/202609050001_care_features.sql) の内容をすべて貼り付けます。
4. 対象プロジェクトが本番であることをもう一度確認し、`Run` を1回押します。
5. `Success. No rows returned` 等の成功表示を確認します。

途中でSQLエラーになった場合は、古い貼り付け内容を部分的に続行せず、リポジトリ上の修正版ファイルを開き直して全体を再実行します。このmigrationは、失敗後の再実行でも既存オブジェクトを壊さない形にしてあります。

Table Editorで次のテーブルがあることを確認します。

```text
profiles
health_events
eye_drop_settings
eye_drop_sessions
eye_drop_steps
notification_preferences
push_subscriptions
notification_jobs
```

ここで失敗した場合は、フロントエンドをまだpushしないでください。既に適用済みのmigrationを削除・編集してやり直すのではなく、エラー内容に応じた追加migrationで修正します。

## 3. Web Push用のVAPID鍵を作る

ここでいう「Node.jsが使えるPC」とは、ターミナルで `node --version` と `npm --version` の両方がエラーなく表示されるPCです。WindowsへNode.jsをインストールしている場合は、WSLではなく、スタートメニューから **Windows PowerShell** を開いてください。どのフォルダーで実行しても構いません。

PowerShellで、最初に次を確認します。

```powershell
node --version
npm --version
```

両方にバージョン番号が表示されたら、同じPowerShellで次を実行します。

```powershell
npx --yes web-push generate-vapid-keys --json
```

WSLで `command -v node` が何も返さず、`command -v npx` が `/mnt/c/Program Files/nodejs/npx` を返す状態では実行しないでください。Linux側のNode.jsがないのにWindows側の `npx` だけを呼ぶ混在状態で、`ERR_INVALID_URL` や `WSL 1 is not supported` の原因になります。

PowerShellでも `ERR_INVALID_URL` になる場合は、鍵の生成を繰り返さず、次の結果を確認します。通常、`registry` は `https://registry.npmjs.org/`、プロキシを設定していないPCでは残り2項目は `null` です。この3項目に秘密鍵は含まれません。

```powershell
npm config get registry
npm config get proxy
npm config get https-proxy
```

`npx` を使わず、Node.js標準機能だけで同じ形式の鍵を生成することもできます。

```powershell
node -e "const c=require('crypto'),e=c.createECDH('prime256v1');e.generateKeys();console.log(JSON.stringify({publicKey:e.getPublicKey().toString('base64url'),privateKey:e.getPrivateKey().toString('base64url')},null,2))"
```

出力された2値を分けて扱います。

- `publicKey`: [`js/push-config.js`](../js/push-config.js) の `VAPID_PUBLIC_KEY` へ貼り付けます。これはGitHubへpushして構いません。
- `privateKey`: パスワードマネージャーへ保存し、次の手順でSupabaseのsecretへ登録します。ファイルやGitには保存しません。

設定例は次の形です。

```js
export const VAPID_PUBLIC_KEY = "生成したpublicKey";
```

通知呼出しを保護する別の秘密値も作り、`CRON_SECRET` としてパスワードマネージャーへ保存します。

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Edge Functionのsecretを登録する

Supabase DashboardのEdge Functions用Secrets画面で、次の4項目を登録します。

| 名前 | 値 |
|---|---|
| `VAPID_PUBLIC_KEY` | 手順3のpublicKey |
| `VAPID_PRIVATE_KEY` | 手順3のprivateKey |
| `VAPID_SUBJECT` | 管理者の連絡先。例: `mailto:自分のメールアドレス` |
| `CRON_SECRET` | 手順3で生成した64桁の値 |

`SUPABASE_URL` とサーバー用キーはSupabaseがEdge Functionへ用意するため、通常は自分で追加しません。

## 5. 通知Edge Functionをデプロイする

今回の環境では、Windows版Node.jsを **Windowsのコマンドプロンプト** から使います。現在のWSLにはLinux版Node.jsがなく、Windows版 `npx` だけをWSLから呼び出すとエラーになるためです。また、PowerShellで `\\wsl$\...` を現在地にしたまま `npx` を実行すると、UNCパスが原因で `ERR_INVALID_URL` になります。初回だけブラウザでSupabaseへのログインが必要です。

まずPowerShellを `\\wsl$\...` 以外の場所へ移し、npm自体が動くことを確認します。

```powershell
Set-Location $env:TEMP
npx --yes supabase@latest --version
```

バージョン番号が表示されたら、スタートメニューから **コマンドプロンプト** を開きます。次の `pushd` はWSL上のフォルダーを一時的なWindowsドライブへ割り当てます。`Ubuntu` の部分は、`wsl --list --quiet` で表示される実際の名前へ置き換えてください。

```bat
pushd \\wsl$\Ubuntu\home\kgmrn\projects\dogcalplan
```

プロンプトの現在地が `Z:\>` などのドライブ文字に変わったことを確認し、次を実行します。`dir` で `index.ts` が表示されれば、正しい場所です。

```bat
dir supabase\functions\dispatch-notifications\index.ts
```

続けて、同じコマンドプロンプトで実行します。

```bat
npx --yes supabase@latest login
npx --yes supabase@latest link --project-ref fcayqpffyxisozfbrptl
npx --yes supabase@latest functions deploy dispatch-notifications --no-verify-jwt
```

完了後は `popd` で一時的なドライブ割当てを解除できます。

```bat
popd
```

このFunctionはJWTの代わりに `x-cron-secret` を照合します。Dashboardの `Edge Functions` で `dispatch-notifications` が表示され、デプロイが成功していることを確認します。

## 6. 1分ごとの通知処理を設定する

Supabase DashboardのDatabase Extensionsで `pg_cron` と `pg_net` が有効であることを確認し、Vaultを利用できる状態にします。

Dashboardで `Vault` 画面を開き、秘密値を新規登録します。画面内に見当たらない場合は、Dashboard上部の検索で `Vault` を検索してください。

| Vaultの項目 | 入力内容 |
|---|---|
| Name | `dogcalplan_cron_secret` |
| Secret | 手順3で生成した `CRON_SECRET`。引用符なし |
| Description | `dispatch-notifications 呼出し用` |

保存後は、SQL EditorのNew queryで次だけを実行します。秘密値そのものは表示されません。1行返れば登録できています。

```sql
select name, description, created_at
from vault.secrets
where name = 'dogcalplan_cron_secret';
```

Vault画面から登録できない場合に限り、次のSQLを予備手段として使います。`ここへCRON_SECRET` を実際の値へ置き換え、既存のシングルクォートは残します。実行したSQLは保存・共有せず、実行後にエディターの内容を消してタブを閉じます。ただしSQL Editor側の実行履歴に残る可能性があるため、Vault画面からの登録を優先してください。

```sql
select vault.create_secret(
  'ここへCRON_SECRET',
  'dogcalplan_cron_secret',
  'dispatch-notifications 呼出し用'
);
```

続いて、SQL Editorの新しいNew queryで1分ごとのジョブを登録します。このSQLには `CRON_SECRET` の実値を貼らず、Vaultの名前から取得する部分を変更しないでください。Project URLは公開情報なので固定値で記載しています。

```sql
select cron.schedule(
  'dispatch-dogcalplan-notifications',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://fcayqpffyxisozfbrptl.supabase.co/functions/v1/dispatch-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'dogcalplan_cron_secret'
      )
    ),
    body := jsonb_build_object('called_at', now())
  );
  $$
);
```

確認用SQLを実行し、`active` が `true` になっていることを確認します。

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'dispatch-dogcalplan-notifications';
```

数分待ってからDashboardのEdge Function logsを開き、定期呼出しがHTTP 200になっていることを確認します。500の場合はsecret名・VAPID値・Functionのログを確認してください。

## 7. ローカルで公開前確認をする

プロジェクトのルートでHTTPサーバーを起動します。

```bash
cd /home/kgmrn/projects/dogcalplan
python3 -m http.server 4173
```

次を確認します。

1. `http://localhost:4173/tests.html` を開き、全テストが合格する。
2. `http://localhost:4173/` を開き、画面がエラーなく表示される。
3. `js/push-config.js` に公開鍵だけが入り、秘密鍵や`CRON_SECRET`がリポジトリ内にない。
4. ターミナルで `git diff --check` が何も出さず終了する。
5. `git diff` を読み、既存記録や無関係な変更を消していないことを確認する。

## 8. GitHub Pagesへ公開する

差分確認後、利用者自身がコミットしてpushします。

```bash
cd /home/kgmrn/projects/dogcalplan
git add .
git commit -m "Add shared eye-drop and health care features"
git push origin main
```

GitHubの `Actions` で「Deploy べぬケアごはん to GitHub Pages」が成功するまで待ち、[公開アプリ](https://yoshiominemura.github.io/dogcalplan/) をブラウザで開きます。

Service Workerのキャッシュは `benu-care-v6` へ更新されます。古い画面のままなら、ブラウザ版を再読込みし、完全に閉じてからもう一度開いてください。ホーム画面版も終了後に再起動します。

## 9. 最初の端末を設定する

公開アプリの「設定」で次を行います。

1. 自分の表示名を入力して保存します。
2. 管理者端末で点眼薬と時刻別順序を実際の指示どおり入力します。
3. 必要回数と予定回数の警告がないことを確認し、点眼設定を保存します。
4. 「この端末の通知を有効にする」を押し、ブラウザの通知許可で「許可」を選びます。
5. 定時通知と担当中タイマー通知の希望を選んで保存します。
6. 「介護JSON（閲覧用）」を出力できることを確認します。

点眼薬は1行を `ID|表示名|1日の必要回数`、時刻別順序は1行を `HH:MM=表示名,表示名,...` で入力します。

```text
drop-1|1|9
drop-2|2|5

06:00=1,2
08:00=1
```

初回設定を含め、保存した点眼設定は翌日から適用されます。当日のセッションは履歴保護のため書き換わりません。本運用を始める前日までに設定を保存し、翌日の一覧で内容を確認してください。

iPhone/iPadでWeb Pushを使う場合は、Safariから先にホーム画面へ追加し、ホーム画面版を開いて通知を有効にしてください。通知権限を拒否した場合は、端末側のサイト／アプリ通知設定を変更してから再操作します。

## 10. 家族の端末を参加させる

1. 最初の端末に保存してある完全な `#invite=...` 付き招待URLを、家族へ個別に送ります。
2. 家族は受け取ったURLをSafariまたはChromeで開きます。
3. ホーム画面へ追加します。
4. ホーム画面版に参加画面が出た場合は、表示名と完全な招待URLを1回だけ入力します。
5. 各端末で通知ボタンを押し、通知を受けたい端末ごとに許可します。

招待URLは認証情報として扱います。公開チャット、GitHub Issue、リポジトリには貼らないでください。

## 11. 家族2台で受入確認をする

少なくとも2台をオンラインにして、次を順番に確認します。

- [ ] 新しい日の初期値が、通常セット8回で192 kcal・通常セット水分184 ml、薬10 ml込みで見込み194 mlになる。
- [ ] 片方で「小」または「大」を押すと、もう片方へ記録時刻と表示名が反映される。
- [ ] 排泄のUndoが両方へ反映され、履歴には取消し状態が残る。
- [ ] 同じ点眼回を両端末で同時に「担当する」と押しても、担当者が1人だけになる。
- [ ] 担当者以外は点眼完了できず、引き継ぎ後は新しい担当者だけが完了できる。
- [ ] 1剤目の完了直後は次剤を完了できず、5分後に完了できる。
- [ ] 時刻になったとき、有効化した各端末へ定時通知が届く。
- [ ] 次剤可能時刻の通知は、その回の現在の担当者だけへ届く。
- [ ] 一方をオフラインにすると点眼・排泄操作が拒否され、再接続後に最新状態へ戻る。
- [ ] 食事記録はオフラインでも端末へ保存され、復帰後に家族へ同期する。

通常セットは1回24 kcal、バランスリキッド18 ml、追加水5 ml、管理水分23 mlです。上の194 mlは8セット184 mlと薬2回各5 mlの合計です。水分上限が200 mlの標準設定では9回目が217 mlになるため、追加の通常セットは提案されません。

## 12. 日常運用と障害時の扱い

- 食事JSONと介護JSONを定期的に別の安全な保存先へ保管します。
- 点眼設定を変えると、既に手順が作成された当日の回は変えず、翌日以降へ反映されます。
- Edge Functionが停止しても点眼・排泄のDB記録は継続できますが、Push通知は届きません。DashboardのFunction logsとCronを確認します。
- 排泄と点眼が読めない場合は、ネット接続、Supabaseの障害情報、migration適用状況を順に確認します。食事のローカル記録を安易に削除しないでください。
- ロールバックするときはアプリコードを前のコミットへ戻して再公開します。今回のDB migrationは追加型なので、記録入りテーブルを削除しないでください。
- 実環境で不明なエラーが出たら、発生時刻、端末、画面、操作、Edge Function／Supabaseログを控えてから修正を依頼してください。

参考: [Supabase Edge Functionsのデプロイ](https://supabase.com/docs/guides/functions/deploy)、[Edge FunctionのSecrets](https://supabase.com/docs/guides/functions/secrets)、[CronによるFunction呼出し](https://supabase.com/docs/guides/functions/schedule-functions)、[web-push](https://github.com/web-push-libs/web-push)
