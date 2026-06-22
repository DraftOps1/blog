---
title: Observability実験の前に、Kubernetes基盤の運用状態を確認した
date: 2026-06-22
tags:
  - kubernetes
  - sre
  - platform
  - observability
  - rca
  - homelab
---

Misskey を Kubernetes 上にデプロイしたので、次はすぐに fault injection や LLM を使った根因推定へ進みたくなる。  
ただ、今回の環境ではその前に一度、基盤側の状態を確認しておく必要があると感じた。理由は、Node のリソース逼迫や実験対象外の workload が残ったまま障害注入をすると、あとで観測したレイテンシやエラーが「狙った fault」によるものなのか、単なる基盤ノイズなのか分からなくなるからである。

正直、最初は `misskey.lan` が HTTP 200 を返していれば、最低限は次へ進めると思っていた。  
しかし、Kubernetes 上で状態を持つアプリケーションを扱う場合、HTTP 200 だけでは足りなかった。Pod、Node、Storage、GitOps、Ingress まで見て、少なくとも今回の環境では「この状態なら次の RCA 実験に入れそう」と言えるかを確認した。


## 前提と非スコープ

今回見るのは、Kubernetes 上で動く Misskey と、その周辺の platform component である。  
ここでの目的は Misskey の機能評価ではなく、RCA / observability 実験に入る前の基盤状態を確認することである。

今回見るもの:

- Kubernetes Node / Pod の状態
- Argo CD 上の GitOps state
- Misskey / PostgreSQL / Redis
- Traefik / MetalLB 経由の到達性
- Longhorn volume
- Prometheus / Grafana で見えるリソース状況
- 実験対象外 workload の停止状態

今回見ないもの:

- Misskey の機能評価
- Misskey のユーザー体験
- ActivityPub federation の挙動
- 本番公開構成
- LLM による根因推定
- traces / logs / profiles を使った比較

今回は、あくまで **RCA 実験に進む前の operability check** として扱う。

## なぜ Misskey 単体のログだけでは足りないのか

Misskey 自体にもログや管理画面はある。  
ただ、今回見たいのは Misskey の内部状態だけではない。

Kubernetes 上で `misskey.lan` にアクセスする場合、リクエストはおおまかに次のような層を通る。

```text
Client
  -> hosts / DNS
  -> MetalLB LoadBalancer
  -> Traefik Ingress
  -> Kubernetes Service
  -> Misskey Pod
  -> PostgreSQL
  -> Redis
  -> Longhorn PVC
  -> Node resource
  -> GitOps desired state
```

この構成では、たとえば HTTP 503 が出ても、それが Misskey のアプリケーションバグとは限らない。  
Ingress が悪いのか、Service endpoint が消えたのか、Pod が evict されたのか、Longhorn の attach が遅れているのか、Node pressure が起きているのかを分けて見る必要がある。

以前の復旧作業でも、最初はアプリケーション側の問題に見えたものが、実際には root filesystem の逼迫や Evicted Pod、Longhorn の attach / detach と絡んでいた。ここは、もう少し早い段階で見ておくべきだった。

## なぜ Kubernetes 上で Misskey を動かすのか

Misskey を単に動かすだけなら、VM や Docker Compose の方が分かりやすい。  
それでも Kubernetes 上で動かす理由は、今回の研究対象が Misskey のホスティングではなく、**Kubernetes platform 上の observability と RCA の境界**だからである。

Kubernetes 上に状態を持つ Web アプリケーションを置くと、次のような運用境界が出てくる。

- Deployment / StatefulSet
- Service / Ingress
- LoadBalancer
- PersistentVolume
- Node pressure
- Storage attach / detach
- GitOps drift
- Pod rescheduling
- Network overlay
- Controller / webhook failure

これらは、アプリケーションログだけでは切り分けにくい。

今回の環境では、Misskey は PostgreSQL、Redis、PVC、Ingress を持つ workload になっている。  
そのため、RCA 実験の題材としては、単純すぎず、かといって最初から制御不能でもない、ちょうどよい複雑さがあると考えている。

## まず CLI で operability gate を見る

最初に、ターミナルでクラスタ全体の状態を確認した。

![terminal operability gate](/images/2026-w25-operable-platform/terminal-01.png)

ここで見たのは、主に以下である。

