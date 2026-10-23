# SESAME 実機検証の手順書

KAGI の SESAME ドライバ（`@kagi/driver-sesame`）が、実機で期待どおりに動くかを確かめるための手順です。
所要時間は 30 分ほどです。結果は末尾の「記録表」に書き込み、出力と一緒に共有してください。ドライバのエラーの扱いを、実機の挙動に合わせて直すのに使います。

> **安全のために:** ドアの前（または内側）にいる状態で行ってください。終わったら、施錠されていることを目と SESAME アプリの両方で確かめてください。

## 0. 前提

- [ ] SESAME 本体（3 / 4 / 5 / 5 Pro）が、SESAME アプリに登録されている
- [ ] **Hub3 か Wi-Fi モジュール 2** が SESAME とつながっていて、アプリから遠隔で開け閉めできる
      （Web API は、これらの機器を経由してしか届きません。家の外の回線からアプリで開け閉めできれば OK）
- [ ] 自分がその SESAME の **オーナー（またはマネージャー）** である
- [ ] Mac に Bun が入っていて、KAGI のリポジトリが手元にある（`bun install` 済み）

## 1. 3 つの値を集める

`.env.example` を `.env` にコピーして、次の 3 つを埋めます。`.env` は Git に入らない設定になっています。

```sh
cp .env.example .env
```

