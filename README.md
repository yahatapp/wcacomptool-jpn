# WCA Competition Assignment Tool

WCA大会の登録CSVから、グループ分けとスタッフ役割を作成するWebアプリです。CSV読み込み・チェック・役割分担・結果CSV出力はブラウザ内で完結します。OR-Tools CP-SATをWebAssemblyで実行し、Python APIは不要です。WCA記録を自動取得する場合だけ、ブラウザからWCAへ通信します。

## 使用ライブラリとUI

- フロントエンド：TanStack Start / Router、React 19、Tailwind CSS 4。
- UI：shadcn/ui（Button、Input、Card、Switch）、Radix UI（Slot、Switch）、Lucide React（アイコン）。スタイルの結合にはclsx、tailwind-merge、class-variance-authorityを使用します。
- 開発・ビルド：TypeScript、Vite、TanStack Devtools、Cloudflare Vite Plugin / Wrangler。
- ブラウザ内の計算：or-tools-wasm（Web WorkerでOR-Toolsを実行）。
- 比較用の旧バックエンド：FastAPI、Uvicorn、OR-Tools、HTTPX、python-multipart。通常の利用では起動しません。

画面は白背景のライトテーマに固定しています。OSのダークモード設定や、以前保存したテーマ設定には追従しません。色と角丸の共通設定は `web/src/styles.css`、shadcn/uiのコンポーネントは `web/src/components/ui`、追加コンポーネントの設定は `web/components.json` にあります。