- 全 Node が `Ready`
- bad pods が空
- Misskey / Harbor / Argo CD が HTTP 200
- Node ごとの CPU / memory
- memory 使用量上位の Pod

この時点で大事なのは、「画面上で赤くなっていない」ことではなく、実験前のノイズになりそうな要素が残っていないかを見ることである。

今回の確認では、`bad pods` は空だった。  
また、`misskey.lan`、`harbor.lan`、`argocd.lan` は CLI から HTTP 200 を返していた。

```text
misskey.lan: HTTP/1.1 200 OK
harbor.lan:  HTTP/1.1 200 OK
argocd.lan:  HTTP/1.1 200 OK
```


```text
停止前:
k8s-worker2  6115Mi  80%

停止後:
k8s-worker2  5811Mi  76%
```

この差だけで「十分に改善した」とまでは言わないが、少なくとも実験対象外 workload を止める理由にはなった。

## Argo CD で desired state を確認する

次に Argo CD の Applications 一覧を見た。

![Argo CD applications overview](/images/2026-w25-operable-platform/argocd-applications-overview.png)

ここでは、単純にすべてが `Synced / Healthy` ならよい、という見方はしなかった。  
今回の環境では、稼働させたいものと、あえて止めているものが混ざっているためである。

今回の整理は次のようにした。

```text
Running:
  - misskey
  - metrics-server
  - minio
  - velero
  - opencost
  - harbor
  - Prometheus / Grafana

Suspended or intentionally reduced:
  - cust-kenso-rag
  - redmine-stack
  - OpenSearch / Dashboards
```

`OutOfSync` が残っているものもある。  
ここは少し気持ち悪いが、今回の目的はすべてをきれいな状態にすることではなく、次の RCA 実験に影響する状態を説明できるようにすることだった。

Argo CD を見る理由は、単にアプリ一覧を見るためではない。  
Git 上の desired state と、実際の runtime state がどこまで一致しているかを確認するためである。  
特に GitOps 管理下で workload を停止した場合、その停止が手作業の一時対応なのか、Git に残った意図的な状態なのかを区別できることが重要になる。

## Misskey は状態を持つ workload として見る

Misskey の Argo CD tree も確認した。

![Argo CD Misskey app tree](/images/2026-w25-operable-platform/argocd-misskey-app-tree.png)

今回の Misskey は、単体の stateless web app ではない。  
少なくとも以下を持っている。

- Misskey Deployment
- PostgreSQL StatefulSet
- Redis StatefulSet
- Misskey files PVC
- Service
- Ingress

この構成では、ユーザーから見える遅延やエラーが、アプリ、DB、Redis、Storage、Ingress、Node のどこに起因するかを分ける必要がある。

たとえば、`POST /notes` のレイテンシが悪化した場合でも、原因候補は複数ある。

```text
POST /notes latency increase
  -> Misskey process saturation
  -> PostgreSQL lock wait
  -> Redis queue backlog
  -> Longhorn I/O wait
  -> Node memory pressure
  -> Ingress / Service endpoint issue
```

このように、1つの症状に対して fault domain が複数ある。  
だからこそ、次の段階で metrics only、logs、traces、profiles を順番に足して比較する意味がある。

## cust-kenso-rag を停止した理由

RCA baseline に進む前に、`cust-kenso-rag` という以前研究目的で動かしていたアプリケーションを停止した。

理由は、今回の実験対象が Misskey / PostgreSQL / Redis だからである。  
`cust-kenso-rag` は現時点の fault class には関係しない。一方で、停止前の確認では worker2 上で約 681MiB 程度のメモリを消費していた。

```text
停止前:
cust-kenso/cust-kenso-rag-d4557c4c6-w2mqn  681Mi
worker2 memory: 6115Mi / 80%

停止後:
cust-kenso-rag deployment: 0/0
worker2 memory: 5811Mi / 76%
```

そのまま動かしておくと、PostgreSQL lock wait の smoke test 中に、node resource pressure のノイズが混ざる可能性がある。

今回は削除ではなく、Deployment を `replicas: 0` にした。PVC は残している。

```text
停止:
  workload noise を減らす
  PVC は残す
  rollback できる

削除:
  データと復旧経路を失う
```

