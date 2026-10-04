import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'

export const Route = createFileRoute('/about')({ component: About })

function About() {
  return <main id="main-content" className="page-wrap assignment-page">
    <div className="assignment-heading">
      <p className="page-eyebrow">ご利用ガイド</p>
      <h1 id="about-title">使い方・割り当て条件</h1>
      <p className="assignment-muted">役割分担の作成手順と、割り当て時に適用されるルールを確認できます。</p>
    </div>
    <Card className="assignment-panel about-content" role="region" aria-labelledby="about-title">
      <p>登録CSVと大会日を指定して参加者を読み込み、競技卓数・グループ数・スクランブラー数・ランナー数を設定します。初参加・免除・運営専任の条件を確認してから計算してください。</p>
      <p>CSVの読み込み・チェック・役割分担の計算・CSV出力はブラウザ内で行います。計算中も中止できます。初回は計算エンジンの読み込みに時間がかかります。WCA記録の自動取得以外では、入力した参加者情報を外部へ送りません。</p>
      <p>CSVにはベスト・平均記録がないため、「WCAから自己ベスト・平均記録を取得」で補完できます。WCAの公式自己ベスト平均を1人ずつ最低1秒間隔で取得し、6時間キャッシュします。入力済みの記録は初期設定では保持し、必要に応じて手動でも修正できます。</p>
      <p>平均記録のある参加者を速い順に、同じ実力の人がまとまるようにグループへ振り分けます。公式平均がない人やWCA IDのない人は空欄のまま、CSVの順序で末尾に並びます。複数目隠しのスコアは自動補完の対象外です。</p>
      <ul className="assignment-warning-list">
        <li>自分の競技グループとその直前のグループにはスタッフ役割を割り当てません。</li>
        <li>ジャッジは指定年齢n歳より上・初参加でない人が対象です（初期値n=12）。各グループの競技者と同じ人数が必要です。</li>
        <li>スクランブラーはその競技の参加者から選び、平均記録の速い人を優先します。</li>
        <li>ジャッジ・スクランブラーの免除指定を守り、運営専任者はすべてのスタッフ役割から除外します。</li>
        <li>同じグループで役割を兼任させず、大会全体の役割回数の偏りを小さくします。</li>
      </ul>
      <p>グループが少ないと、自分の競技と直前グループの制約により候補者が不足します。「割り当て不可」の場合は表示される必要人数・候補者数を確認し、グループ数や役割人数を調整してください。</p>
      <p>結果CSVは1人1行、Name列と競技IDの列で出力します。各セルの数字のみは競技グループ、Jはジャッジ、Sはスクランブラー、Rはランナーです。例えば2;J3;S4はグループ2で競技、3でジャッジ、4でスクランブラーを表します。</p>
      <p>「CSVの割り当てをチェック」では、参加競技の一致、初参加者への役割割り当て、n歳以下の人への役割割り当て、卓数に対するジャッジ人数の4項目をスイッチで個別に選べます。初参加は登録CSVのWCA IDが空欄の人、年齢は生年月日と大会日から計算します。初参加・年齢のチェックはJ・S・Rすべてを対象にします。nと大会日・卓数はグループ分けと共通です。</p>
      <p>卓数チェックは各競技・各グループのJ人数が卓数以上あるか確認し、J・S・Rの人数を表示します。この項目だけなら登録CSVは不要です。参加競技チェックはスタッフ役割だけのセルを参加と数えません。登録CSVの名前は「(」より前の英語名を使い、空白をそろえて照合します。同名の行は照合不可として表示します。</p>
      <p>競技の同時進行、後続ラウンド、外部スタッフ、WCAへの反映はまだ扱いません。競技が順番に進む第1ラウンドの役割分担を作成します。</p>
      <div className="assignment-actions">
        <Button asChild variant="outline"><Link to="/"><ArrowLeft aria-hidden="true" />役割分担の作成へ戻る</Link></Button>
      </div>
    </Card>
  </main>
}
