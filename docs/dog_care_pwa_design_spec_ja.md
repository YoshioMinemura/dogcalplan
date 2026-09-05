# 犬の介護管理PWA 全体設計書

- 文書種別: システム設計書
- 対象: 家族共有型 犬の介護管理PWA
- バージョン: 1.0
- 作成日: 2026-09-05
- 主な対象機能: 食事管理 / 点眼管理 / 排泄記録 / 家族共有 / Push通知

---

## 1. 目的・背景

犬の介護において、家族複数人で以下を安全かつ簡単に管理することを目的とする。

1. 1日のカロリー・水分量を管理しながら食事を与える。
2. 2時間ごとの点眼スケジュールを管理する。
3. 点眼薬同士の5分間隔を自動で管理する。
4. 点眼担当者を1人に限定し、二重実施を防止する。
5. 点眼進捗・食事記録・排泄記録を家族全員でリアルタイム共有する。
6. 「小」「大」の排泄をワンタップで記録する。
7. 必要なユーザーだけがPush通知を受け取れるようにする。
8. スマートフォン、特にiPhoneのホーム画面から通常のアプリに近い操作感で利用できるようにする。

本システムは医療判断を自動化するものではなく、家族内で決めた介護手順・獣医師等から与えられた指示を記録・実行支援する管理ツールとする。

---

# 2. 設計方針

## 2.1 基本方針

- フロントエンドは既存のGitHub Pages上のPWAを継続利用する。
- 共有データ、認証、リアルタイム同期、Push通知制御のためにSupabaseを導入する。
- `?invite=...` は毎回のアクセスキーとして利用せず、「家族への初回参加」にのみ利用する。
- 参加後はSupabase Authのセッションでユーザーを識別する。
- 操作履歴は可能な限り「誰が・いつ・何をしたか」を保存する。
- 家族全員が同じ状態を参照する。
- 食事・点眼の二重実施を防ぐため、重要操作はフロントエンドだけではなくDB側でも整合性を保証する。
- 過去の記録は、設定変更によって書き換えない。
- 画面はスマートフォンでの片手操作を優先する。

---

# 3. 全体システム構成

```text
家族A iPhone ─┐
家族B iPhone ─┼──── GitHub Pages
家族C iPhone ─┘      PWA Frontend
                         │
                         │ HTTPS
                         ▼
                      Supabase
             ┌───────────┼───────────┐
             │           │           │
           Auth       PostgreSQL   Realtime
             │           │           │
             └───────────┼───────────┘
                         │
                  Edge Functions
                         │
                    Push Dispatcher
                         │
                      Web Push
                         │
                         ▼
                     各ユーザー
```

## 3.1 フロントエンド

想定:

- GitHub Pages
- React / Vite等のSPA
- Web App Manifest
- Service Worker
- PWA
- Supabase JavaScript Client

既存実装がReact/Vite以外の場合でも、設計思想は同一とする。

## 3.2 バックエンド

Supabaseを利用する。

- Supabase Auth
- PostgreSQL
- Realtime
- Row Level Security（RLS）
- Edge Functions
- Cron
- Secrets

## 3.3 Push通知

Web Pushを利用する。

- Service WorkerでPushを受信
- Push SubscriptionをSupabaseに保存
- VAPIDを使用
- VAPID秘密鍵はフロントエンドに置かない
- Push送信処理はEdge Function側で実施

iPhoneについては、ホーム画面に追加されたPWAで通知許可を取得して利用することを前提とする。

---

# 4. ユーザー・家族モデル

## 4.1 家族

アプリ内では1つの共有単位を `family` とする。

例:

```text
峯村家
 ├─ 自分
 ├─ 母
 └─ 父
```

全ての介護記録は `family_id` と紐づける。

将来複数の犬を扱えるよう、介護対象は `dog` として独立させる。

## 4.2 ユーザー

各操作ユーザーはSupabase Authの `user_id` を持つ。

最低限保持する情報:

- `user_id`
- `display_name`
- `family_id`
- `role`
- `created_at`

### role

MVPでは以下を想定する。

- `admin`
- `member`

adminのみが以下を変更可能とすることを推奨する。

- 点眼薬設定
- 点眼スケジュール
- 食事設定
- 家族招待

日常の記録は全memberが可能。

---

# 5. 招待・認証設計

## 5.1 招待リンク

例:

```text
https://example.github.io/dog-care/?invite=XXXXXXXX
```

招待コードは初回参加専用とする。

### 初回フロー

```text
招待リンクを開く
  ↓
invite token検証
  ↓
表示名入力
  ↓
Supabase Authユーザー作成
  ↓
family_membersへ登録
  ↓
Authセッションを端末に保存
  ↓
inviteパラメータをURLから除去
  ↓
通常URLへ遷移
```