この区別は、実験用クラスタでも重要だと思う。  
研究用途とはいえ、復旧不能な削除を軽くやると、あとで比較や再現がしづらくなる。

## OpenSearch も一時停止した

OpenSearch と OpenSearch Dashboards も一時停止した。

ここは少し迷った。  
observability の研究なのに、ログ基盤を止めるのは一見逆に見えるからである。

ただ、今回の最初の baseline は metrics-only と決めている。  
その状態で OpenSearch を動かしたまま worker2 のメモリを圧迫すると、実験対象の PostgreSQL lock wait とは別のノイズが入る。

今回の最終確認では、memory 上位 Pod に OpenSearch は出ていない状態になっていた。  
少なくとも最初の metrics-only baseline では、Prometheus / Grafana を残し、OpenSearch は logs baseline の段階で戻す方がよいと判断した。

```text
残す:
  - Prometheus
  - Grafana
  - node exporter
  - kube-state-metrics

止める:
  - OpenSearch
  - OpenSearch Dashboards

理由:
  - 最初の baseline は metrics-only
  - logs backend は後続フェーズで戻す
  - node memory pressure の混入を減らしたい
```

ここでの学びは、observability 基盤も観測対象であり、同時に負荷源でもあるという点だった。  
「監視を増やせばよい」ではなく、その監視基盤がどのくらい CPU / memory / storage / I/O を使うかも見ておく必要がある。

## Grafana でクラスタ全体を見る

Grafana で Kubernetes cluster のリソース状態を確認した。

![Grafana Kubernetes cluster resources](/images/2026-w25-operable-platform/grafana-k8s-cluster.png)

この画面では、CPU / memory の傾向を見る。  
ただし、平均値だけを見てもあまり意味はない。今回のような小さいクラスタでは、1つの重い Pod が特定ノードに寄るだけで、実験結果に影響する。

今回の確認では、CPU はまだ余裕があった。  
一方で、memory はノードごとの偏りを気にする必要があった。

特に worker2 は、kube-apiserver、Prometheus、Misskey、Grafana、Longhorn 関連が同居しやすく、メモリ使用率が高めに出ていた。  
このノードは、今後も RCA 実験のノイズ源になり得る。

## Pod 単位でメモリを見る

Pod 単位のメモリ使用量も確認した。

![Grafana pod memory ranking](/images/2026-w25-operable-platform/grafana-pod.png)

ここで見たかったのは、どの Pod が上位にいるかである。

今回の確認では、上位には kube-apiserver、Prometheus、Argo CD application controller、Longhorn instance-manager、Misskey などがいた。

見たい観点は次の通り。

- Prometheus がどれくらい使っているか
- kube-apiserver が大きくなりすぎていないか
- Misskey が想定外に増えていないか
- 実験対象外の Pod が上位に残っていないか
- OpenSearch や cust-kenso-rag が残っていないか

この確認で、不要な workload が上位に残っている場合は、RCA baseline の前に止める判断をする。

今回の環境では、Prometheus は metrics-only baseline に必要なので残した。  
ただし、Prometheus も 1GiB 前後使うため、今後の負荷試験では「観測のための負荷」として明示的に扱う必要がある。

## Node 単位でも見る

Node 単位の状態も確認した。

![Grafana node view](/images/2026-w25-operable-platform/grafana-node.png)

以前、worker1 / worker3 の root filesystem が逼迫し、ephemeral-storage eviction が起きた。  
そのため、CPU や memory だけでなく、node filesystem も見る必要がある。

ここは少し意外だった。  
最初はアプリケーションや Ingress の問題に見えたが、実際には root filesystem の余裕がなく、Pod eviction と再配置が連鎖していた。

Kubernetes 上の HTTP 503 は、必ずしも Ingress やアプリケーションの問題ではない。  
Node 側の ephemeral-storage pressure で Pod が evict され、結果として backend endpoint が消えることもある。

この経験から、RCA の最初の確認項目に Node pressure を入れる必要があると考えるようになった。

## Prometheus で node pressure を見る

Prometheus でも node pressure を確認した。

![Prometheus node pressure query](/images/2026-w25-operable-platform/prometheus-node.png)

fault injection の前に見たいのは、DiskPressure、MemoryPressure、PIDPressure が出ていないことだ。  
これらが出ている状態で DB lock wait を注入すると、観測された遅延が DB lock によるものなのか、node pressure によるものなのかを分離しづらくなる。

