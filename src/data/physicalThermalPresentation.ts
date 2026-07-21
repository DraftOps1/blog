export type SlideKind =
  "背景" | "設計" | "実測" | "合成データ" | "制約" | "補足";

export interface AnnotatedSlide {
  number: number;
  image: string;
  title: string;
  alt: string;
  kind: SlideKind;
  talk: string[];
  video?: {
    src: string;
    type: "video/mp4";
    label: string;
  };
}

const imageRoot = "images/2026-w29-physical-thermal-observability/slides";

export const physicalThermalSlides: AnnotatedSlide[] = [
  {
    number: 1,
    image: `${imageRoot}/slide-01.webp`,
    title: "物理熱を同じincident timelineへ加える",
    alt: "物理熱、メトリクス、アラートを同一タイムラインで説明可能にする、という発表タイトル",
    kind: "背景",
    talk: [
      "今日は、CPUやアプリケーションの状態だけでなく、Raspberry Piが実際にどれくらい熱いのかまで、同じ時間軸に並べてみます。",
      "ちなみに、このアイコンと名前で、あのフルーティーな企業を想像した方がいるかもしれません。そこは関係なくて、ICLOUDは「一般のご家庭 Cloud」という意味です。ここは少しふざけましたが、扱うテーマはまじめです。",
    ],
  },
  {
    number: 2,
    image: `${imageRoot}/slide-02.webp`,
    title: "当初は外付け温湿度センサーを想定した",
    alt: "研究用クラスタ、計測ノード、Private Cloud、GrafanaとAlertをつなぐ当初のシステム概要",
    kind: "設計",
    talk: [
      "この発表は2回に分かれていて、前回は設計段階、今回は実装後の報告です。前回は、サーバー群に外付けの体温計のようなセンサーを付け、Private Cloudへ送ってGrafanaで見る構想を紹介しました。",
      "実際に試す中で変えた部分もあります。最終的には外付けセンサーではなく、短い熱変化を追いやすいRaspberry Pi内蔵のSoC温度を使いました。その差分も順に紹介します。",
    ],
  },
  {
    number: 3,
    image: `${imageRoot}/slide-03.webp`,
    title: "前回はGrafanaへの集約を説明した",
    alt: "TempoとLokiを使えばGrafanaへ集約できると説明した前回発表の振り返り",
    kind: "背景",
    talk: [
      "前回はまだ設計段階で、Prometheusに加えてTempoやLokiを使えば、Metrics・Logs・TracesをGrafanaから見られるようにしたい、と説明しました。今回は、それを実装して確かめた後の報告です。",
      "いま振り返ると「Grafanaへ集約する」という言い方は少し雑でした。全部のデータを一つのDBへ入れるのではなく、保存先は分けたまま、Grafanaを共通の入口にするという意味です。",
    ],
  },
  {
    number: 4,
    image: `${imageRoot}/slide-04.webp`,
    title: "製品を置くだけでは相関にならない",
    alt: "trace IDのないPrometheus画面と、traceへリンクできる理想形を比較したスライド",
    kind: "設計",
    talk: [
      "ただ、Grafanaにデータソースや製品ロゴが並んだから完成、ではありません。上の画面のように、結局は人が時刻やservice名を見比べているなら、調査はまだ分断されています。",
      "下のように、trace IDや共通labelから次のsignalへ移り、同じincidentの文脈を保てるところまで作って、初めて相関と呼べると考えました。",
    ],
  },
  {
    number: 5,
    image: `${imageRoot}/slide-05.webp`,
    title: "取得・保存・説明を段階的に実装した",
    alt: "センサー取得、クラスタ保存、GrafanaとAlertによる説明の3段階を示した実装ステップ",
    kind: "設計",
    talk: [
      "設計時点では、この3段階で進める予定でした。最初にセンサー値を取り、次に保存と欠損検知、最後にAlertやAIで説明する、という流れです。",
      "ただし、この図の全部が今回完成したわけではありません。外付けセンサーやMQTTは途中で見直し、実験ではSoC温度を5秒間隔で収集しました。AIトリアージとスマートフォン通知も今回は見送っています。",
    ],
  },
  {
    number: 6,
    image: `${imageRoot}/slide-06.webp`,
    title: "検証は既存のPrivate Cloud上で行った",
    alt: "Git、Cloudflare、認証を含む既存Private Cloudの構成図と運用フロー",
    kind: "背景",
    talk: [
      "実験の土台は、もともと運用しているPrivate Cloudです。この図は情報量が多いので、全部を読まなくても大丈夫です。",
      "今回のポイントは、新しい検証環境を別に作ったのではなく、既存のベアメタルKubernetesへ、クラスタ外のRaspberry Piから温度を取り込んだことです。",
    ],
  },
  {
    number: 7,
    image: `${imageRoot}/slide-07.webp`,
    title: "三つの画面を往復する調査が課題だった",
    alt: "OpenSearch、Jaeger、Prometheusの三画面からGrafana中心の構成を目指す比較図",
    kind: "背景",
    talk: [
      "これまでは、ログならOpenSearch、traceならJaeger、metricsならGrafanaというように、調査中に画面を行き来していました。",
      "困っていたのは、画面が三つあること自体より、そのたびに時刻やPod名、service名を頭の中でjoinし直すことです。そこで、調査の入口をGrafanaへ寄せました。",
    ],
  },
  {
    number: 8,
    image: `${imageRoot}/slide-08.webp`,
    title: "三画面を一つの入口へ寄せた",
    alt: "複数画面を行き来するBeforeとGrafanaで横断するAfterの対比",
    kind: "設計",
    talk: [
      "自分はケルベロスではないので、ダッシュボードが三つもあると混乱してしまいます。本物のケルベロスは三つの頭が同じ体についていますが、こちらは検索条件まで別々です。障害が起きている最中に、それぞれの画面で時刻やservice名を合わせ直すのも大変です。そこで、Grafanaを入口にして、同じincident contextのまま各signalへ移れるようにしました。",
      "これは、ただ操作が楽になるという話だけではありません。新しくチームへ入った人が、ツールごとの検索方法と画面遷移を一度に覚える負担を減らせれば、学習曲線をなだらかにできます。調査中のcontext switchも減るので、原因へたどり着くまでの時間やMTTRにも効くはずです。今回は動線までを作り、実際にどれだけ短縮できるかは主研究側で評価します。",
    ],
  },
  {
    number: 9,
    image: `${imageRoot}/slide-09.webp`,
    title: "発表期限に合わせて検証範囲を固定した",
    alt: "6月から7月にかけたObservability基盤、比較実験、温度検証、発表準備のスケジュール",
    kind: "背景",
    talk: [
      "発表日が決まっていたので、そこから逆算して作業を区切りました。きれいな計画表に見えますが、実際にはセンサー方式を変えたり、検証範囲を絞ったりしています。",
      "全部を完成させるより、通信できたか、保存できたか、相関できたか、というように、各段階で何を確認できれば次へ進むかを決めて進めました。",
    ],
  },
  {
    number: 10,
    image: `${imageRoot}/slide-10.webp`,
    title: "最終実験を一つのtraceとして検索できた",
    alt: "Grafana TempoでRaspberry Piのthermal incident traceを検索した画面",
    kind: "実測",
    video: {
      src: "videos/2026-w29-physical-thermal-observability/lgtm-demo.mp4",
      type: "video/mp4",
      label:
        "GrafanaでTrace、Logs、Metricsを横断するLGTMデモ動画。約1分20秒、音声なし",
    },
    talk: [
      "ここには二つのtraceが並んでいます。上のraspberry-piが実測した温度イベントで、下のlgtm-demoは相関設定を確認するための合成データです。",
      "ただし、上もMisskeyの自動計装から自然に出たtraceではありません。実測した温度、CPU、Alertの時刻を実験ハーネスが読み、後から一つのincident traceとして構造化したものです。",
      "このページでは、発表時に流した約1分20秒のデモ動画も再生できます。Tempoのtraceを起点にLokiのlogを開き、同じRaspberry Piの温度とCPU metricへ移る流れを収録しています。音声はありません。",
    ],
  },
  {
    number: 11,
    image: `${imageRoot}/slide-11.webp`,
    title: "Collectorは同一入力で比較してから選んだ",
    alt: "Fluent BitとGrafana Alloyの移行前比較実験と採用判断",
    kind: "実測",
    talk: [
      "Collectorを変更した結果、欠損が増えたりCPU負荷が悪化したりして、可観測性そのものを損なってしまっては本末転倒です。そこで、Fluent BitとAlloyへ同じ10万件の固定JSONLログを同じrateで流し、CPU、memory、network、完全性、完了時間を比較しました。",
      "AlloyはCPUと設定面で有利でしたが、memoryとnetworkはFluent Bitが有利でした。万能な勝者を決めたのではなく、今回の環境でOpenTelemetry方向への統合を優先してAlloyを選んでいます。",
    ],
  },
  {
    number: 12,
    image: `${imageRoot}/slide-12.webp`,
    title: "ここから相関によって得られた機能を示す",
    alt: "何が出来るようになったか、というセクション区切り",
    kind: "背景",
    talk: [
      "ここまで構成の話が長かったので、ここからは「結局、何ができるようになったのか」を画面で見ていきます。",
      "まずはTraceからLogsへ、次にLogからTraceへ戻り、さらにMetricsへ移る、という順番です。最後に、実測した物理熱とAlertの動きも重ねます。",
    ],
  },
  {
    number: 13,
    image: `${imageRoot}/slide-13.webp`,
    title: "Traceから同じspanのLogsへ移動できる",
    alt: "TempoのLogs for this spanからLokiログを開く相関画面",
    kind: "合成データ",
    talk: [
      "最初はTraceからLogsへの移動です。ここは動線確認用のsynthetic demoで、実際のDBを実装して5秒のクエリを発生させた画面ではありません。吹き出しのDBクエリは、使い方を説明するための例です。",
      "実際のMisskeyでリクエストが遅くなった場面なら、このように対象spanから同じtrace IDのログへ移ることで、PostgreSQL側の処理や直前の再試行を調べやすくなるはずです。今回は、その調査動線が作れるかをデモで確かめました。",
    ],
  },
  {
    number: 14,
    image: `${imageRoot}/slide-14.webp`,
    title: "LogからTraceへ戻る経路も用意した",
    alt: "LokiログのView TraceからTempo traceへ戻る操作と利用場面",
    kind: "合成データ",
    talk: [
      "逆方向も用意しました。ログを先に見つけて「この処理全体はどうなっていたのか」と思ったら、View TraceからTempoへ戻れます。",
      "ここで挙げているDB、外部API、再試行は想定する利用場面です。この画面自体は先ほどと同じ合成データなので、実際のMisskey障害を観測した結果とは分けて見てください。",
    ],
  },
  {
    number: 15,
    image: `${imageRoot}/slide-15.webp`,
    title: "Traceと同じ条件のMetricsへ移動できる",
    alt: "Tempo spanからSynthetic temperatureのPrometheus metricを開く画面",
    kind: "合成データ",
    talk: [
      "Traceから同じ条件のMetricsへ移ることも確認しました。spanのservice名などをPrometheusのlabelへ対応させて、同じ時間帯のグラフを開いています。",
      "ただし、右側の緑色の温度は実測値ではなく、リンクの設定を試すためのsynthetic temperatureです。実際のRaspberry Piで測ったSoC温度は、この後のスライドで別に示します。",
    ],
  },
  {
    number: 16,
    image: `${imageRoot}/slide-16.webp`,
    title: "既存のDB障害研究でも時間差が判断材料になる",
    alt: "DB lock発生時と通常時のGrafanaグラフ比較",
    kind: "実測",
    talk: [
      "こちらは温度ではなく、主研究側で行った別の検証です。PostgreSQLへ意図的にlockを発生させると、上のようにlock waitとblocked sessionが現れ、解消後は下のように戻りました。",
      "本番障害の画面ではありませんが、原因、影響、回復を一つの時間軸で見る考え方が、今回の温度検証の土台になっています。それをソフトウェアの外にある物理signalまで広げました。",
    ],
  },
  {
    number: 17,
    image: `${imageRoot}/slide-17.webp`,
    title: "通知までの設計経路を分解した",
    alt: "物理signalからPrometheus、Alertmanager、Webhook、スマートフォンへ至る通知経路",
    kind: "設計",
    talk: [
      "最終的には、物理signalからPrometheus、Alertmanager、Webhook、スマートフォンまでつなぐ構想です。",
      "ただ、今回はこの矢印を全部完走したわけではありません。実測したのはPrometheus Alertのpending、firing、resolvedまでで、スマートフォンへの実機通知は今後の作業です。",
    ],
  },
  {
    number: 18,
    image: `${imageRoot}/slide-18.webp`,
    title: "CPU負荷の終了後も物理熱は残った",
    alt: "CPU負荷中と停止後のRaspberry Pi SoC温度・CPU利用率を比較したGrafana画面",
    kind: "実測",
    talk: [
      "ここは実測値です。上では全コアへ負荷をかけ、CPU使用率100%と温度上昇を同時に確認しています。下では負荷を止めるとCPU使用率はすぐに約1.4%まで下がりますが、その時点でもSoC温度は61.3℃残っています。",
      "つまり、処理が終わったことと、物理的に冷えたことは同じではありません。今回いちばん見せたかったのは、この時間差です。",
    ],
  },
  {
    number: 19,
    image: `${imageRoot}/slide-19.webp`,
    title: "AIと外付けセンサーは今回の完了範囲から外した",
    alt: "LLM実装と外付けセンサー試験を未完了とした現状課題と今後の方針",
    kind: "制約",
    talk: [
      "できなかったことも二つあります。LLMトリアージはセキュリティとリソースの都合で見送り、外付けセンサーも有効な負荷試験まで持っていけなかったので、今回はSoC温度へ絞りました。",
      "ローカルSLMで分割やマスキングをしてからクラウドLLMへ渡す案と、DHT22で周辺温度を測る案は今後の構想です。どちらも、まだ実装済みではありません。",
    ],
  },
  {
    number: 20,
    image: `${imageRoot}/slide-20.webp`,
    title: "製品比較ではなく設計判断の軸を作った",
    alt: "柔軟性、運用コスト、ボトルネック、適合性、信頼性から設計判断する観点",
    kind: "設計",
    talk: [
      "今回いちばん力を入れたのは、特定の製品を採用することより、どう判断したかを残すことです。柔軟性、運用コスト、ボトルネック、適合性、信頼性の五つで見ています。",
      "今回の環境ではAlloyを選びましたが、memoryやnetworkの制約が強ければ、同じ比較結果からFluent Bitを選ぶこともあります。環境が変わっても判断をやり直せる形にしたかった、ということです。",
    ],
  },
  {
    number: 21,
    image: `${imageRoot}/slide-21.webp`,
    title: "ここから質疑用の補足資料",
    alt: "以下質問あった時の補足資料、という区切りスライド",
    kind: "補足",
    talk: [
      "本編はここまでです。ここから先は、周辺システムや運用方法について質問があった場合に開く補足資料です。",
      "発表中は、質問がなければかなり速く通過するページです。この公開デッキでは、次の1枚だけを補足資料として残しています。Fluent BitとGrafana Alloyの内部データフローは、ブログ本文で補足します。",
    ],
  },
  {
    number: 22,
    image: `${imageRoot}/slide-22.webp`,
    title: "周辺システムと運用コストの質問に備えた",
    alt: "ジョブ実行経路、Argo CD画面、OpenCostの例を並べた質疑用補足資料",
    kind: "補足",
    talk: [
      "上はジョブ受付からKubernetes実行、保存、観測までの概念的な流れで、左下は既存環境をArgo CDで管理している例です。",
      "右下のOpenCostは、将来的にリソース効率や費用まで評価する場合の参考で、今回の温度実験結果ではありません。この一枚も全部を読むというより、質問された箇所だけ説明する想定でした。",
    ],
  },
];