参加後の起動URL:

```text
https://example.github.io/dog-care/
```

このためホーム画面追加時に `invite=` が消えても同期に影響しない。

## 5.2 認証方式

MVPでは匿名Authを利用してもよい。

メリット:

- メールアドレス不要
- 家族が簡単に参加可能

注意:

- ブラウザデータ削除
- PWA削除
- 端末変更

などでセッションを失う可能性がある。

将来はMagic Link等へのアップグレードを可能にする。

---

# 6. ホーム画面

トップ画面では「今日の介護状況」を一画面で確認可能とする。

例:

```text
--------------------------------
今日 9/5
--------------------------------

【点眼】
次回 16:00
1 → 2 → 2.5 → 3

16:00 ○
18:00 ○
20:00 ○
22:00 ○

--------------------------------

【食事】
142 / 198 kcal
148 / 200 ml

通常セット 5 / 8
次回 16:00

--------------------------------

【排泄】

[  小  ]          [  大  ]

小 最終 13:18
大 最終 08:24

--------------------------------
```

点眼が進行中の場合、点眼カードを画面上部で強調表示する。

---

# 7. 食事管理仕様

## 7.1 1日の目標

初期値:

| 項目 | 値 |
|---|---:|
| 目標カロリー | 198 kcal |
| 水分上限 | 200 ml |

優先順位:

1. 水分200mlを超えない
2. 必須の水分投与を確保する
3. 可能な範囲で198kcal以上を目指す
4. 水分制約のため198kcalに届かない場合は不足を許容する

`200 ml` は「目標」ではなく「上限」として扱う。

---

## 7.2 食品・投与項目

### 通常セット

バランスリキッドは分割しない。

```text
バランスリキッド 18ml
+
水 5ml
```

1セット:

| 項目 | 値 |
|---|---:|
| カロリー | 24 kcal |
| 水分 | 23 ml |

通常セットは1セット単位でのみ記録・提案する。

### ボミットバスター

- 1日2回
- 1回あたり水分5ml
- 1日合計10ml
- カロリーは0として扱う。ただし設定変更可能とする。

### スープ缶シリンジ

初期設定:

| 項目 | 値 |
|---|---:|
| カロリー | 4 kcal |
| 水分 | 10 ml |

通常のカロリー補給手段として自動推奨せず、実際に与えた場合の追加イベントとして記録する。

### 鶏のスープごはん

初期設定:

| 項目 | 値 |
|---|---:|
| カロリー | 39.9 kcal |
| 管理上の水分 | 0 ml |

水分は本システムの200ml計算には含めない。

自主的に食べる場合のみ記録する。

---

## 7.3 基本スケジュール

通常セット:

```text
06:00
08:00
10:00
12:00
14:00
16:00
18:00
20:00
```

22:00は調整枠。

したがって基本は、

```text
通常8枠 + 22:00調整枠
```

とする。

鶏のスープごはん0回の場合:

```text
通常セット8回
= 192 kcal
= 水分184ml

ボミットバスター
= 水分10ml

合計:
192 kcal
194 ml
```

198kcalには6kcal不足するが、水分上限を優先するため許容する。

9セット目は水分217mlとなるため禁止する。

---

# 8. 食事再計算ロジック

## 8.1 基本変数

```text
TARGET_KCAL = 198
MAX_WATER = 200

REGULAR_KCAL = 24
REGULAR_WATER = 23

VOMIT_WATER = 5
```

その時点の状態:

```text
current_kcal
current_water
remaining_vomit_count
remaining_normal_slots
adjustment_slot_available
```

## 8.2 必須水分予約

未投与のボミットバスター分は、未来の必須水分として予約する。

```text
reserved_water
= remaining_vomit_count * 5
```

使用可能水分:

```text
available_water
= MAX_WATER
  - current_water
  - reserved_water
```

## 8.3 水分上限から可能な通常セット数

```text
max_sets_by_water
= floor(available_water / 23)
```

## 8.4 カロリー目標から必要な通常セット数

```text
remaining_kcal
= max(0, 198 - current_kcal)

needed_sets_by_kcal
= ceil(remaining_kcal / 24)
```

## 8.5 推奨する残り通常セット数

```text
recommended_sets
= min(
    needed_sets_by_kcal,
    max_sets_by_water,
    remaining_available_slots
  )
```

これにより、

- カロリー不足は許容
- 水分超過は許容しない

という優先順位を保証する。

---

# 9. 鶏のスープごはん摂取時の再計算

「鶏のスープごはんを食べた」を押すと:

