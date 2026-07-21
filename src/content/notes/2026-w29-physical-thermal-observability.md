---
title: 物理熱をObservabilityへ加えた（発表スライドあり）
date: 2026-07-17
tags:
  - raspberry-pi
  - kubernetes
  - prometheus
  - grafana
  - loki
  - tempo
  - opentelemetry
  - observability
  - alerting
  - homelab
---

ページ上部には、7月の発表で使った22枚のスライドを掲載しています。ページをめくると、その場で話した内容をもとに再構成した口頭説明も一緒に読めます。10枚目では、発表時に流した約1分20秒のLGTMデモ動画も再生できます。

ただ、スライドを見ずに本文だけを読む方もいると思います。また、発表では時間の都合で省いた部分もあります。ここからは、検証の背景、方法、結果、限界までを技術記事としてもう少し詳しく残します。

今回の結論を先に書くと、次のとおりです。

> **CPU負荷の終了と、物理的な冷却完了は同時ではありません。**

CPU使用率は負荷停止後すぐに約1.4%まで下がりましたが、その時点でもRaspberry PiのSoC温度は61.3℃残っていました。CPUだけなら「処理は終わった」と判断する場面に温度を加えることで、「物理的にはまだ冷えていない」と説明できました。

## 今回は主研究から少し横へ広げました

