---
title: Private Misskeyでは自然流量が足りないので、SLO v0とmetrics-only baselineを先に固定した
date: 2026-07-05
tags:
  - kubernetes
  - sre
  - observability
  - rca
  - misskey
  - prometheus
  - grafana
---

この記事は、metrics-only RCA実験の前編です。PostgreSQL lock waitを起こす前に、Private Misskeyで何を正常状態として扱うかを固定します。

PostgreSQL lock wait の実験に入りたかったが、その前に一度止めました。Misskey は動いているものの、現状は private 運用で、ユーザーも投稿もほとんどありません。この状態で fault injection をしても、「何が遅くなったのか」「どのSLOを破ったのか」が曖昧になります。

そこで今回は、障害を入れる前に SLO v0 と metrics-only baseline を固定しました。結論から言うと、現時点の Misskey は自然流量では研究負荷にならないため、read-only の synthetic traffic を先に定義する必要がありました。

## 3行まとめ

- Misskey の現在規模は user=4、note=0、DB size=18MB で、自然流量はRCA実験には不足していました。
- LAN内 read-only synthetic check では success rate 100%、p95 9.6ms、p99 10.5ms でした。
- Prometheus / Grafana / blackbox exporter を使って、SLO v0をダッシュボードで追える状態にしました。

## まず、Misskeyがどれくらい使われているかを見る

最初に見たのは、MisskeyのDBサイズと主要テーブルの件数です。

- database size: 18 MB
- user: 4
- note: 0
- drive_file: 0
- following: 0

これを見て、自然流量を前提にしたRCA実験はまだ無理だと判断しました。たとえば public なSNSとして運用していれば、投稿、閲覧、画像アップロード、リモート配送などが自然に流れます。しかし今回の環境では、それらがほぼありません。

つまり、今のMisskeyは「動いているWeb workload」ではあるが、「自然に負荷が発生する研究対象」ではありません。この差を最初に言語化しておかないと、後の実験で都合のよい解釈をしてしまいます。

## SLO v0はproduction SLOではない

今回定義したSLOは、production SLOではありません。private Misskey と LAN内 synthetic traffic を前提にした、研究用のSLO v0です。

今回のSLO v0は以下にしました。

- Synthetic read-only success rate >= 99.0%
- Synthetic homepage p95 <= 250ms
- Synthetic homepage p99 <= 1000ms
- HTTP 5xx < 1%
- fault injection前に all nodes Ready、bad pods=0、Longhorn degraded=0
- PostgreSQL blocking locks=0

この値は厳密なユーザー契約ではなく、次の実験で「通常状態からどれだけ外れたか」を見るための基準です。

## read-only synthetic check

まずは単純な `GET /` を一定間隔で叩きました。投稿APIはまだ使っていません。理由は、書き込み系に入るとテストアカウント、token、投稿データ、cleanupなどを先に設計する必要があるためです。

最初の結果は以下でした。

- count: 60
- success_rate: 100.00%
- avg: 0.0081s
- p50: 0.0076s
- p95: 0.0096s
- p99: 0.0105s

かなり低い値ですが、これはLAN内からLoadBalancerへ叩いた結果です。外部ユーザーの体感ではありません。ここはブログ上でも誤解されやすいので、明示しておきます。

## CSVだけでは足りない

最初はcurlのCSVで十分かと思いましたが、RCA実験では不十分です。CSVに残っているだけでは、障害発生中にGrafana上で他のメトリクスと並べて見られません。

そこで blackbox exporter の Probe を作りました。

- Probe: monitoring/misskey-readonly-http
- job: misskey-readonly-http
- prober: blackbox-exporter.blackbox.svc.cluster.local:9115
- target: Misskey read-only path

これにより、Prometheusで以下が見られるようになりました。

- probe_success
- probe_http_status_code
- probe_duration_seconds

## Dashboard v0を作る

次に、Grafanaに `RCA Metrics-only v0` というdashboardを作りました。

![RCA Metrics-only v0 dashboard gate](/images/2026-w27-metrics-only-rca/annotated/01-rca-dashboard-precheck-annotated.png)

この画像で見たいのは、単にパネルが並んでいることではありません。重要なのは、実験前ゲートが成立していることです。5ノードがReadyで、Node Pressureは0、MisskeyのReady Podは3、GPUも1として見えています。

また、Misskey CPUやMemoryに小さな変化はありますが、Container RestartsやPVC Phaseは安定しています。つまり、少なくともこの時点では「アプリが壊れている状態でbaselineを取っている」わけではありません。

## ここまでの判断

この段階で、次に進む条件はだいたい揃いました。

- Misskeyの規模が小さく、synthetic trafficが必要だと分かった
- read-only SLO v0を定義した
- blackbox exporterでPrometheusに入った
- Grafanaでbaselineが見えるようになった
- PostgreSQL blocking locksは通常時0だった

ただし、まだlogs/tracesは使っていません。これは意図的です。まずmetrics-onlyでどこまで判断できるかを見たいからです。

## 後編へ

次の記事では、PostgreSQL lock wait を安全なテストテーブルで再現します。いきなりMisskey本体のテーブルをロックするのではなく、専用テーブルで `wait_event_type=Lock` が出ることを確認します。

その後、Prometheus/GrafanaにPostgreSQLのLock wait signalを載せ、metrics-onlyで `0 → 1 → 0` の状態遷移として読めるかを確認します。

[PostgreSQL lock waitをPrometheus/Grafanaで0→1→0として読む](/notes/2026-w27-postgres-lock-wait-prometheus/)