```text
current_kcal += 39.9
```

として残り通常セット数を再計算する。

過去の記録は変更しない。

未来の予定のみ変更する。

## 9.1 スキップ方針

鶏ごはんを食べた直後は、必要に応じて直近の未来の通常セットをスキップする。

これは以下の運用を反映する。

```text
スープごはん優先
→ 食べた直後はシリンジを数回免除
```

例:

```text
10:30 鶏ごはん
12:00 スキップ
14:00 通常セット
...
```

必要セット数がさらに減った場合:

```text
12:00 スキップ
14:00 スキップ
16:00 通常セット
...
```

22:00は原則として最後まで調整枠として保持する。

---

# 10. 22:00調整枠

22:00は通常の9セット目ではない。

用途:

- 予定していた通常セットを与えられなかった
- 途中でスケジュールが変化した
- 水分上限内で追加可能
- カロリー不足が残っている

場合の調整用とする。

22:00時点で通常セットを追加すると水分200mlを超える場合:

```text
追加不可
```

と明示する。

例:

```text
192 / 198 kcal
194 / 200 ml

目標まで6kcalですが、
通常セットを追加すると水分上限を超えるため
本日は追加しません。
```

---

# 11. 食事の記録状態

各時間枠:

- `planned`
- `completed`
- `skipped`
- `failed`
- `cancelled_by_recalculation`

を持つ。

画面例:

```text
06:00 ✓ 通常セット
08:00 ✓ 通常セット
10:00 ✓ 通常セット
11:15 🐔 鶏ごはん
12:00 ― 再計算により不要
14:00 ○ 通常セット予定
```

---

# 12. 点眼管理 要件

## 12.1 基本スケジュール

点眼セッション開始時刻:

```text
06:00
08:00
10:00
12:00
14:00
16:00
18:00
20:00
22:00
```

2時間ごとに1セッション。

## 12.2 点眼薬

現在:

```text
1
2
2.5
3
```

ただし固定値にはしない。

将来的に追加・削除可能とする。

## 12.3 点眼間隔

各点眼の完了から次の点眼まで:

```text
5分以上
```

初期値 `5 minutes` とし、設定値として保持する。

---

# 13. 点眼スケジュールテンプレート

各時刻に、使用する点眼薬と順番を設定する。

例:

| 時刻 | 点眼順 |
|---|---|
| 06:00 | 1 → 2 → 2.5 → 3 |
| 08:00 | 1 → 2.5 |
| 10:00 | 1 → 2 → 3 |
| ... | ... |
| 22:00 | 1 → 2 → 2.5 → 3 |

上記は例であり、実際の処方内容を管理画面から設定する。

## 13.1 1日必要回数

各点眼薬に:

```text
required_daily_count
```

を設定可能とする。

スケジュール編集画面で:

```text
1     9 / 9 ✓
2     5 / 5 ✓
2.5   2 / 3 ⚠
3     4 / 4 ✓
```

のように検証する。

必要回数と一致しない場合、保存前に警告する。

---

# 14. 点眼セッションの基本フロー

16:00の例:

```text
16:00 到来
   ↓
通知ONの家族へ開始通知
   ↓
家族がアプリを開く
   ↓
[ この回を担当する ]
   ↓
最初に押した1人だけが担当者
   ↓
点眼1を実施
   ↓
[ 点眼1 完了 ]
   ↓
5分待機
   ↓
担当者だけにPush通知
   ↓
点眼2を実施
   ↓
[ 点眼2 完了 ]
   ↓
5分待機
   ↓
...
   ↓
全て完了
```

---

# 15. 点眼担当者の排他制御

1セッションにつき担当者は1人だけ。

## 15.1 担当取得

ユーザーが:

```text
[ この回を担当する ]
```

を押す。

DB側で原子的に:

```sql
UPDATE eye_drop_sessions
SET operator_user_id = current_user,
    status = 'in_progress',
    started_at = now()
WHERE id = :session_id
  AND operator_user_id IS NULL
RETURNING *;
```

相当の処理を行う。

実装ではSupabase RPC等を利用する。

### 成功

担当取得。

### 失敗

既に他のユーザーが担当している。

表示:

```text
この回は「母」が対応中です。
```

フロントエンドのボタン非表示だけに依存しない。

DB側で必ず排他する。

---

# 16. 点眼状態遷移

セッション:

```text
pending
   ↓
in_progress
   ↓
waiting
   ↓
ready
   ↓
waiting
   ↓
...
   ↓
completed
```

簡略化してDB上では:

- `pending`
- `in_progress`
- `completed`
- `cancelled`