| 変数 | 中身 | 取り方 |
| --- | --- | --- |
| `SESAME_API_KEY` | アカウントごとの API キー | [SESAME Biz の開発者向けページ](https://biz.candyhouse.co/biz/developer) にログインして発行する。**表示は発行した直後だけ**なので、すぐ控える |
| `SESAME_UUID` | 機器の UUID（`XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`） | SESAME アプリで、その SESAME の設定画面（「…」メニュー）に表示される。コピーできないことがあるので、写し間違いに注意 |
| `SESAME_SECRET_KEY` | 機器ごとの秘密鍵（16 進 32 文字） | 下の「秘密鍵の取り方」を参照 |

任意で、`KAGI_PROBE_NAME`（アプリの履歴に出す名前）も設定できます。

### 秘密鍵の取り方

**A. 開発者向けページで出す（まずこちら）**

1. SESAME アプリで、その SESAME の「鍵のシェア」から、**オーナー（またはマネージャー）の鍵の QR コード**を表示し、スクリーンショットを撮る
2. [SESAME Biz の開発者向けページ](https://biz.candyhouse.co/biz/developer) で QR コードの画像を読み込ませ、表示された秘密鍵（16 進 32 文字）を控える

画面の作りは変わることがあります。見つからなければ B を試してください。

**B. QR コードから自分で取り出す（非公式の方法）**

QR コードを読み取ると、`ssm://UI?t=sk&sk=XXXX…&l=…&n=…` のような URL が出てきます。この `sk=` の値を使って、次を実行します。

```sh
bun -e 'const sk = decodeURIComponent(process.argv[1]); const b = Buffer.from(sk, "base64"); console.log(b.subarray(1, 17).toString("hex"))' '<sk の値>'
```

32 文字の 16 進が出れば、それが秘密鍵です。この方法は公式の文書には無く、個人のブログで紹介されているものです。

> **秘密鍵と QR コードは、鍵そのものです。** Slack やスクリーンショットで人に送らないでください。検証が終わったら、スクリーンショットは削除してください。

## 2. 状態を読む（鍵は動かない）

```sh
bun run probe sesame state
```

| 結果 | 意味 |
| --- | --- |
| `locked` / `unlocked` | API キーと UUID は正しい → 次へ |
| `unknown` | サムターンが途中の位置（`moved`）にある。手で回しきってから、もう一度 |
| `sesame: unauthorized (HTTP 403 …)` | API キーが違う |
| `sesame: invalid_device (HTTP 404 …)` | UUID が違う、または Hub3 / Wi-Fi モジュールとつながっていない |
| その他のエラー | 出力をそのまま記録表に貼る |

## 3. 施錠する（秘密鍵と署名の確認）

先に施錠で試すのは、失敗しても家が開いたままにならないからです。

```sh
bun run probe sesame lock
```

- 期待する結果: `{ ok: true }` が返り、**数秒以内にサムターンが施錠側へ回る**
- `{ ok: false, reason: "unauthorized" | "vendor_error", detail: "HTTP 4xx …" }` が返る場合:
  1. 秘密鍵の写し間違いを疑う（32 文字か、`0` と `O` の取り違えは無いか）
  2. Mac の時計がずれていないかを確かめる（`date` の結果と、スマホの時刻を比べる）。署名には現在時刻を使います
- `{ ok: true }` なのに鍵が動かない場合: **重要な観察です。** 記録表に書いてください。Hub3 が届いていない可能性があります

## 4. 解錠する（本番と同じ流れ）

```sh
bun run probe sesame unlock
```

Gate を通して解錠します。流れは「命令を送る → 1 秒ごとに状態を読み直す（最大 8 秒）→ 監査ログを 1 行出す」です。

- 期待する結果（2 行出ます）:
  ```
  {"type":"unlock.succeeded",...,"verified":true,"durationMs":...}
  { status: "unlocked", verified: true }
  ```
- `verified: false` が返る場合: 鍵は開いたが、8 秒以内に API の状態が `unlocked` にならなかったということです。`durationMs` と、実際に回り終わるまでの体感の秒数を記録してください（確認の待ち時間の調整に使います）

終わったら施錠しておきます。

```sh
bun run probe sesame lock
```

## 5. 履歴を確かめる

```sh
bun run probe sesame history
```

- 期待する結果: いちばん上の方に `type 17`（Web API で解錠）と `type 16`（Web API で施錠）があり、`tag` が `KAGI_PROBE_NAME` の値になっている
- SESAME アプリの履歴にも同じ名前が出ているかを、目で確かめる

### 日本語の名前

```sh
KAGI_PROBE_NAME="みぞぶちテスト" bun run probe sesame lock
bun run probe sesame history
```

- 期待する結果: アプリの履歴に「みぞぶちテスト」と出る
- 名前の上限は 21 バイト（日本語なら 7 文字）なので、ドライバが自動で切り詰めます。8 文字以上の名前で、切り詰めた結果が正しく表示されるかも見てください

## 6. 失敗のさせ方を観察する（任意、時間があれば）

ドライバがエラーを正しく分類できるように、**実際に返ってくる HTTP のステータスと本文**を集めます。

| やること | 実行するコマンド | 知りたいこと |
| --- | --- | --- |
| Hub3 / Wi-Fi モジュールの電源を抜く | `bun run probe sesame lock` | 何が返るか（エラーか、`ok: true` なのに動かないのか）。終わったら電源を戻す |
| `.env` の秘密鍵の 1 文字を変える | `bun run probe sesame lock` | 署名が違うときのステータスと本文。終わったら元に戻す |
| `.env` の API キーの 1 文字を変える | `bun run probe sesame state` | 認証エラーのステータス（403 か 401 か）。終わったら元に戻す |
| サムターンを手で中途半端な位置にする | `bun run probe sesame state` | `unknown`（`moved`）になるか |

> 何度も続けて実行すると、HTTP 429 が返ることがあります（回数の上限は公開されていません）。1 回ごとに数秒空けてください。

## 7. ブラウザで通しで試す（任意、Pocket ID を使う）

ターミナルで動いたら、本番と同じ「ページを開く → ログイン → ボタン」の流れを Mac のブラウザで試せます。ログインには Pocket ID（OIDC）を使います。

1. Pocket ID の管理画面で、**OIDC クライアント**を追加する
   - 名前: `KAGI`
   - Callback URL: `http://localhost:8080/auth/callback`
   - **Public client** を有効にし、**PKCE** を有効にする（クライアントシークレットは不要）
2. Pocket ID で、`door:home` という名前の**グループ**を作り、自分を入れる。KAGI のクライアントがグループの情報を受け取れる設定になっているかも確かめる
3. `.env` を埋める
   ```sh
   KAGI_AUTH=oidc
   OIDC_ISSUER=https://<Pocket ID のドメイン>
   OIDC_CLIENT_ID=<1 で表示された Client ID>
   OIDC_SCOPES=openid profile email groups
   KAGI_SESSION_SECRET=<下のコマンドの出力>
   KAGI_DOORS='[{"id":"home","name":"自宅","driver":"sesame","device":{"uuid":"<UUID>","secretKey":"<秘密鍵>"}}]'
   ```
   `KAGI_SESSION_SECRET` は `bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())'` で作れます
4. サーバを起動して、ブラウザで開く
   ```sh
   bun run dev
   open http://localhost:8080/d/home
   ```

| 確かめること | 期待する結果 |
| --- | --- |
| ページを開く | Pocket ID のログイン画面（パスキー）に移り、ログインすると「自宅」と「開ける」ボタンのページに戻ってくる |
| ページを開いただけ | **鍵は動かない**（GET では開けない） |
| 「開ける」を押す | 鍵が開き、「開きました」と出る。ターミナルに `unlock.succeeded` の JSON が 1 行出る |
| 5 秒以内にもう一度押す | 「押したばかりです」と出て、鍵は動かない |
| `door:home` から自分を外し、`/auth/logout` を開いてから、もう一度ログインして押す | 「このドアを開ける権限がありません」と出て、鍵は動かない |
| `/d/xxx`（存在しないドア）を開く | 「そのドアは見つかりません」と出る |

> グループから外しても、**KAGI のログイン（既定で 12 時間）が切れるまでは前の権限のまま**です。DB を持たない代わりの仕様です。すぐに効かせたいときは、`/auth/logout` を開くか、`KAGI_SESSION_SECRET` を変えて全員をログアウトさせます。

Clerk で試す場合は、`KAGI_AUTH=clerk` にして、`CLERK_PUBLISHABLE_KEY` と `CLERK_SECRET_KEY` を入れます。権限は、Clerk のユーザーの Public metadata に `{"doors": ["home"]}` を入れて付けます。

スマホから試すには、Mac の外から届く URL が必要です（`cloudflared tunnel` や `ngrok` など）。その場合は、`KAGI_PUBLIC_ORIGIN` と Pocket ID の Callback URL を、その URL に変えてください。

## 8. 終わったら

- [ ] 鍵が施錠されていることを、目とアプリで確かめた
- [ ] 秘密鍵の QR コードのスクリーンショットを消した
- [ ] `.env` は手元にだけある（`git status` に出てこない）

## 記録表

| # | 手順 | 結果（出力を貼る） | 期待どおり？ |
| --- | --- | --- | --- |
| 2 | `state` | | |
| 3 | `lock` | | |
| 4 | `unlock`（`durationMs`、体感の秒数） | | |
| 5 | `history`（`type` と `tag`） | | |
| 5 | 日本語の名前 | | |
| 6 | Hub3 / Wi-Fi モジュールを外したとき | | |
| 6 | 秘密鍵が違うとき | | |
| 6 | API キーが違うとき | | |
| 6 | サムターンが途中の位置のとき | | |

機種: SESAME ___ / 中継の機器: Hub3・Wi-Fi モジュール 2 / 日付: ____