今後アラートや事前チェックに入れるなら、少なくとも次は見たい。

```promql
kube_node_status_condition{condition="DiskPressure",status="true"}
kube_node_status_condition{condition="MemoryPressure",status="true"}
kube_node_status_condition{condition="PIDPressure",status="true"}
```

メモリ余裕も別途見る。

```promql
node_memory_MemAvailable_bytes / 1024 / 1024 / 1024
```

filesystem については、mountpoint を絞ったうえで確認したい。

```promql
node_filesystem_avail_bytes{fstype!="tmpfs"} / 1024 / 1024 / 1024
```

単に「監視する」ではなく、実験前には `Pressure=true` が出ていないことを確認する。  
また、今回のような 8GiB 程度のノードでは、available memory が 1GiB を下回る状態で負荷試験を始めるのは避けたい。

この 1GiB という値は厳密な閾値ではない。  
今回の環境で kube-apiserver、Prometheus、Longhorn、Misskey が同居していることを考えると、最低限そのくらいの余裕は見ておきたい、という運用上の目安である。

## Longhorn で Storage を見る

Longhorn Dashboard も確認した。

![Longhorn dashboard](/images/2026-w25-operable-platform/longhorn-dashboard.png)

Storage は、Kubernetes 上の stateful workload ではかなり重要である。  
Pod が Running でも、Volume attach / detach / rebuild が不安定なら、アプリケーションは正常に動かない可能性がある。

Volume 一覧も確認した。

![Longhorn volumes](/images/2026-w25-operable-platform/longhorn-volumes.png)

ここでは、次を見た。

- 稼働中アプリの attached volume が healthy か
- 停止中アプリの volume が detached になっているか
- degraded volume が残っていないか
- replicas が意図した数になっているか

停止中 workload に紐づく volume が detached になること自体は、今回の環境では異常とは扱わない。  
一方で、Misskey や Harbor のような稼働中 workload の attached volume が degraded なら、実験前に止まるべきだと考えている。

Node 側も確認した。

![Longhorn nodes](/images/2026-w25-operable-platform/longhorn-node.png)

Longhorn の状態は、アプリケーションログだけでは分からない。  
ただし、障害時にはアプリケーション障害のように見えることがある。  
そのため、Storage layer も RCA の signal として扱う必要がある。

## 実際の Misskey UI を見る

最後に、実際の Misskey UI も確認した。

![Misskey home](/images/2026-w25-operable-platform/misskey.png)

CLI やダッシュボードで正常に見えていても、ユーザーが使う入口で壊れていれば意味がない。  
今回の確認では、`misskey.lan`、`harbor.lan`、`argocd.lan` が CLI 上でも HTTP 200 を返していた。

ただし、今回の範囲ではユーザー操作のレイテンシまでは測っていない。  
これは次の metrics-only baseline で見る。

つまり、今回確認できたのは以下である。

```text
確認できた:
  - UI が開く
  - Ingress 経由で到達できる
  - 主要サービスが HTTP 200 を返す
  - Kubernetes resource と user-facing endpoint が矛盾していない

まだ見ていない:
  - POST /notes の p95 / p99 latency
  - fault injection 時の error rate
  - DB lock wait 時の切り分け時間
  - traces / logs / profiles を使った比較
```

## 今回の運用判断

今回の状態を、自分の中では以下のように扱う。

```text
Running:
  - Misskey
  - PostgreSQL
  - Redis
  - Traefik
  - MetalLB
  - Longhorn
  - Argo CD
  - Harbor
  - Prometheus / Grafana
  - node exporter
  - kube-state-metrics

Suspended:
  - cust-kenso-rag
  - OpenSearch
  - OpenSearch Dashboards
  - Redmine workload

Preserved:
  - cust-kenso PVC
  - OpenSearch PVC
  - Redmine PVC
```

この状態なら、少なくとも PostgreSQL lock wait の smoke test には進めそうだと判断した。  
もちろん、本番相当の安全性を確認したわけではない。今回の検証は、あくまで研究用の fault injection に入る前の baseline 固定である。

## 実運用で見るべき判断軸

今回の確認から、実運用で見るべき点も少し整理できた。

### 可用性