とし、現在のstepと `next_due_at` で待機状態を表現してもよい。

---

# 17. 点眼完了処理

担当者が:

```text
[ 点眼1 完了 ]
```

を押した時刻をサーバー側で保存する。

```text
completed_at = server_now
```

次の点眼がある場合:

```text
next_due_at
= completed_at + 5 minutes
```

例:

```text
16:02:13 点眼1完了
↓
next_due_at = 16:07:13
```

---

# 18. 5分タイマー

## 18.1 フロント表示

```text
次: 点眼2

04:32
```

とカウントダウンする。

タイマーは:

```text
next_due_at - current_time
```

から計算する。

単純に5分間 `setTimeout` を走らせ続ける設計にはしない。

理由:

- iPhoneロック
- バックグラウンド化
- PWA終了

等でJavaScriptタイマーが停止・遅延する可能性があるため。

## 18.2 画面復帰

アプリを閉じて3分後に戻った場合でも:

```text
next_due_at
```

から残り時間を再計算するため正しい状態へ復帰する。

---

# 19. 次の点眼を早く実行しないための制御

UI上では `next_due_at` より前に次の完了ボタンを無効化する。

さらにサーバー側でも:

```text
server_now >= next_due_at
```

を検証する。

したがって端末の時計を変更しても、5分より早い完了記録を原則受け付けない。

---

# 20. 点眼Push通知

Push通知は2種類に分ける。

## 20.1 定時開始通知

対象:

```text
通知ONの家族全員
```

例:

```text
16:00の点眼時間です
今回: 1 → 2 → 2.5 → 3
```

通知を押すと該当セッション画面へ直接移動する。

---

## 20.2 5分後通知

対象:

```text
そのセッションの担当者のみ
```

例:

```text
16:07
点眼2の時間です
```

他の家族には通知しない。

ただし全員がリアルタイムで進捗を閲覧可能。

---

# 21. 個人別通知設定

各ユーザーが自分で設定できる。

例:

```text
通知設定

すべての通知
[ ON ]

定時点眼通知
[ ON ]

担当中の次回点眼通知
[ ON ]
```

最低限:

```text
master_enabled
```

を持つ。

推奨:

```text
master_enabled
scheduled_eye_drop_enabled
active_eye_drop_timer_enabled
```

ユーザーが通知OFFでも介護記録の閲覧・操作は可能。

## 21.1 OS通知権限

アプリ内設定とは別にOS側の通知許可が必要。

表示例:

```text
アプリ設定: ON
iPhone通知許可: ON ✓
```

通知権限がない場合:

```text
iPhone側で通知が許可されていません
```

と案内する。

---

# 22. 担当者が通知OFFの場合

通知OFFのユーザーも点眼担当になることはできる。

ただし担当取得時に:

```text
通知がOFFです。
画面上のタイマーは利用できますが、
バックグラウンドで次の点眼通知を受け取れません。
```

と警告する。

---

# 23. Push Subscription

端末ごとにWeb Push Subscriptionを保存する。

例:

```text
push_subscriptions
------------------
id
user_id
endpoint
p256dh
auth
enabled
created_at
last_seen_at
```

同じユーザーが複数端末を持つ場合、通知は有効な全端末に送信してよい。

個人単位のON/OFFは `notification_preferences` で管理する。

---

# 24. 通知ジョブ

DB:

```text
notification_jobs
-----------------
id
family_id
target_user_id
type
related_session_id
due_at
sent_at
cancelled_at
dedupe_key
payload
```

type例:

- `eye_drop_session_start`
- `eye_drop_next_step`

---

# 25. 5分通知のバックエンド処理

点眼完了時:

```text
next_due_atを保存
↓
notification_job作成
↓
target_user_id = operator_user_id
```

定期ディスパッチャ:

```text
due_at <= now()
AND sent_at IS NULL
AND cancelled_at IS NULL
```

を取得。

Push送信後:

```text
sent_at = now()
```

を保存する。

同じ通知を二重送信しないよう `dedupe_key` に UNIQUE制約を持たせる。

例:

```text
eye_step:<step_id>:ready
```

---

# 26. Cron精度

Supabase Cron等で1分ごとに通知ジョブを確認するMVPを想定する。

この場合、5分経過後のPushは:

```text
0〜約60秒程度遅延
```

する可能性がある。

重要な要件は:

```text
5分より早く通知しない
```

ことであり、数十秒の遅延を許容する。

より高精度な通知が必要になった場合は、将来外部の遅延ジョブキュー等へ移行する。

フロントエンドを開いている間はローカルカウントダウンで5分経過を即時表示できる。

---

# 27. 点眼担当引き継ぎ