私の主研究は、Raspberry Piの温度計測そのものではありません。[Platform Lab Research](https://github.com/orgs/DraftOps1/projects/5)では、ベアメタルKubernetes上のMisskey、PostgreSQL、Redisなどを対象に、Metrics・Logs・Tracesをincidentの証拠へ変換し、RCAの速度と精度を評価しています。

中心にあるのは、cross-signal evidence bundleをRCAの入力境界にしたとき、TTFC、MTTR proxy、Top-1、Top-3の評価をどこまで再現できるか、という問いです。

この発表は2回に分かれていました。1回目はまだ設計段階で、外付けセンサーから物理温度を取り込み、Private Cloud上で可視化・通知する構想を紹介しました。2回目にあたる今回は、実際に組み上げて検証した後の報告です。

ちょうど2026年7月に発表する機会があったため、主研究から少し横へ枝を伸ばしました。アプリケーションやKubernetesの論理signalだけでなく、サーバーの物理的な状態も同じevidence bundleへ入れたら、障害と回復をより正確に説明できるのではないかと考えました。

[![主研究のMetrics-only RCAからLogs・Tracesと物理signalへ派生し、残留熱をevidence bundleへ戻す流れを示した図](/images/2026-w29-physical-thermal-observability/research-branch-handwritten.png)](/images/2026-w29-physical-thermal-observability/research-branch-handwritten.png)

今回の温度検証は、別の研究へ乗り換えたものではありません。Metrics-onlyの一次切り分けにLogsとTracesを加え、さらに物理温度を加えて回復の時間差を説明し、その知見をevidence bundleへ戻すためのサブテーマです。

## 実測とデモの境界を先に決めました

Grafana上でMetrics、Logs、Tracesがきれいにつながるほど、どこまでが直接観測した事実なのかが分かりにくくなります。そこで、実験を始める前にデータの境界を決めました。

| 区分                           | 今回の扱い                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 直接観測したACTUALデータ       | Raspberry PiのSoC温度、CPU使用率、load average、throttling / under-voltage flag、Prometheus Alertの状態、各イベントの時刻です |
| ACTUALデータから構造化した記録 | 実験ハーネスが実測値と時刻を読み、Tempoのspan hierarchy、Lokiのevent log、共通trace IDへ変換しました                          |
| 相関設定を試すsynthetic demo   | TraceからLogs、LogsからTrace、TraceからMetricsへ移る動線を、合成データで事前確認しました                                      |

Tempoへ保存した実測側のtraceは、架空の温度を示したものではありません。一方で、Misskeyの自動計装から自然にemitされたtraceでもありません。実験ハーネスが実際の温度、CPU、Alert状態、時刻を読み、それらをOTLP traceと構造化logへ変換しています。

発表スライドの13〜15枚目は、相関動線を確認するためのsynthetic demoです。特に13枚目にある「DBクエリのspanが5秒」という説明は、実際にDBを実装して計測した結果ではありません。実際のMisskeyでリクエストが遅くなった場合に、対象spanから同じtrace IDのログへ移り、PostgreSQLの処理や直前の再試行を調べる使い方を想定した例です。

Alertmanagerからスマートフォンへの実機通知、LLM / SLMによる自動トリアージ、DHT22による周辺温度観測、Mimir、本番向けのTempo分散構成、アプリケーションの自動OpenTelemetry計装も今回は実装していません。発表スライドには将来の経路も載せていますが、構想と完了した範囲は分けて扱います。

## DHT22ではなくSoC温度を選びました

設計段階では、外付けのDHT22で周辺温度を測り、MQTTでクラスタへ送る構成を考えていました。しかし、短いCPU負荷に対する外気温は、センサーの配置、ケース、空気の流れ、応答速度の影響を強く受けます。

今回知りたかったのは、CPU負荷がデバイス内部の熱へどう反映されるかです。そこで、主信号をRaspberry Pi内蔵のSoC温度へ変更しました。

| signal                    | 今回の役割                                              |
| ------------------------- | ------------------------------------------------------- |
| SoC temperature           | CPU負荷に対するデバイス内部の直接応答として実測しました |
| DHT22 ambient temperature | 周辺環境の基準として想定しましたが、今回は未実装です    |
| thermal delta             | SoCと周辺温度の差として、次の実験で比較したい値です     |

DHT22が役に立たないと判断したわけではありません。まずは目的に最も近く、短時間でも反応を確認できるSoC温度を選び、周辺温度は次の段階へ分けました。

なお、温度実験の前には、Collectorやbackendの比較に使うPrometheus resource計測が正しいかを確認しています。その過程で見つかったcAdvisor重複収集の調査は、前回の[PrometheusのcAdvisor target重複を解消し、Observability比較の測定系を正す](/notes/2026-w28-prometheus-cadvisor-measurement-integrity/)へ分離しました。この記事では同じ内容を繰り返さず、修正後の状態を実験前のgateにしたことだけを残します。

## 相関基盤と温度の入口を整えました

以前は、MetricsをPrometheusとGrafana、LogsをOpenSearch Dashboards、TracesをJaeger UIで見ていました。個々のsignalは確認できますが、障害時にはGrafanaで時刻を見て、OpenSearchでserviceやPodを探し、trace IDを見つけてJaegerで検索し直す必要があります。

目標は、三つのbackendを一つへ混ぜることではありません。Prometheus、Loki、Tempoにはそれぞれのデータを保存し、Grafanaを同じincident contextから検査結果を開く入口にしました。Tempoのspanから関連logや同じ時間帯のmetricへ進み、LokiのlogからTempoへ戻れる状態を目指しました。

Logsの経路をFluent BitからGrafana Alloyへ変更するときも、移行自体が目的にならないようにしました。欠損が増えたりCPU負荷が悪化したりして、可観測性のための移行で可観測性を損なってしまっては本末転倒です。そこで、100,000件の固定JSONL corpusを同じrateで投入し、完全性、完了時間、CPU、memory、networkを比較しました。

| 評価項目         | Fluent Bit + gzip | Alloy + Snappy | 解釈                           |
| ---------------- | ----------------: | -------------: | ------------------------------ |
| 完了時間         |          61.455秒 |       61.350秒 | 実質同等です                   |
| CPU core-seconds |            9.1827 |         4.1542 | Alloyが54.8%少ない結果です     |
| 平均memory       |         15.214MiB |      49.646MiB | Fluent Bitの方が小さい結果です |
| network TX       |         約8.74MiB |     約12.57MiB | Fluent Bitの方が少ない結果です |
| 生成config       |             459行 |          225行 | Alloyが少ない結果です          |

Alloyがすべての軸で軽いわけではありません。この環境ではCPU効率、OpenTelemetry方向への統合、設定の一元化を優先したためAlloyを選びました。memoryの小さいノードやnetwork制約が強い環境なら、同じ結果からFluent Bitを選ぶ可能性もあります。

Traceについては、送れることと再起動後も残ることを分けて確認しました。Tempo 2.10.7を検証用のmonolithic構成で配置し、Longhorn PVCへ保存しました。3 traces / 6 spansを送った後にStatefulSetを再起動し、同じtrace IDと全spanを再取得できました。

これは、labで必要な輸送と保持を確認した結果です。本番向けのHAやobject storage設計まで証明したものではありません。

Raspberry Piには、Python製の小さなExporterをsystemd serviceとして配置しました。Prometheusへ公開した主なmetricは次のとおりです。

```text
raspberry_pi_soc_temperature_celsius
raspberry_pi_cpu_utilization_percent
raspberry_pi_load1
raspberry_pi_memory_used_percent
raspberry_pi_throttling_active
raspberry_pi_under_voltage_active
raspberry_pi_soc_exporter_sample_timestamp_seconds
```

labelには `service_name="raspberry-pi"`、`device="tk240353"`、`data_class="actual"` を付けました。Kubernetes側ではselectorを持たないServiceと外部endpointを用意し、ServiceMonitorから5秒間隔でscrapeしています。

検証時にはlegacy `Endpoints` resourceを使いました。Kubernetes v1.33以降ではEndpoints APIがdeprecatedのため、GitOpsへ収束させる際にはEndpointSliceへ移行する予定です。

## 基礎計測からAlert条件を決めました

Alertの閾値を最初から65℃に決めたわけではありません。まず、5分間のbaseline、CPU負荷、安全停止、7分間のcooldownを一続きで測りました。sample intervalは5秒、load generatorのworker数は4です。

| 項目                     |  実測値 |
| ------------------------ | ------: |
| baseline温度平均         | 49.018℃ |
| baseline温度最大         |   51.1℃ |
| load温度最大             |   75.4℃ |
| 温度上昇幅               | 26.382℃ |
| load CPU平均             | 90.063% |
| load CPU最大             |    100% |
| cooldown最終温度         |   50.1℃ |
| throttling / power flags |    なし |

![負荷前・負荷中・冷却中の温度特性](/images/2026-w29-physical-thermal-observability/thermal-characterization.svg)

温度は約1分で50℃前後から75℃付近まで上がりました。一方で、Prometheus全体のglobal evaluation intervalは30秒です。この値を短くすると他のruleにも影響するため、Raspberry Pi用のrule groupだけを5秒評価にしました。

```yaml
spec:
  groups:
    - name: raspberry-pi-thermal-actual
      interval: 5s
      rules:
        - alert: RaspberryPiSoCTemperatureHigh
          expr: |
            raspberry_pi_soc_temperature_celsius{
              device="tk240353",
              data_class="actual"
            } > 65
          for: 10s
```

scrapeとrule評価を5秒にそろえ、1 sampleの揺れだけではfiringしないように `for: 10s` を設定しました。つまり、65℃超過が10秒続いたときにfiringします。globalの30秒間隔は変えず、load generatorは72℃で安全停止するようにしました。

## 実際に温度を上げてAlertの動きを見ました

最終runでは、時系列を記録するcapture側と、Raspberry PiでCPU負荷を発生させるload generatorを分け、共通の実験IDで記録しました。

| イベント     | 温度 / CPU         | Alert状態           |
| ------------ | ------------------ | ------------------- |
| 実験開始     | 46.2℃ / 低負荷     | inactive            |
| 65℃超過      | 約65〜67℃ / 約100% | pending             |
| Alert firing | 69.1℃ / 100%       | firing              |
| 安全停止     | 72.5℃ / 約100%     | load停止            |
| 負荷停止直後 | 61.3℃ / 1.377%     | resolved / inactive |
| cooldown後   | 52.1℃ / 低負荷     | stable              |

![実測したCPU負荷、温度、Alert、冷却のlifecycle](/images/2026-w29-physical-thermal-observability/actual-incident-lifecycle.svg)

負荷中は、CPU 100%と温度上昇を同じGrafana画面で確認できました。

![CPU負荷中のGrafana画面](/images/2026-w29-physical-thermal-observability/grafana-load-actual.webp)

負荷を止めると、CPUの線は先に落ちましたが、温度の線は遅れて下がりました。

![負荷停止後の冷却を示すGrafana画面](/images/2026-w29-physical-thermal-observability/grafana-cooldown-actual.webp)

この時間差が分かると、再び高負荷を投入してよいかをCPU使用率だけで決めずに済みます。同じ負荷に対する温度上昇の勾配を過去と比べれば、ケース、ヒートシンク、ファンの冷却余裕が落ちていないかを見る手掛かりにもなります。

また、Prometheus Alertがresolvedになったことは、物理的な冷却完了を意味しません。今回のruleが表すのは「SoC温度が65℃以下へ戻った」という状態です。サービスが処理を終えた状態、Alert条件を外れた状態、十分に冷えた状態を、同じ「回復」として扱わないことが重要です。

## Logs・Tracesと結び、主研究へ戻します

最終runでは、同じ実験をPrometheusのtemperature / CPU / ALERTS、Lokiの8件のevent log、Tempoの6 spanへ残しました。Tempo traceは次の構造です。

```text
pi.actual.thermal.incident
├─ cpu.load.actual
├─ thermal.threshold.crossed
├─ prometheus.alert.pending
├─ prometheus.alert.firing
└─ thermal.cooldown.actual
```

Lokiには、実験開始、負荷検知、閾値超過、pending、firing、負荷停止、resolved、実験完了を記録しました。たとえば、firing時のevent logは次の形です。

```json
{
  "data_class": "ACTUAL",
  "event": "alert_firing",
  "service_name": "raspberry-pi",
  "temperature_celsius": 69.1,
  "cpu_utilization_percent": 100.0,
  "alert_state": "firing",
  "trace_id": "<same trace id>"
}
```

GrafanaのTempo datasourceでは、`service.name` をPrometheusの `service_name` へ対応付けました。Lokiでは、ログ本文のtrace IDを使い、`View Trace` からTempoへ戻れるようにしています。

![Grafanaで確認したTrace、Logs、Metricsの相関](/images/2026-w29-physical-thermal-observability/grafana-trace-log-actual.webp)

最終確認では、Tempoに6 spans、Lokiに8 logs、Prometheusに61点のtemperature sampleと8点のALERTS sampleが残りました。pending、firing、resolvedをすべて観測でき、実験後もcluster nodesは5 / 5 Ready、bad podsは0でした。

主研究では、RCAに使うevidence bundleをMetrics、Logs、Tracesの集合として設計しています。今回の結果から、signalの種類だけでなく、**signalごとの時間定数**もbundleへ含める必要があると分かりました。

CPU utilizationは負荷の投入と停止へほぼ直ちに反応します。SoC temperatureは負荷に遅れて上がり、負荷停止後も遅れて下がります。Prometheus Alertはrule intervalと `for` 条件に従って状態遷移し、LogsとTracesはそれらのeventを検索できる節として残します。同じincidentでも、すべてのsignalが同時に正常へ戻るとは限りません。RCAのtimelineには、何が起きたかだけでなく、どの状態をもって回復と判断したかも残す必要があります。

## Fluent BitとGrafana Alloyの内部データフロー

ページ上部の公開デッキには含めていませんが、発表では概要にとどめた両Collectorの内部処理をここで補足します。比較対象は、同じKubernetesコンテナログをLokiへ送る場合の、状態管理、buffer、retry、制御面の違いです。

![Fluent BitとGrafana Alloyの内部データフロー比較](/images/2026-w29-physical-thermal-observability/slides/slide-24.webp)

Fluent Bitはinputからfilter、chunk buffer、outputへ進む専用pipelineとして、Alloyはcomponent graphのDAGとして処理を組み立てます。両方ともLokiへ送れますが、Fluent Bitはchunk、Alloyはbatchがretryやbackpressureの単位になるため、件数だけを比べても同じ意味にはなりません。そこで今回の比較では、同じ10万件が欠損・重複なく到達したことを共通の完了条件にし、queue / chunk depth、retry、drop、WALまたはfilesystem使用量、復旧後のcatch-upを確認しました。

## 現在の制約と次の実験

現時点のTempo labはmonolithic + local filesystemで、本番HAを検証していません。Tempo、datasource、dashboard、ServiceMonitor、PrometheusRuleの一部はruntimeで手動適用したままです。外部Pi endpointにはlegacy Endpoints resourceを使っており、Pi exporterの認証と暗号化も未実装です。

通知経路はPrometheus Alertの状態遷移までで、Alertmanagerからスマートフォンへのreceiverはまだありません。DHT22によるambient temperature、LLM / SLMトリアージ、application auto-instrumentationも次の範囲です。

次は、発表用runtimeをそのまま常設化せず、残すもの、GitOpsへ収束させるもの、撤去するものを分けます。Pi ServiceはEndpointSliceへ移し、ServiceMonitor、ACTUAL dashboard、PrometheusRule、Grafana datasource provisioningをGitOpsへ戻します。そのうえでTempoの永続化方式とAlloyのrollout profileを見直し、スマートフォン通知、DHT22、`SoC - ambient` のthermal delta、Misskeyの自動計装へ進む予定です。

## まとめ

今回の成果は、Grafanaへすべてを表示したことではありません。主研究のcross-signal RCAを物理signalへ広げ、目的に合うSoC温度を選び、実際の温度上昇からAlertの評価周期と継続時間を決めました。そのうえで、CPU、温度、Alert、Logs、Tracesを同じincidentとして結びました。

実測値と、実測値から後付けで構造化したtraceも区別しています。相関設定を確認するsynthetic demoは、MisskeyやDBの実測結果として扱っていません。この境界を保ったまま、CPU負荷の終了と物理的な冷却完了が別であることを確認できました。

Metricsだけなら「処理が終わった」と見える場面に、物理熱という別の時間定数を加えられました。この時間差をevidence bundleへ残すことで、単なる監視画面ではなく、障害と回復を説明する証拠へ一歩近づいたと考えています。

## 関連資料

- [Platform Lab Research](https://github.com/orgs/DraftOps1/projects/5)
- [PrometheusのcAdvisor target重複を解消し、Observability比較の測定系を正す](/notes/2026-w28-prometheus-cadvisor-measurement-integrity/)
- [Observability stack selection ADR: current stack vs Grafana LGTM](https://github.com/DraftOps1/platform-lab-roadmap/issues/22)
- [Raspberry Pi Documentation: temperature and throttling](https://www.raspberrypi.com/documentation/computers/os.html#vcgencmd)
- [Kubernetes Service without selectors](https://kubernetes.io/docs/concepts/services-networking/service/#services-without-selectors)
- [Kubernetes EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [Prometheus alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [Grafana: Configure trace to logs](https://grafana.com/docs/grafana/latest/datasources/tempo/configure-tempo-data-source/#trace-to-logs)
- [Grafana: Configure trace to metrics](https://grafana.com/docs/grafana/latest/datasources/tempo/configure-tempo-data-source/#trace-to-metrics)
