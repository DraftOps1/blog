---
title: PrometheusのcAdvisor target重複を解消し、Observability比較の測定系を正す
date: 2026-07-11
tags:
  - kubernetes
  - prometheus
  - observability
  - sre
  - cadvisor
  - platform-engineering
  - homelab
---

Grafana LGTMを含むObservability stackの比較を始める前に、現行基盤のCPU、memory、storageをbaselineとして取得しようとしました。ここで最初に違和感を持ったのが、Fluent Bitの値でした。

`kubectl top`では全5Pod合計がおおむねCPU 43m、memory 55Miでした。一方、Prometheusで同じPodを合計すると、停止前5分平均はCPU 68.8m、memory 107.1Miになりました。

計測窓や集計方法が異なるため、値が完全に一致しないこと自体は不思議ではありません。ただし、memoryがほぼ2倍になっている点は無視できません。このままFluent BitとAlloy、OpenSearchとLokiを比較すると、製品差ではなく測定系の誤差を評価してしまう可能性があります。

そこでLGTMの導入を進める前に、Prometheus自身のmeasurement integrityを確認しました。

## 今回の範囲

今回確認したのは、Kubernetes kubeletの`/metrics/cadvisor`をPrometheusがどのように発見し、何本のtime seriesとして取り込んでいるかです。

見るもの:

- cAdvisor active target数
- 同じPod/containerに対応するseries数
- ServiceMonitorが選択したKubernetes Service / Endpoints
- 修正前後のCPU / memory集計
- 修正後のapplication gate

見ないもの:

- cAdvisor metricそのものの精度評価
- Metrics ServerとPrometheusの完全な一致
- Prometheus head series変化の厳密な因果分解
- Grafana LGTMの製品比較
- Mimir、Loki、Tempoの性能評価

今回の目的は、次の比較に使う「物差し」が二重計上していない状態を作ることです。

## 最初の違和感は`kubectl top`との差だった

最初に取得した値は次の通りでした。

| 計測方法 | CPU | Memory |
|---|---:|---:|
| `kubectl top`の一時点 | 43m | 55Mi |
| Prometheusの5分平均、重複を含む | 68.8m | 107.1Mi |
| Prometheusの5分平均、重複除外 | 37.8m | 56.9Mi |

`kubectl top`はMetrics Serverから直近のresource metricsを取得します。Kubernetes公式ドキュメントでも、これはautoscaling向けの安定したsignalであり、精密なmonitoring systemの代替ではないと説明されています。そのため、`kubectl top`を絶対的な正解にはしませんでした。

ただし、Prometheus側で重複を除外した値が`kubectl top`に近づいたことは、target discoveryを疑う手掛かりになりました。

一時的な確認には、次のような重複除外queryを使いました。

```promql
sum(
  max by (namespace, pod, container) (
    container_memory_working_set_bytes{
      namespace="logging",
      pod=~"fluent-bit-.*",
      container!="",
      image!=""
    }
  )
) / 1024 / 1024
```

ここで`max by (...)`を恒久対応とは考えていません。`service`や`instance`だけが異なる重複seriesを一時的にまとめるための診断用queryです。label設計を誤ると、正当に別物であるseriesまで隠す可能性があります。

## 5ノードなのにtargetが9個あった

まず、nodeごとのcAdvisor target数を数えました。

```promql
count by (node) (
  up{
    job="kubelet",
    metrics_path="/metrics/cadvisor"
  }
)
```

結果は、4ノードが`2`、追加したGPUノードだけが`1`でした。

![修正前のcAdvisor target数。5ノードのうち4ノードが2 targetになっている](/images/2026-w28-prometheus-cadvisor-measurement-integrity/01-target-count-before.png)

クラスタは5ノードなので、期待値は各node `1`、合計5です。実際には合計9でした。

この時点で、CPUやmemoryのqueryを直すより先に、なぜ同じkubeletが複数targetとして発見されているのかを調べることにしました。

## 影響はFluent Bitだけではなかった

同じPod/containerに何本のcAdvisor seriesがあるかを数えました。

```promql
count(
  count by (namespace, pod, container) (
    container_memory_working_set_bytes{
      job="kubelet",
      metrics_path="/metrics/cadvisor",
      container!="",
      image!=""
    }
  ) > 1
)
```