担当者のスマホが使えなくなる可能性を考慮する。

他ユーザーには:

```text
担当: 母

[ 担当を引き継ぐ ]
```

を表示する。

押下時:

```text
本当に担当を引き継ぎますか？
```

と確認。

引き継ぎ後:

```text
operator_user_id = 新担当者
```

へ変更する。

未送信の5分通知ジョブは:

```text
旧担当 → 新担当
```

へ変更する。

既に完了した点眼履歴は変更しない。

---

# 28. 点眼リアルタイム共有

Supabase Realtimeを利用。

母が:

```text
16:02 点眼1完了
```

を押した場合、他端末にも即時反映する。

他ユーザー画面:

```text
16:00 点眼

担当: 母

1     ✓ 16:02
2     あと 03:21
2.5   ○
3     ○
```

担当者以外は原則として完了ボタンを押せない。

---

# 29. 点眼スケジュール変更

設定画面:

```text
点眼薬
 ├ 1
 ├ 2
 ├ 2.5
 └ 3

[ + 点眼薬追加 ]
```

時間ごとの編集:

```text
06:00
[1] → [2] → [2.5] → [3]

08:00
[1] → [2.5]
```

ドラッグ等で順番変更できると望ましいが、MVPでは上下ボタンでもよい。

## 29.1 適用日

設定変更は原則:

```text
翌日以降
```

に適用。

当日の生成済みセッションを自動変更しない。

必要なら「今日だけ変更」を別機能として将来追加する。

---

# 30. 排泄記録

ホーム画面に大きな2ボタンを配置する。

```text
[  小  ]      [  大  ]
```

押した時刻を即保存。

## 30.1 保存データ

```text
type
occurred_at
recorded_by
family_id
dog_id
```

type:

- `urine`
- `stool`

## 30.2 操作

「小」押下:

```text
小を15:42に記録しました
[ 取り消す ]
```

数秒間Undoを表示する。

「大」も同様。

## 30.3 履歴表示

```text
15:42 小
13:18 小
08:24 大
06:31 小
```

家族全員へRealtime反映する。

---

# 31. 健康イベントとしての拡張性

将来:

- 嘔吐
- 体重
- 服薬
- 体調
- メモ

を記録できるようにするため、内部的には汎用 `health_events` としてもよい。

例:

```text
health_events
-------------
id
family_id
dog_id
type
occurred_at
recorded_by
metadata
```

初期type:

```text
urine
stool
```

---

# 32. 推奨データモデル

以下は論理モデルであり、実装時に命名は変更可。

## 32.1 families

```text
id
name
created_at
```

## 32.2 dogs

```text
id
family_id
name
created_at
```

## 32.3 profiles

```text
user_id
display_name
created_at
```

## 32.4 family_members

```text
family_id
user_id
role
joined_at
```

UNIQUE:

```text
(family_id, user_id)
```

---

# 33. 食事関連テーブル

## 33.1 feeding_settings

```text
dog_id
target_kcal
max_water_ml
regular_set_kcal
regular_set_water_ml
chicken_meal_kcal
chicken_meal_water_counted_ml
soup_syringe_kcal
soup_syringe_water_ml
vomit_buster_water_ml
vomit_buster_daily_count
```

## 33.2 feeding_slots

```text
id
dog_id
date
scheduled_time
slot_type
status
completed_at
recorded_by
```

slot_type:

```text
normal
adjustment
```

## 33.3 feeding_events

```text
id
dog_id
family_id
event_type
kcal
water_ml
occurred_at
recorded_by
feeding_slot_id
created_at
```

event_type:

- `regular_set`
- `chicken_meal`
- `soup_syringe`
- `vomit_buster`
- `custom`

---

# 34. 点眼関連テーブル

## 34.1 eye_drop_types

```text
id
dog_id
display_name
required_daily_count
is_active
sort_order
created_at
```

## 34.2 eye_drop_schedule_templates

```text
id
dog_id
scheduled_time
is_active
```

## 34.3 eye_drop_schedule_template_steps

```text
id
template_id
eye_drop_type_id
step_order
interval_after_seconds
```

通常:

```text
interval_after_seconds = 300
```

最後のstepではnull。

## 34.4 eye_drop_sessions

```text
id
dog_id
family_id
date
scheduled_at
status
operator_user_id
started_at
completed_at
created_at
```

## 34.5 eye_drop_steps

```text
id
session_id
eye_drop_type_id
step_order
status
completed_at
completed_by
next_due_at
created_at
```

セッション生成時にテンプレートからコピーし、当日の履歴を固定する。

---

# 35. 通知関連テーブル

## notification_preferences