HTTP 200 だけでなく、backend endpoint が存在するかを見る。  
Traefik が生きていても、Service endpoint が消えれば 503 になる。

見るもの:

```bash
kubectl get endpoints -A
kubectl get ingress -A
curl -I -H 'Host: misskey.lan' http://192.168.1.200/
```

判断:

- UI が開く
- Ingress が期待する Service に向いている
- Service endpoint が存在する
- backend Pod が Ready

この4つが揃わない場合、アプリログを見る前に platform 側を疑う。

### レイテンシ

今回は未測定。  
次回以降、k6 または Prometheus 側で p95 / p99 を取る。

見るもの:

```text
p95 latency
p99 latency
error rate
throughput
```

判断:

- 平常時の p95 / p99 を取る
- fault injection 後の差分を見る
- まずは metrics-only でどこまで切れるか記録する

### API Server 負荷

小さいクラスタでは kube-apiserver が意外とメモリを使う。  
今回も kube-apiserver は top memory pods の上位にいた。

見るもの:

```bash
kubectl top pods -A --sort-by=memory
```

今後は次も見たい。

```promql
apiserver_request_total
apiserver_request_duration_seconds_bucket
```

判断:

- kube-apiserver が常に上位にいること自体は異常ではない
- ただし、負荷試験や Argo CD sync と同時に増える場合は、RCA 実験のノイズになり得る
- 実験中に API Server 側が詰まるなら、アプリ fault と分けて扱う

### Storage

Longhorn の attached volume が healthy かを見る。  
detached volume は、停止中 workload なら許容する。

見るもの:

```text
Longhorn volume state
Longhorn robustness
attached / detached
replica count
```

判断:

- 稼働中 workload の volume が degraded なら実験前に止める
- 停止中 workload の detached volume は異常扱いしない
- rebuild 中は I/O ノイズになるため、fault injection は避ける

### セキュリティ

今回のスクリーンショットは public repo に置くため、認証情報や token が写っていないことを確認した。  
ダッシュボードのスクショは便利だが、公開 repo では地味に危ない。

見るもの:

```text
URL bar
ユーザー名
メールアドレス
token
Secret
Harbor robot account
Grafana / Argo CD の認証情報
```

判断:

- Secret や token が写っている画像は使わない
- 個人メールや認証URLが写る場合はトリミングする
- 内部IPは今回の研究ログでは許容するが、必要に応じてマスクする

### コスト・リソース

OpenSearch は便利だが、今回の小さいクラスタでは baseline の最初から動かすには重かった。  
少なくとも metrics-only baseline では止めておく判断にした。

見るもの:

```bash
kubectl top nodes
kubectl top pods -A --sort-by=memory
```

判断:

- 実験に関係ない heavy workload は止める
- ただし PVC は残す
- logs baseline に入る段階で OpenSearch / Loki などを戻す

### チーム内の責任分界点

Misskey の問題なのか、Platform の問題なのかを分ける必要がある。  
今回のように HTTP 503 が出ても、原因がアプリとは限らない。

整理すると、責任境界はおおよそ次のようになる。

```text
Application:
  - Misskey application error
  - application logs
  - request handling

Database / Queue:
  - PostgreSQL lock wait
  - Redis backlog
  - connection pool

Platform:
  - Node pressure
  - Ingress / Service
  - Longhorn volume
  - Argo CD sync
  - Network / DNS
```

この分け方を先に決めておくと、RCA 実験で false lead count を数えやすくなる。

## 次にやること

次は PostgreSQL lock wait の smoke test を行う。  
まだ LLM は使わない。

まず、DB 上に専用のテストテーブルを作り、lock wait を安全に再現する。  
その後、次の順番で比較する。

```text
1. metrics only
2. metrics + logs
3. metrics + logs + traces
4. evidence bundle
5. Local LLM
```

この順番にすることで、どの signal が RCA に効いたのかを分離して評価しやすくなる。

今回の記事は、きれいな機能紹介ではない。  
実験に入る前に何を確認し、どこを不安要素として扱ったかの記録である。

地味だが、ここを飛ばすと後の RCA 結果が信用しづらくなる。  
今回やってみて、RCA の前処理として"実験対象ではないものを止める","止めた理由を残す","残したものの負荷を見る"という作業がかなり重要だと感じた。