重複していたPod/container groupは138でした。

| Namespace | 重複group数 |
|---|---:|
| `longhorn-system` | 36 |
| `kube-system` | 25 |
| `calico-system` | 20 |
| `monitoring` | 14 |
| `harbor` | 9 |
| `argocd` | 7 |
| `misskey` | 3 |
| `observability` | 2 |
| その他 | 22 |

つまり、Fluent Bitのresource baselineだけの問題ではありませんでした。Longhorn、control plane、monitoring、Misskeyを含むクラスタ全体のresource queryが、条件によって過大に見える状態でした。

## 1つのServiceMonitorが2つのServiceを拾っていた

Prometheusのactive targets APIから、IPではなくdiscovery metadataだけを取り出しました。

```bash
curl -fsS \
  http://prometheus:9090/api/v1/targets?state=active |
jq -r '
  .data.activeTargets[] |
  select(.scrapeUrl | contains("/metrics/cadvisor")) |
  [
    .scrapePool,
    (.labels.node // "-"),
    (.discoveredLabels.__meta_kubernetes_endpoints_name // "-")
  ] |
  @tsv
'
```

分かったことは次の通りです。

```text
scrape pool:
  serviceMonitor/monitoring/kube-prometheus-stack-kubelet/1

current Service / Endpoints:
  kube-prometheus-stack-kubelet
  5 targets

legacy Service / Endpoints:
  kps-kube-prometheus-stack-kubelet
  4 targets
```

scrape poolは1つでした。追加のScrapeConfigやstatic targetがあったわけではありません。

ServiceMonitorのselectorは次のlabelを見ていました。

```json
{
  "app.kubernetes.io/name": "kubelet",
  "k8s-app": "kubelet"
}
```

現行と旧Serviceの両方がこのselectorに一致していました。そのため、1つのServiceMonitorが2つのEndpoints objectを対象にし、同じkubeletを二重にscrapeしていました。

PrometheusのKubernetes service discoveryで`endpoints` roleを使う場合、Serviceに紐づくEndpointsの各addressとportがtargetになります。Prometheus OperatorのServiceMonitorも、label selectorで対象のEndpointsを選びます。今回の挙動はこの仕組みどおりで、selectorに一致する旧objectが残っていたことが問題でした。

![修正前後のdiscovery構造](/images/2026-w28-prometheus-cadvisor-measurement-integrity/05-discovery-before-after.png)

## なぜすぐ削除しなかったか

旧Serviceが原因と分かっても、すぐには削除しませんでした。

名前に`legacy`と書いてあるわけではなく、現在どのcontrollerやreleaseが所有しているかを確認しないと、削除後に再生成されたり、別の監視経路を壊したりする可能性があるためです。

削除前に次を確認しました。

| 確認項目 | 結果 |
|---|---|
| Prometheus Operatorが参照するkubelet Service | 現行Service |
| 現行Serviceのtarget数 | 5 |
| 旧Serviceのtarget数 | 4 |
| 旧Serviceに対応するHelm release | なし |
| Argo CD resource reference | なし |
| GitOps repository reference | なし |
| ownerReference | なし |
| rollback manifest | 保存済み |

さらに、旧ServiceとEndpointsからserver管理fieldを除いたrestore用manifestを作りました。

```text
rollback:
  kubectl apply -f legacy-service-restore.json
  kubectl apply -f legacy-endpoints-restore.json
```

このpreflightで`safe_to_remove=yes`になった後にだけ、旧Serviceを削除しました。

ここではPrometheusの再起動、ServiceMonitorの変更、EndpointSliceへの移行を同時には行いませんでした。原因が旧Serviceだと分かった以上、変数を増やさず、原因objectだけを除去する方が結果を説明しやすいと判断しました。

## 修正結果

旧Serviceを削除し、Prometheusのservice discoveryとstaleness反映を待ってから再確認しました。

| 指標 | 修正前 | 修正後 |
|---|---:|---:|
| Kubernetes nodes | 5 | 5 |
| cAdvisor active targets | 9 | 5 |
| legacy targets | 4 | 0 |
| unhealthy cAdvisor targets | 0 | 0 |
| 重複Pod/container groups | 138 | 0 |
| 現行Endpoints address | 5 | 5 |