```text
user_id
master_enabled
scheduled_eye_drop_enabled
active_eye_drop_timer_enabled
updated_at
```

## push_subscriptions

```text
id
user_id
endpoint
p256dh
auth
enabled
created_at
last_seen_at
```

## notification_jobs

前述の構造を利用する。

---

# 36. 招待関連テーブル

## family_invites

```text
id
family_id
token_hash
created_by
expires_at
max_uses
used_count
revoked_at
created_at
```

生のinvite tokenはDBに保存せずhash化することを推奨する。

---

# 37. Realtime購読対象

最低限:

```text
feeding_events
feeding_slots

eye_drop_sessions
eye_drop_steps

health_events
```

変更を受信したら、フロントのローカル状態を更新する。

---

# 38. RLS

全主要テーブルにRLSを有効化する。

基本ルール:

```text
ユーザーがそのfamilyのfamily_membersに存在する場合のみ
そのfamilyのデータを閲覧可能
```

書き込みも同様。

## 38.1 自分専用

以下は本人のみ更新可能:

```text
notification_preferences
push_subscriptions
```

## 38.2 担当ロック

`operator_user_id` は通常の直接UPDATEを許可せず、専用RPC経由で更新することを推奨する。

---

# 39. 主要RPC / サーバー処理

実装候補:

```text
claim_eye_drop_session(session_id)
complete_eye_drop_step(step_id)
takeover_eye_drop_session(session_id)
record_feeding_event(...)
record_health_event(...)
accept_family_invite(token, display_name)
```

重要な状態変更はDB側トランザクションで処理する。

---

# 40. 画面構成

推奨ナビゲーション:

```text
今日 | 食事 | 点眼 | 履歴
```

右上:

```text
⚙ 設定
```

---

# 41. 今日画面

表示順:

1. 進行中点眼
2. 次回点眼
3. 食事状況
4. 排泄ボタン
5. 本日の簡易履歴

---

# 42. 点眼進行画面

例:

```text
16:00 点眼

担当: 母

1     ✓ 16:02

次: 2

あと
04:13

2     待機中
2.5   未実施
3     未実施
```

担当者のみ操作ボタンを表示。

5分経過後:

```text
点眼2の時間です

[ 点眼2 完了 ]
```

---

# 43. 点眼一覧画面

```text
06:00 ✓ 完了
08:00 ✓ 完了
10:00 ✓ 完了
12:00 ✓ 完了
14:00 ✓ 完了
16:00 ● 進行中
18:00 ○
20:00 ○
22:00 ○
```

各セッションをタップして詳細確認可能。

---

# 44. 食事画面

表示:

```text
カロリー
142 / 198 kcal

水分
148 / 200 ml

残り通常セット
2

次回
16:00 通常セット
```

操作:

```text
[ 通常セットを与えた ]
[ 鶏ごはんを食べた ]
[ ボミットバスター ]
[ スープ缶シリンジ ]
```

全操作は記録後に再計算する。

---

# 45. 排泄UI

今日画面に常時表示。

```text
排泄

[ 小 ]   [ 大 ]

最終
小 13:18
大 08:24
```

長押し等は不要。

誤操作はUndoで対応する。

---

# 46. 履歴画面

時系列で統合表示可能とする。

例:

```text
16:07 点眼2      母
16:02 点眼1      母
15:42 小         父
14:03 通常セット 自分
13:18 小         母
12:11 点眼3      母
```

フィルター:

- 全て
- 食事
- 点眼
- 排泄

---

# 47. 設定画面

## 個人設定

- 表示名
- 通知ON/OFF
- 定時点眼通知
- 担当中タイマー通知

## 家族設定

admin:

- 家族名
- 招待リンク作成
- メンバー確認

## 食事設定

- 目標kcal
- 水分上限
- 各食品の値

## 点眼設定

- 点眼薬一覧
- 1日必要回数
- 2時間ごとのスケジュール
- 間隔（初期5分）

---

# 48. エラー・警告

## 水分超過

```text
この操作を行うと水分が200mlを超えます。
```

通常セットは登録不可にすることを推奨。

管理者による例外記録が必要なら、別途「実績として記録」機能を設ける。

## 点眼二重担当

```text
この回はすでに母が担当しています。
```

## 点眼早期実施

```text
次の点眼まであと1分32秒です。
5分経過後に実施してください。
```

## Push無効

```text
通知が無効です。
バックグラウンド通知を受け取れません。
```

## オフライン

```text
現在オフラインです。
共有状態が最新ではない可能性があります。
```

重要な介護操作をオフラインでキューイングする場合は、競合処理が複雑になる。