既存のReact / Tailwind構成に合わせ、[TanStack Start向けの公式導入手順](https://ui.shadcn.com/docs/installation/tanstack)があるshadcn/uiを採用しています。TanStack自体は画面のデザインを指定しません。Material Design 3の候補として検討した [Material Web](https://github.com/material-components/material-web) は、公式リポジトリでメンテナンスモードと案内されているため、今回は導入していません。

TanStack Devtoolsの画面は開発時も通常は非表示です。必要な場合は `VITE_SHOW_DEVTOOLS=true pnpm --dir web dev` で起動してください。

## 起動

Nixとdirenvをインストールし、リポジトリルートで実行してください。

```sh
direnv allow
bash setup.sh
pnpm --dir web dev
```

- Web: http://127.0.0.1:3000

開発シェルはNode.js 22、pnpm、Git、および比較検証用のPython 3.12・uvを提供します。JavaScript依存は `web/pnpm-lock.yaml`、旧Python版の依存は `backend/uv.lock` に固定しています。direnvを使わない場合は `nix develop` に入ってから同じコマンドを実行できます。Node.jsは22.12以上が必要です。

`setup.sh` はWebの依存関係と、ブラウザテスト用のPlaywright Chromiumを準備します。Chromiumは一時フォルダではなくPlaywright標準のOSキャッシュに保持し、以後のテストで再利用します。Playwrightを更新した場合も、スクリプトを再実行すると対応するブラウザを準備できます。Nixがあれば自動的に開発シェルを使います。WindowsでNixを使わない場合はNode.js・pnpmを用意し、Git Bashから実行できます。

`python scripts/dev.py` でもWebを起動できます。旧Python版と比較する場合だけ、以下で比較用APIも起動します。ブラウザ版はこのAPIを呼び出しません。

```sh
uv sync --project backend --locked
python scripts/dev.py --with-reference-api
```

## 操作

1. WCAの登録CSVと大会日を指定し、CSVを読み込みます。
2. 大会名、競技卓数、競技ごとのグループ数・スクランブラー数・ランナー数を設定します。
3. 参加者の年齢・初参加・ジャッジ免除・スクランブラー免除・運営専任の条件を確認します。
4. 「WCAから自己ベスト・平均記録を取得」で記録を補完します。必要に応じて手動で修正してから、役割分担を計算します。
5. 競技・グループごとの結果を確認し、結果CSVをダウンロードします。
6. 「CSVの割り当てをチェック」でチェック項目を選び、元の登録CSVと結果CSVを確認します。既存の結果CSVのチェックだけにも使えます。

「サンプルで試す」は架空の12人・2競技のCSVを読み込みます。共有されたTokaiAutumn2026のCSVには承認済み参加者が1人だけいるため、そのデータだけでは役割分担が成立しません。人数不足は必要人数・候補者数として表示します。

## WCA登録CSVと追加情報

`comp-grouping` の `src/input_loader.py` は、WCA登録CSVではなく `competition.csv`、`events.csv`、`competitors.csv`、`registrations.csv` の4ファイルを入力としています。このアプリはWCA登録CSVをブラウザ内で変換し、足りない情報を画面から補います。

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

連絡先、IP、コメント、性別などの不要な列は変換結果に含めません。元CSVはそのまま大会ワークスペースに保存するため、元CSVに含まれる列も端末内に保持されます。登録CSV・設定・割り当て結果をサーバーへ送信しません。

## 大会ワークスペース

大会ごとのCSV・設定・参加者の編集内容・取得したWCA記録を、このブラウザに自動保存します。「大会を追加」で別の大会を作成し、「保存した大会」で切り替えます。最後に開いた大会は、ページを再読み込みしても復元します。

- CSV本体はOPFS、設定・作業状態・結果の索引はIndexedDBに保存します。保存処理は順番に実行し、完了後に「保存済み」と表示します。保存失敗・容量不足時は「未保存」と再試行操作を表示します。同じ大会が別のタブで更新された場合は、古い状態で上書きせずに保存を停止します。
- 登録CSVの読み込みと照合用CSVの選択でファイルを保存します。「大会で使うCSVを追加」では複数のCSVを追加できます。保存済みCSVは再アップロードせずに登録CSVや割り当てチェックへ使えます。同名のCSVも別ファイルとして保持します。
- 成功した計算の結果CSVは、計算時の設定・参加者データ・元CSVへの参照と一緒に履歴へ残します。「この結果と設定を開く」でその状態に戻せます。結果CSVはUTF-8 BOM付きで保存し、元CSVは元のバイト列を保持します。
- 「大会を削除」は確認後に、その大会のCSV・設定・結果履歴をすべて削除します。他の大会には影響しません。
- 初回のCSV保存時に永続ストレージを申請します。許可されなくても保存は利用できますが、容量不足などでブラウザが自動削除する可能性があります。

Mac・WindowsのChrome／Edgeを対象に、HTTPSまたはlocalhostで利用してください。保存内容は端末・ブラウザのプロファイル・オリジンごとに分かれ、別PCや別ブラウザへ自動同期しません。サイトデータの削除、シークレットウィンドウの終了で消えます。必要なCSVは個別にダウンロードしてください。大会の一括書き出し・実フォルダとの接続は提供しません。

## 結果CSVと割り当てのチェック

結果CSVは、提示された最終CSVと同じ「1人1行、Name列と競技IDの列」の形式です。Nameは登録名の最初の `(` より前の英語名を出力し、括弧内の母国語名を除きます。競技列は大会設定の順、参加者は名前順で出力します。各セルはセミコロンで区切り、数字のみが競技グループ、Jがジャッジ、Sがスクランブラー、Rがランナーです。例えば `2;J3;S4;R5` はグループ2で競技、3でジャッジ、4でスクランブラー、5でランナーを表します。担当のない競技は空欄です。

```csv
Name,333,clock
Example A,2;J3;S4,J1
Example B,R1,1;J2
```

「CSVの割り当てをチェック」は、以下の4項目をスイッチで個別に選べます。オンにした項目だけを実行し、項目ごとに結果を表示します。形式はUTF-8（BOMあり・なし）、各5MB以下、各1000行以下です。

| チェック項目 | 判定・必要な情報 |
| --- | --- |
| 参加競技の一致 | 登録CSVの0/1列と結果CSVの数字のみの項目を比較。スタッフ役割だけのセルは参加競技に数えない。承認済み・参加競技のある人が対象 |
| 初参加者への役割割り当て | 登録CSVのWCA IDが空欄の人にJ・S・Rがないか確認。WCA ID列が必要 |
| 指定年齢以下の人への役割割り当て | 大会日当日の満年齢がn歳以下の人にJ・S・Rがないか確認。Birth Date列と大会日が必要。nと大会日はグループ分けと共通 |
| 競技卓数に対するジャッジ人数 | 各競技・各グループのJ人数がmin(競技者数, 卓数)以上か確認。競技者数は結果CSVの数字のみの項目から数える。卓数はグループ分けと共通。この項目だけなら登録CSV・大会日は不要 |

年齢の共通設定は初期値12歳以下です。グループ分けではジャッジの年齢資格に使い、CSVの年齢チェックではJ・S・Rすべてを確認します。初参加・年齢チェックは登録CSVの情報を使います（画面で手動変更した個人の初参加フラグ・年齢を参照する機能ではありません）。生年月日が不正な役割担当者は判定不可として表示します。

卓数チェックは競技列ごとに、結果CSVに登場する最大グループ番号まで1始まりで確認します。途中のグループに競技者がいない場合、必要なジャッジは0人です。結果CSVから完全に消えた末尾グループの数は推定できません。グループ番号は1〜100です。競技者・ジャッジ人数は名前の重複やJ項目の繰り返しで増やさず、同じ人は各グループ・各役割につき1回と数えます。必要ジャッジ人数とS・Rの人数も参考表示します。

登録CSVの名前は最初の `(` より前の英語名を使い、名前の前後・連続する空白をそろえて照合します。不足・余分な参加競技、結果から抜けている参加者、結果にだけいる人を表示します。母国語名を除いた後の同名や重複行は推測で対応付けず、照合不可として表示します。参加競技のある競技列が結果CSVから省かれている場合も不足として表示します。不正なセルや同じ競技に複数の競技グループがある場合はCSVの修正を求めます。

## WCA記録の取得

「自己ベスト・平均記録を補完する」のすぐ上に取得ボタンを設置しています。全参加者のWCA IDを使って、[WCAサイトの記録専用API](https://github.com/thewca/worldcubeassociation.org/blob/main/app/controllers/api/v0/persons_controller.rb)から、各競技の公式自己ベスト（single）と公式平均自己ベスト（average）を取得します。「平均」は過去全大会の平均値ではなく、WCAランキングに掲載される自己ベスト平均です。

- WCAへ送るのはWCA IDのみです。名前、連絡先、年齢、登録CSVは送信しません。
- 1人分の全競技記録を1回で取得し、その人の参加競技だけに反映します。同じWCA IDはまとめて取得し、WCA IDなし・形式不正の人は対象外です。参加者検索の絞り込みには影響されません。
- 同時リクエストは1件、外部リクエストの開始間隔は最低1秒です。Web Locks対応・localStorage利用可能なブラウザでは、同じオリジンの複数タブにも適用します。共有するのは次の取得時刻のみです。非対応環境ではページごとに制限します。
- 成功した記録は各ページのメモリに6時間キャッシュします（最大2,000人、ページ再読み込みで消去）。再実行時はキャッシュを利用します。
- 接続エラー・5xx・429は最大2回リトライします。指数バックオフと、CORSで読み取れる場合は `Retry-After` に従います。長い待機を要求されたときや429・503などで残りの取得を停止します。
- 進捗、補完件数、キャッシュ利用件数、取得失敗の一覧を表示します。停止ボタンを押すと現在の1人分の完了後に停止し、取得済みの記録は保持します。
- 初期設定は空欄の補完のみです。「入力済み記録を上書きする」を有効にした場合も、WCAに記録がない項目は消しません。
- 公式平均がない競技は平均を補完しません。単発記録から平均を推定しません。複数目隠しの符号化スコアは秒数として扱えないため、自動補完の対象外です。

WCAの1/100秒形式を秒へ変換します。最少手数はsingleを手数のまま、averageを1/100手から手数へ変換します。取得時点の現行記録を使うため、過去の大会日を指定してもその時点の歴史的な記録にはなりません。WCAのv0 APIは仕様変更・停止の可能性があるため、失敗時は手動入力も利用してください。

## 最適化のルール

同じローカルの `comp-grouping/src/solver.py` の実装を基に、2段階の処理を移植しました。

- 平均記録の速い順に、同じ実力の人がまとまるよう均等なサイズのグループを作成。
- OR-Toolsでスクランブラー、ジャッジ、ランナーを割り当て。
- 自分の競技グループと、その直前グループにはスタッフ役割を付けない。
- ジャッジは指定年齢n歳より上・初参加ではない・ジャッジ免除ではない人（初期値n=12）。
- スクランブラーは該当競技の参加者・スクランブラー免除ではない人。
- 運営専任（参照コードのis_staff）は、競技以外のすべての役割から免除。
- 同一競技・同一グループの役割を兼任しない。
- 速度優先と大会全体の役割回数の偏りを重み付きで最適化。

ジャッジは各グループにmin(競技者数, 競技卓数)人を割り当てます。例えば競技者30人・20卓なら20人、競技者10人・20卓なら10人です。競技卓数を超えるグループは待機席が必要という警告を表示します。

移植時に、候補者が0人の場合にも役割人数制約を適用するよう修正しました。求解後は全登録の競技グループ、必要人数、資格、兼任、直前グループ制約を独立に検証し、違反がある結果は出力しません。

競技の同時進行、後続ラウンド、参加者以外のスタッフ、WCA APIへの反映はまだ対象外です。最初のラウンドの各競技を順番に実施する前提です。

## ブラウザ内の実行

`web/src/lib/registration.ts` がCSV変換、`result-csv.ts` が出力とチェック、`solver.ts` が制約モデルと独立検証、`solver.worker.ts` がWASM実行を担当します。画面からは `assignments.ts` を経由します。

or-tools-wasm 1.0.0（コミュニティ製、[Apache-2.0](web/public/licenses/or-tools-wasm.txt)）を固定して使用しています。モデル作成から結果検証まで専用Web Workerで実行し、中止操作でWorkerを破棄します。計算の探索上限は1〜120秒、初回のエンジン読み込みとモデル作成は別です。結果の計算時間にはこれらも含みます。同じページでは1件ずつ計算し、計算終了後にWASMのスレッドとWorkerを解放します。

WASMスレッドに必要なCOOP・COEPを開発・プレビュー・SSR HTML・静的ファイルの配信に設定しています。HTTPSまたはlocalhostで開いてください。ローカルHTMLの直接オープンでは実行できません。通常のWeb WorkerとWASMに加え、SharedArrayBufferが利用できるブラウザが必要です。JSPI対応環境では約7.4MB、非対応環境では約11.9MBのCP-SAT WASMを読み込みます（圧縮前）。`web/build/cp-sat-assets.ts` で不要なソルバーの配布物を除外するため、or-tools-wasm更新時はこの設定も確認してください。

同じ制約・目的関数でも、OR-Toolsのバージョン・並列数・同点解によって個々の割り当ては変わります。比較では制約適合と、最適性が確認できた場合の目的関数値を確認します。大規模入力の計算時間とメモリ使用量は利用端末に依存します。

## 比較用Python API

旧実装を `backend/` に保持しています。通常のWeb利用では呼び出しません。明示的に起動した場合のAPIは以下のとおりです。

| メソッド・パス | 処理 |
| --- | --- |
| GET /api/health | 起動確認 |
| GET /api/wca/records/{wca_id} | 公開WCA記録の取得。秒・手数に変換した記録、取得時刻、キャッシュ利用有無を返却 |
| POST /api/import | multipartのfileとcompetition_dateから登録データへ変換 |
| POST /api/solve | 大会設定・参加者・記録をJSONで受け取り、検証済みの割り当てとCSV文字列を返却 |
| POST /api/check-participation | multipartのregistration_fileとresult_fileから参加競技の一致・相違点を返却 |
| POST /api/check-csv | multipartのresult_file、registration_file（卓数チェックのみの場合は省略可）、options（JSON文字列）から選択した項目の結果を返却 |

グループ番号はAPI・CSVでは1始まりです。CSVはExcel向けにブラウザでUTF-8 BOMを付けてダウンロードします。

## 検証

```sh
uv run --project backend --locked pytest backend/tests
uv run --project backend --locked ruff check backend/app backend/tests
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright install chromium
pnpm --dir web test:browser
nix flake check
```

Webのテストは実際のWASMソルバーを使います。`backend/.venv/bin/python` がある場合は6種類の入力を旧Pythonソルバーとも比較し、目的関数値と独立した結果検証を確認します。ブラウザテストはCSV読み込み・計算・出力・チェック・再計算・中止・配信ヘッダー不足と、WCA記録の直接取得・キャッシュ利用を確認します。既存Chromeを使う場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` で実行ファイルを指定できます。`PLAYWRIGHT_BASE_URL` を指定すると起動済みの開発サーバーや公開用ビルドを検証します。Chromiumで `PLAYWRIGHT_DISABLE_JSPI=1 pnpm --dir web test:browser --grep 'sample solves'` を実行すると、計算Worker内のJSPI APIを隠してAsyncifyの実行経路を検証します。

## Cloudflare Workers

Cloudflare Vite PluginとWrangler設定を維持しています。`web/src/server.ts` がSSR HTMLに、`web/public/_headers` が静的ファイルにCOOP・COEPを設定します。計算はブラウザで実行するため、公開時にPython APIを配置する必要はありません。WASMを含むアセットは同じオリジンから配信します。

## CI/CD

[coffeelogのGitHub Actions](https://github.com/yahatapp/coffeelog/tree/main/.github/workflows)を参考に、Nix・固定したActionのコミットSHA・ロックファイルを使って実行環境と依存関係を揃えています。

| ワークフロー | 実行条件 | 処理 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | mainへのpush、main向けのドラフトではないPR | 共通の検証ワークフローを実行。新しい更新が来たら古いCIを中止 |
| `.github/workflows/verify.yml` | CI・デプロイから呼び出し | Pythonのlint・テスト、WebのテストとPythonソルバーとの比較、依存関係監査、ビルド・型チェック、Wranglerのdry-run、ChromiumでのブラウザテストとAsyncifyの検証 |
| `.github/workflows/deploy-web.yml` | mainへの実装・ワークフロー・Nix設定の変更、またはmainを指定した手動実行 | 共通の検証がすべて成功した後にWebをビルドし、Cloudflare Workersへデプロイ。本番デプロイを同時に実行しない |

GitHubの[Settings → Environments](https://github.com/yahatapp/wcacomptool-jpn/settings/environments)で本番Environment `production` を使用します。Deployment branches and tagsでは、デプロイ可能なブランチを `main` に制限します。Environment secretsに以下を登録してください。

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | デプロイ先のCloudflareアカウントID |
| `CLOUDFLARE_API_TOKEN` | 対象アカウントに限定した「Edit Cloudflare Workers」APIトークン |

認証設定は[CloudflareのGitHub Actionsガイド](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)を参照してください。トークンはGitHub Secretsで管理します。CIと共通の検証ワークフローには渡さず、デプロイジョブの認証確認・デプロイのステップで使用します。未設定の場合はデプロイジョブが必要なSecret名を表示して失敗します。

デプロイ対象は `web/wrangler.jsonc` の `wcacomptool-jpn-web` です。`pnpm --dir web deploy` はビルドから実行し、CI/CDではビルド後に `pnpm --dir web deploy:built` を実行します。Pythonバックエンドの公開やデータベースのマイグレーションは不要です。