![修正後のcAdvisor target数。5ノードすべてが1 targetになっている](/images/2026-w28-prometheus-cadvisor-measurement-integrity/02-target-count-after.png)

application側のgateも確認しました。

```text
nodes Ready:       5/5
bad pods:          0
probe_success:     1
pg_up:             1
cleanup_result:    PASS
```

監視targetを減らした結果だけではなく、Misskeyのread-only probeとPostgreSQL exporterが正常であることまで確認しました。監視設定の修正によって、研究対象のapplication pathを壊していないことを確かめるためです。

## raw queryとdeduplicated queryが一致した

修正後、クラスタ全体のCPUとmemoryについて、通常の合計と`max by(...)`を使った重複除外合計を比較しました。

```text
CPU raw:                         1595.2m
CPU deduplicated:                1595.2m
CPU raw / deduplicated ratio:    1

Memory raw:                      13085.9Mi
Memory deduplicated:             13085.9Mi
Memory raw / deduplicated ratio: 1
```

active targetは5、重複groupは0でした。

これで、今後のresource比較では、重複を隠すための`max by(...)` workaroundを前提にする必要がなくなりました。

## Fluent Bitのbaselineを確定した

Fluent BitはOpenSearch停止中にも送信を続けていたため、すでに停止しています。既知の配送失敗を再発させて「修正後の値」を取り直すことはしませんでした。

代わりに、停止前の履歴を現行Serviceのlabelで限定して再計算しました。

```text
CPU raw 5分平均:        68.8m
CPU canonical 5分平均:  37.8m

Memory raw 5分平均:        107.1Mi
Memory canonical 5分平均:   56.9Mi
```

![現行Serviceに限定したFluent Bit CPU baseline](/images/2026-w28-prometheus-cadvisor-measurement-integrity/03-fluent-bit-cpu-canonical.png)

![現行Serviceに限定したFluent Bit memory baseline](/images/2026-w28-prometheus-cadvisor-measurement-integrity/04-fluent-bit-memory-canonical.png)

ここで分かったのは「Fluent Bitが重い」ということではありません。むしろ、停止中backendへ送り続けていたFluent Bitのresource消費より先に、そのresource値を測るPrometheus側が二重計上していたことが問題でした。

## head seriesの減少は慎重に扱う

調査中のPrometheus head seriesは次のように変化しました。

```text
調査時:       194326
修正直後:     193081
最終検証時:   192535
```

また、cAdvisor seriesをService別に数えた時点では、旧Service由来が12137、現行Service由来が13152でした。修正後は現行Service由来が13137でした。

ただし、Prometheus全体のhead seriesは、他workloadの生成・消滅、scrape timing、staleness、head blockの状態でも変わります。したがって、head seriesの差をすべて旧Service削除の効果とは断定しません。

今回の成功条件は、より直接的な次の値に置きました。

```text
active targets:          9 -> 5
duplicated groups:     138 -> 0
raw/deduplicated ratio:  1
```

## source of truthも別のgateとして残った

runtime上の重複は解消しました。一方、その後の棚卸しで、kube-prometheus-stackにはArgo CD Applicationと過去のHelm release recordが併存し、ローカルのGitOps manifestとlive valuesも完全には揃っていないことが分かりました。

Helm release record自体がcontrollerとして自動reconcileするわけではありません。しかし、将来どちらの手順でも更新できてしまう状態は、source of truthを曖昧にします。

今回のcAdvisor重複の直接原因とは分けて扱いますが、次の比較実験へ入る前に以下を行います。

- kube-prometheus-stackの更新経路をArgo CDへ統一する
- live valuesをGitのdesired stateへ回収する
- Grafana admin Secretの非決定的renderを止める
- 手動Helm操作をrunbook上で禁止する
- Argo CDを`Synced / Healthy`へ戻す

測定値だけでなく、その測定器を誰が管理するかもmeasurement integrityの一部だと考えています。

## 判断

今回の調査で採用した判断は次の通りです。

### 1. 比較対象より先に測定器を検証する