MVPでは点眼担当取得・完了など排他性の高い操作はオンライン必須とすることを推奨。

---

# 49. 二重操作防止

## 食事

同じ時間枠の通常セットを複数回完了できないよう:

```text
UNIQUE(dog_id, date, scheduled_time, slot_type)
```

等でslotを一意にする。

完了処理はidempotentにする。

## 点眼

1stepの `completed_at` は1回だけ設定可能。

担当者以外による完了は禁止。

---

# 50. 時刻の扱い

DBではUTCで保存。

UIでは利用地域のローカルタイムに変換する。

現状は日本時間（Asia/Tokyo）を初期設定とする。

日次スケジュール生成は犬の設定タイムゾーンを基準とする。

---

# 51. 日次生成処理

毎日、翌日分または当日早朝に:

```text
feeding_slots
eye_drop_sessions
eye_drop_steps
```

をテンプレートから生成する。

推奨:

```text
翌日0:05頃
```

または数日先まで事前生成してもよい。

生成処理は二重実行しても重複しないようUNIQUE制約を設ける。

---

# 52. 定時Push生成

各点眼セッションごとに、開始時刻用通知を送る。

送信時に:

```text
family_members
+
notification_preferences
+
push_subscriptions
```

を参照。

通知OFFユーザーには送らない。

---

# 53. Service Worker

役割:

- PWAキャッシュ
- Pushイベント受信
- Notification表示
- notificationclick処理

通知クリック:

```text
/eyedrops?session=<session_id>
```

等を開く。

---

# 54. セキュリティ

以下をフロントエンドに置かない。

- Supabase service role key
- VAPID private key
- その他秘密鍵

公開可能:

- Supabase anon key
- VAPID public key

秘密情報はSupabase Secrets等へ保存。

---

# 55. データ保全

介護履歴は重要なため:

- DBを正とする
- `created_at`
- `recorded_by`
- `occurred_at`

を分ける。

例:

```text
実際に小をした時刻 = occurred_at
ユーザーが登録した時刻 = created_at
```

MVPでは押した瞬間に両方同じでよい。

---

# 56. 非機能要件

## UI

- iPhoneで片手操作可能
- 主操作ボタンは十分大きくする
- 1〜2タップで記録可能
- 今やるべき操作を最優先表示
- 誤操作防止の確認を必要な操作だけに使う

## 性能

Realtime変更:

```text
通常数秒以内
```

を目標。

## 可用性

ネットワーク障害時に:

- 最終取得状態を表示
- 「オフライン」を明示

## アクセシビリティ

色だけで状態を区別しない。

例:

```text
✓ 完了
● 進行中
○ 未実施
```

を併記。

---

# 57. テストケース

## 食事 TC-F01

条件:

```text
鶏ごはん0回
通常セット8回
ボミットバスター2回
```

期待:

```text
192 kcal
194 ml
```

22時追加を推奨しない。

---

## 食事 TC-F02

194ml時点で通常セット追加。

期待:

```text
217mlになるため拒否
```

---

## 食事 TC-F03

鶏ごはんを追加。

期待:

- 39.9kcal加算
- 水分加算なし
- 未来の通常セット予定のみ再計算
- 過去履歴変更なし

---

## 食事 TC-F04

未投与ボミットバスター1回が残っている。

期待:

5mlを予約した状態で通常セット可能数を計算。

---

## 点眼 TC-E01

16:00に母と父が同時に担当ボタンを押す。

期待:

片方のみ成功。

---

## 点眼 TC-E02

母が16:02に点眼1完了。

期待:

```text
next_due_at = 16:07
```

通知ジョブのtargetは母。

---

## 点眼 TC-E03

父の通知ON、自分の通知ON、母が担当。

5分後:

期待:

```text
母だけにPush
```

---

## 点眼 TC-E04

担当者以外が完了APIを呼ぶ。

期待:

拒否。

---

## 点眼 TC-E05

5分経過前に完了APIを呼ぶ。

期待:

拒否。

---

## 点眼 TC-E06

アプリをバックグラウンドにして5分経過。

期待:

担当者にPush。

---

## 点眼 TC-E07

担当引き継ぎ。

期待:

- operator変更
- 未送信Pushのtarget変更
- 過去step履歴維持

---

## 点眼 TC-E08

通知OFFユーザーが担当。

期待:

- 担当可能
- Pushなし
- 通知OFF警告表示
- 画面タイマーは利用可能

---

## 排泄 TC-H01

「小」ボタン押下。

期待:

現在時刻でurineイベント作成。

---

## 排泄 TC-H02

家族Aが「大」を記録。

期待:

家族B画面にRealtime反映。

---

## 招待 TC-A01

