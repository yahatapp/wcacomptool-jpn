# WCA Competition Assignment Tool

WCA大会の登録CSVから、グループ分けとスタッフ役割を作成するローカルWebアプリです。TanStack Startの画面から、FastAPI + Google OR-Tools CP-SATのPython APIを呼び出します。

## 使用ライブラリとUI

- フロントエンド：TanStack Start / Router、React 19、Tailwind CSS 4。
- UI：shadcn/ui（Button、Input、Card、Switch）、Radix UI（Slot、Switch）、Lucide React（アイコン）。スタイルの結合にはclsx、tailwind-merge、class-variance-authorityを使用します。
- 開発・ビルド：TypeScript、Vite、TanStack Devtools、Cloudflare Vite Plugin / Wrangler。
- バックエンド：FastAPI、Uvicorn、OR-Tools、HTTPX、python-multipart。

画面は白背景のライトテーマに固定しています。OSのダークモード設定や、以前保存したテーマ設定には追従しません。色と角丸の共通設定は `web/src/styles.css`、shadcn/uiのコンポーネントは `web/src/components/ui`、追加コンポーネントの設定は `web/components.json` にあります。

既存のReact / Tailwind構成に合わせ、[TanStack Start向けの公式導入手順](https://ui.shadcn.com/docs/installation/tanstack)があるshadcn/uiを採用しています。TanStack自体は画面のデザインを指定しません。Material Design 3の候補として検討した [Material Web](https://github.com/material-components/material-web) は、公式リポジトリでメンテナンスモードと案内されているため、今回は導入していません。

TanStack Devtoolsの画面は開発時も通常は非表示です。必要な場合は `VITE_SHOW_DEVTOOLS=true pnpm --dir web dev` で起動してください。

## 起動

Nixとdirenvをインストールし、リポジトリルートで実行してください。

```sh
direnv allow
pnpm --dir web install --frozen-lockfile
uv sync --project backend --locked
python scripts/dev.py
```

- Web: http://127.0.0.1:3000
- APIドキュメント: http://127.0.0.1:8000/docs

開発シェルはNode.js 22、pnpm、Git、Python 3.12、uvを提供します。Python依存は `backend/uv.lock`、JavaScript依存は `web/pnpm-lock.yaml` に固定しています。direnvを使わない場合は `nix develop` に入ってから同じコマンドを実行できます。

`scripts/dev.py` はWebとAPIを一緒に起動します。Ctrl-Cで両方を停止します。個別に起動する場合は別々のターミナルで実行してください。

```sh
uv run --project backend --locked python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
pnpm --dir web dev
```

## 操作

1. WCAの登録CSVと大会日を指定し、CSVを読み込みます。
2. 大会名、競技卓数、競技ごとのグループ数・スクランブラー数・ランナー数を設定します。
3. 参加者の年齢・初参加・ジャッジ免除・スクランブラー免除・運営専任の条件を確認します。
4. 「WCAから自己ベスト・平均記録を取得」で記録を補完します。必要に応じて手動で修正してから、役割分担を計算します。
5. 競技・グループごとの結果を確認し、結果CSVをダウンロードします。
6. 「CSVの参加競技をチェック」で元の登録CSVと結果CSVを選び、一致するか確認します。既存の結果CSVのチェックだけにも使えます。

「サンプルで試す」は架空の12人・2競技のCSVを読み込みます。共有されたTokaiAutumn2026のCSVには承認済み参加者が1人だけいるため、そのデータだけでは役割分担が成立しません。人数不足は必要人数・候補者数として表示します。

## WCA登録CSVと追加情報

`comp-grouping` の `src/input_loader.py` は、WCA登録CSVではなく `competition.csv`、`events.csv`、`competitors.csv`、`registrations.csv` の4ファイルを入力としています。このアプリはWCA登録CSVをAPIで変換し、足りない情報を画面から補います。

| 情報 | 取得・指定方法 |
| --- | --- |
| 名前・参加者ID・参加競技 | CSVのName、Registrant Id（なければUser Id）、各競技の0/1列 |
| 対象の参加者 | Registration Statusがacceptedの行。空欄・列がない場合のみStatusがaの行 |
| 年齢 | CSVのBirth Dateと、画面で指定した大会日から算出。画面で修正可能 |
| 初参加 | WCA IDが空欄なら初参加と推定。画面で修正可能 |
| 大会名・大会日 | 大会名の初期値はCSVファイル名。大会日は入力必須 |
| 競技卓数 | 画面で入力 |
| グループ数・スクランブラー数・ランナー数 | 画面で入力。初期値は仮設定 |
| ジャッジ免除・スクランブラー免除・運営専任 | CSVにはないため画面で指定 |
| ベスト・平均記録 | CSVにはないためWCA APIから取得、または画面で入力。未入力でも計算可能 |

平均記録がない参加者は、その競技の速度順グループ分けでは末尾にCSV順で並び、スクランブラーの速度優先スコアは0になります。ベスト記録は保持しますが最適化には使いません。タイムの単位は秒（最少手数競技は手数）です。

連絡先、IP、コメント、性別などの不要な列は変換結果に含めません。アップロードCSVは処理後に破棄し、アプリに永続保存しません。画面の設定と結果も永続保存せず、再読み込みで入力は消えます。

## 結果CSVと参加競技のチェック

結果CSVは、提示された最終CSVと同じ「1人1行、Name列と競技IDの列」の形式です。Nameは登録名の最初の `(` より前の英語名を出力し、括弧内の母国語名を除きます。競技列は大会設定の順、参加者は名前順で出力します。各セルはセミコロンで区切り、数字のみが競技グループ、Jがジャッジ、Sがスクランブラー、Rがランナーです。例えば `2;J3;S4;R5` はグループ2で競技、3でジャッジ、4でスクランブラー、5でランナーを表します。担当のない競技は空欄です。

```csv
Name,333,clock
Example A,2;J3;S4,J1
Example B,R1,1;J2
```

「CSVの参加競技をチェック」は、元のWCA登録CSVの0/1列と結果CSVの数字のみの項目を比較します。スタッフ役割だけのセルは参加競技に数えません。登録の対象は読み込みと同じく承認済み・参加競技のある人です。大会日、生年月日、WCA ID、登録者IDはこのチェックには不要です。形式はUTF-8（BOMあり・なし）、各5MB以下、各1000行以下です。

登録CSVの名前は最初の `(` より前の英語名を使い、名前の前後・連続する空白をそろえて照合します。不足・余分な参加競技、結果から抜けている参加者、結果にだけいる人を表示します。母国語名を除いた後の同名や重複行は推測で対応付けず、照合不可として表示します。参加競技のある競技列が結果CSVから省かれている場合も不足として表示します。不正なセルや同じ競技に複数の競技グループがある場合はCSVの修正を求めます。今回のチェック対象は参加競技の一致のみです。

## WCA記録の取得

「自己ベスト・平均記録を補完する」のすぐ上に取得ボタンを設置しています。全参加者のWCA IDを使って、[WCAサイトの記録専用API](https://github.com/thewca/worldcubeassociation.org/blob/main/app/controllers/api/v0/persons_controller.rb)から、各競技の公式自己ベスト（single）と公式平均自己ベスト（average）を取得します。「平均」は過去全大会の平均値ではなく、WCAランキングに掲載される自己ベスト平均です。

- WCAへ送るのはWCA IDのみです。名前、連絡先、年齢、登録CSVは送信しません。
- 1人分の全競技記録を1回で取得し、その人の参加競技だけに反映します。同じWCA IDはまとめて取得し、WCA IDなし・形式不正の人は対象外です。参加者検索の絞り込みには影響されません。
- 同時リクエストは1件、外部リクエストの開始間隔は最低1秒です。バックエンド内で制限するので、複数タブからの操作でも集中させません。
- 成功した記録はAPIプロセスのメモリに6時間キャッシュします（最大2,000人、サーバー再起動で消去）。再実行時はキャッシュを利用します。
- 接続エラー・5xx・429は最大2回リトライします。指数バックオフと `Retry-After` に従い、長い待機を要求されたときは取得を停止します。ブラウザ側も429・503などで残りの取得を停止します。
- 進捗、補完件数、キャッシュ利用件数、取得失敗の一覧を表示します。停止ボタンを押すと現在の1人分の完了後に停止し、取得済みの記録は保持します。
- 初期設定は空欄の補完のみです。「入力済み記録を上書きする」を有効にした場合も、WCAに記録がない項目は消しません。
- 公式平均がない競技は平均を補完しません。単発記録から平均を推定しません。複数目隠しの符号化スコアは秒数として扱えないため、自動補完の対象外です。

WCAの1/100秒形式を秒へ変換します。最少手数はsingleを手数のまま、averageを1/100手から手数へ変換します。取得時点の現行記録を使うため、過去の大会日を指定してもその時点の歴史的な記録にはなりません。WCAのv0 APIは仕様変更・停止の可能性があるため、失敗時は手動入力も利用してください。

## 最適化のルール

同じローカルの `comp-grouping/src/solver.py` の実装を基に、2段階の処理を移植しました。

- 平均記録の速い順に、同じ実力の人がまとまるよう均等なサイズのグループを作成。
- OR-Toolsでスクランブラー、ジャッジ、ランナーを割り当て。
- 自分の競技グループと、その直前グループにはスタッフ役割を付けない。
- ジャッジは13歳以上・初参加ではない・ジャッジ免除ではない人。
- スクランブラーは該当競技の参加者・スクランブラー免除ではない人。
- 運営専任（参照コードのis_staff）は、競技以外のすべての役割から免除。
- 同一競技・同一グループの役割を兼任しない。
- 速度優先と大会全体の役割回数の偏りを重み付きで最適化。

参照READMEと実装には違いがあるため、**実際のソルバー実装**に合わせています。ジャッジは競技卓数ではなく、そのグループの競技者と同じ人数が必要です。競技卓数を超えるグループは待機席が必要という警告を表示します。

移植時に、候補者が0人の場合にも役割人数制約を適用するよう修正しました。求解後は全登録の競技グループ、必要人数、資格、兼任、直前グループ制約を独立に検証し、違反がある結果は出力しません。

競技の同時進行、後続ラウンド、参加者以外のスタッフ、WCA APIへの反映はまだ対象外です。最初のラウンドの各競技を順番に実施する前提です。

## API

| メソッド・パス | 処理 |
| --- | --- |
| GET /api/health | 起動確認 |
| GET /api/wca/records/{wca_id} | 公開WCA記録の取得。秒・手数に変換した記録、取得時刻、キャッシュ利用有無を返却 |
| POST /api/import | multipartのfileとcompetition_dateから登録データへ変換 |
| POST /api/solve | 大会設定・参加者・記録をJSONで受け取り、検証済みの割り当てとCSV文字列を返却 |
| POST /api/check-participation | multipartのregistration_fileとresult_fileから参加競技の一致・相違点を返却 |

グループ番号はAPI・CSVでは1始まりです。CSVはExcel向けにブラウザでUTF-8 BOMを付けてダウンロードします。計算時間は1〜120秒で指定できます。同時に1件の計算を受け付けます。

## 検証

```sh
uv run --project backend --locked pytest backend/tests
uv run --project backend --locked ruff check backend/app backend/tests
pnpm --dir web build
pnpm --dir web test
nix flake check
```

## Cloudflare Workers

Web側のCloudflare Vite PluginとWrangler設定は維持しています。ただし現在のPython APIはローカルで動作し、Webの開発・プレビューサーバーが `/api` を `127.0.0.1:8000` に転送します。公開時にはPython APIの配置と認証、Webからの接続方法を別途決める必要があります。ローカルAPIは通常のCloudflare Workersデプロイには含まれません。