OpenSearchとLoki、Fluent BitとAlloyを比較する前に、Prometheusのresource集計が正しいことをgateにしました。

### 2. 独立したsignalは「正解」ではなくsanity checkに使う

`kubectl top`とPrometheusは同じ計測pipelineではありません。完全一致を求めず、大きな乖離を疑うための独立signalとして使いました。

### 3. query workaroundで異常を隠さない

`max by(...)`で値を近づけることはできましたが、恒久対応にはしませんでした。target discoveryのroot causeを除去しました。

### 4. 削除前に所有関係とrollbackを確認する

旧objectに見えても、controller、Helm、Argo CD、GitOps、ownerReferenceを確認してから削除しました。

### 5. 一度に複数の変数を変えない

EndpointSlice移行やPrometheus再起動を同時に行わず、旧Serviceだけを除去しました。

### 6. application gateまで確認する

監視の修正が成功しても、applicationとDBを壊していれば失敗とみなします。`probe_success`と`pg_up`を終了条件に入れました。

## 今後のObservability stack比較へどう使うか

今後は、各候補を次の順序で比較する予定です。

```text
Logs L1: collector比較
  Fluent Bit -> Loki
  Alloy      -> Loki

Logs L2: backend比較
  Fluent Bit -> OpenSearch
  Fluent Bit -> Loki

Traces T1: backend比較
  OTel Collector -> Jaeger
  OTel Collector -> Tempo

Traces T2: collector比較
  OTel Collector -> Tempo
  Alloy          -> Tempo
```

この比較では、少なくとも次を事前gateにします。

- active scrape targetが意図した数である
- rawとdeduplicatedのresource queryが一致する
- comparison対象以外のworkload状態が固定されている
- collector/backendの有効状態がsource of truthに残っている
- raw evidenceと公開用summaryを分離している
- rollback手順がある

LGTMを採用するかどうかは、この比較結果を確認した後に決めます。

## 今回確認できたことと、まだ確認していないこと

確認できたこと:

- 5ノードに9個のcAdvisor targetが存在した
- 同じServiceMonitorが現行と旧Serviceの両方を選択していた
- 138 Pod/container groupが重複していた
- 旧Serviceを安全確認後に削除した
- active targetは9から5になった
- 重複groupは138から0になった
- rawとdeduplicatedの比率は1になった
- application gateは維持された

まだ確認していないこと:

- すべてのmetric familyに対する影響量
- 過去dashboardの再解釈が必要な範囲
- 長期的なPrometheus storage削減量
- Mimirを導入する価値
- Loki / OpenSearch、Alloy / Fluent Bitの比較結果
- multi-clusterやHA Prometheusでの再現性

今回の結果は、このhomelabの特定構成で確認したものです。すべてのkube-prometheus-stack環境に同じ問題があることを示すものではありません。

## まとめ

Observability stackを比較しようとしたところ、比較に使うPrometheus自身がresourceを二重計上していました。

原因は、1つのServiceMonitorが現行のkubelet Serviceと旧Serviceの両方を選択し、5ノードを9 targetとしてscrapeしていたことでした。

旧Serviceの所有関係とrollback経路を確認してから削除し、結果は次のようになりました。

```text
cAdvisor targets:          9 -> 5
duplicated groups:       138 -> 0
CPU raw/dedup ratio:       1
Memory raw/dedup ratio:    1
nodes Ready:              5/5
probe_success:              1
pg_up:                      1
```

今回の一番大きな学びは、Observability製品の比較表を作る前に、その比較に使う測定系の正しさを確認する必要があるということでした。

次は、kube-prometheus-stackのsource of truthとGrafana Secret driftを整理し、Fluent BitとOpenSearchの停止状態を再現可能なprofileへ移します。その後、同じ入力と同じresource条件でLoki、OpenSearch、Alloy、Fluent Bitを比較します。

## 参考資料

- [Prometheus configuration: Kubernetes service discovery](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#kubernetes_sd_config)
- [Prometheus Operator API: ServiceMonitorSpec](https://prometheus-operator.dev/docs/api-reference/api/#monitoring.coreos.com/v1.ServiceMonitorSpec)
- [Kubernetes: kubectl top](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/)