inviteリンクから参加。

期待:

- family membership作成
- Auth session保存
- URLからinvite除去
- 通常URLから再起動しても同期可能

---

# 58. 段階的実装計画

## Phase 1: Supabase基盤

- Supabase Project作成
- Auth導入
- family / member
- 招待リンク
- RLS
- 既存食事データのクラウド化
- Realtime

この時点で家族共有を安定させる。

## Phase 2: 排泄記録

- 小・大ボタン
- 履歴
- Realtime
- Undo

比較的実装容易なので早期導入する。

## Phase 3: 点眼基本管理

- 点眼薬マスタ
- スケジュールテンプレート
- 日次セッション生成
- 担当取得
- 5分タイマー
- Realtime進捗
- 担当引き継ぎ

Pushなしでもまず動作確認する。

## Phase 4: Web Push

- Service Worker Push
- VAPID
- Push Subscription
- 個人別通知設定
- 定時通知
- 5分後通知
- notification_jobs
- Cron / Edge Function

## Phase 5: UI統合

- 今日画面
- 食事
- 点眼
- 排泄
- 履歴
- 設定

## Phase 6: 運用改善

実際に家族で数日使い、

- ボタン位置
- 誤操作
- 通知頻度
- 文字サイズ
- 操作ステップ数

を調整する。

---

# 59. 実装優先順位

最優先:

1. データ共有の一貫性
2. 水分上限ロジック
3. 点眼二重実施防止
4. 点眼5分間隔
5. Push通知
6. 操作の簡便性

見た目の作り込みは後回しでよい。

---

# 60. 将来拡張

将来追加候補:

- 体重記録
- 嘔吐記録
- 投薬
- 写真
- 便の状態
- 尿量
- 食欲
- 体調メモ
- 日次サマリー
- 週次グラフ
- CSV出力
- 獣医師向け共有
- 家族ごとの操作統計
- Apple/Googleカレンダー連携
- 通知のスヌーズ
- 点眼実施遅延アラート
- 複数の犬
- 介護対象ごとの設定

---

# 61. 実装上の重要注意事項

## 61.1 `invite` に依存し続けない

招待リンクは「参加」にのみ使用する。

ホーム画面起動時はSupabase Auth sessionからfamilyを特定する。

## 61.2 setTimeoutをバックグラウンドタイマーとして信用しない

5分の基準はDBの `next_due_at`。

Pushはサーバーから送る。

## 61.3 重要操作はDB側で検証

特に:

- 点眼担当取得
- 点眼完了
- 5分経過チェック
- 水分超過チェック

はフロントだけに依存しない。

## 61.4 過去記録を設定変更で書き換えない

当日セッションはテンプレートをコピーして固定する。

## 61.5 Pushは補助でありDBを正とする

Pushが届かなかった場合も、アプリを開けば正しい進捗が分かる状態にする。

---

# 62. MVP完成条件

以下がすべて満たされたら、家族で本運用可能なMVPとする。

### 家族共有

- 招待リンクから参加可能
- ホーム画面追加後も同じデータへアクセス可能
- 誰が操作したか表示可能

### 食事

- kcal / 水分集計
- 水分200ml超過防止
- 通常セット記録
- 鶏ごはん記録
- ボミットバスター記録
- スープ缶記録
- 未来予定再計算
- 22時調整

### 点眼

- 06〜22時、2時間ごとのスケジュール
- 点眼種類編集
- 1日必要回数確認
- 1人だけ担当可能
- 完了から5分後に次工程
- 家族全員へRealtime進捗共有
- 担当者だけに5分Push
- 定時Push
- 個人別Push ON/OFF
- 担当引き継ぎ

### 排泄

- 小ワンタップ
- 大ワンタップ
- 時刻記録
- Realtime共有
- 履歴確認

---

# 63. 最終的な利用イメージ

```text
15:42
母が「小」を押す
↓
家族全員に記録反映

16:00
通知ONの家族へ
「16時の点眼です」
↓
母が「この回を担当する」
↓
母だけが担当者になる
↓
家族全員の画面:
「16時 点眼 / 担当: 母」
↓
16:02
母「点眼1 完了」
↓
next_due_at = 16:07
↓
全員の画面:
「点眼2まであと5分」
↓
16:07以降
母だけにPush
「点眼2の時間です」
↓
最後の点眼完了
↓
16時セッション ✓
```

同時に食事画面では、その日の摂取実績から未来のシリンジ予定を再計算し、水分200mlを超えない範囲で管理する。

この構成により、食事・点眼・排泄という日常の介護作業を一つのPWAで共有し、家族間の二重対応や記録漏れを減らすことを目指す。
