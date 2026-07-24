---
title: Fluent BitとGrafana Alloyを正常系・通信断・SIGKILLで比較した――zero-lossをcollectorに委ねない設計判断
date: 2026-07-24
tags:
  - kubernetes
  - observability
  - lgtm
  - loki
  - fluent-bit
  - grafana-alloy
  - opentelemetry
  - sre
  - benchmark
  - resilience
---

Grafana LGTMへ寄せるなら、ログcollectorもGrafana Alloyへ統一すべきなのでしょうか。あるいは、既存のFluent Bitを残した方がよいのでしょうか。

この判断を「同じベンダーだから」「CNCF graduatedだから」「軽量と言われているから」で決めたくありませんでした。そこで、同一Node・同一Loki・同一corpusを使い、正常系、圧縮、backend通信断、retry policy、collector processのSIGKILLまで段階的に比較しました。

最終的な設計判断は、単純な勝者選びではなく、次の2つに分かれました。

```text
通常のObservabilityログ:
  Grafana Alloyを第一候補にする

strict incident evidence / audit相当ログ:
  file-tail collector単体をzero-loss境界にしない
  producer側outboxまたはdurable queueを別途設計する
```

正常系では両collectorとも完全配送できました。しかし、通信断中にcollector processをSIGKILLすると、Fluent Bitのfilesystem buffering、Alloyのpositions、Alloyのexperimental WALのいずれでも欠損が発生しました。さらにFluent Bitを`storage.sync=full / DB.Sync=Full`へ強化し、4.2.2と5.0.9でformal runを行っても、strict zero-lossは再現しませんでした。

![実験全体の基本構成](/images/2026-w30-fluent-bit-alloy-collector-selection/00-experiment-design.png)

## 結論の要約

| 評価軸 | Fluent Bit | Grafana Alloy | 判断 |
|---|---|---|---|
| 正常系の完全性 | 5/5 PASS | 5/5 PASS | 同等 |
| 完了時間 | 約61.5秒 | 約61.4秒 | 実質同等 |
| CPU | 高め | 低め | Alloy優位 |
| memory | 約15〜16MiB | 約50〜54MiB | Fluent Bit優位 |
| network | gzipで約8.7MiB | Snappyで約12.6MiB | codec依存 |
| backend通信断・collector生存 | 5/5完全配送 | 5/5完全配送 | 両方利用可能 |
| 通信断中のprocess SIGKILL | 欠損あり | 欠損あり | 両方strict zero-loss未達 |
| LGTM / OTLP統合 | 個別collector | 複数signalを統合可能 | Alloy優位 |

この研究で重要だったのは、collector内部の`drop=0`をend-to-end完全性と同一視しなかったことです。SIGKILL試験では、drop counterが0でもLoki上のsequenceには欠損がありました。

## 実験環境

主な条件は次のとおりです。

```text
Kubernetes nodes: 5
comparison node: k8s-worker3
Loki: 3.7.3, monolithic, single replica
storage: Longhorn longhorn-1rep
corpus: deterministic JSONL
records: 100,000
streams: service × level = 24
producer duration: 60 seconds
Fluent Bit: 4.2.2 / 5.0.9
Grafana Alloy: 1.17.1
fault injection: Toxiproxy
collector restart: same Pod内でprocessへSIGKILL
```

corpusには連番、service、level、trace ID、canary文字列を含めました。各runでは単なる件数だけでなく、次を確認しました。

- visible records
- unique sequence
- missing sequence
- duplicate sequence
- JSON parse error
- 24 streamsの一致
- corpus SHA-256再構成
- collectorのinput / sent / retry / drop counter
- CPU、memory、network
- filesystem state、Tail DB、positions、WAL
- Node、Misskey probe、PostgreSQLのhealth gate

## 比較前に、測定系を直した

最初から正しい比較ができたわけではありません。

Fluent Bit classic configurationのmain fileへ`PARSER` sectionを置き、Podが起動しませんでした。Prometheus text formatの末尾timestampをmetric valueとして誤集計したこともあります。別の段階では、PrometheusがkubeletのcAdvisor targetを重複scrapeしており、resource baselineが二重計上されていました。

これらはcollectorの性能差ではなく、測定系の問題です。そのため、正式比較前に次を実施しました。

1. 5,000件smokeでinput / sent / drop / retry / SHA-256を確認
2. cAdvisor重複targetを特定してlegacy objectを削除
3. raw metricとdeduplicated metricを比較し、比率1を確認
4. harness failureとproduct failureを別分類にする
5. 失敗runだけを選んで再実行しない

100,000件を一気に送った初期試験では、Lokiのtenant ingestion rate limitによりHTTP 429が発生しました。collector差ではなくbackend limitだったため、formal runでは入力を60秒へ平準化し、24 streamsへ分割しました。

## 正常系では両方とも完全配送した

最初のformal benchmarkでは各collectorを5回、固定したinterleaved orderで実行しました。全10runで次を満たしました。

```text
visible=100,000
unique=100,000
missing=0
duplicates=0
parse_errors=0
content_hash_match=true
retries=0
dropped_records=0
```

中央値は次のとおりです。

| 項目 | Fluent Bit | Alloy |
|---|---:|---:|
| completion | 61.530秒 | 61.400秒 |
| catch-up | 1.530秒 | 1.400秒 |
| CPU core-seconds | 6.9881 | 4.1793 |
| 平均memory | 16.188MiB | 54.235MiB |
| peak memory | 20.691MiB | 73.789MiB |
| network TX | 69.95MiB | 12.75MiB |

完了時間はほぼ同じでした。一方、AlloyはCPUで有利、Fluent Bitはmemoryで有利でした。

![正常系のCPU core-seconds](/images/2026-w30-fluent-bit-alloy-collector-selection/01-normal-cpu-core-seconds.svg)

![正常系の平均memory](/images/2026-w30-fluent-bit-alloy-collector-selection/02-normal-memory-average.svg)

ただし、この時点のnetwork差を製品差として扱うのは誤りでした。Fluent Bitは無圧縮、Alloyはlogproto / Snappyだったためです。

## 圧縮条件を変えるとnetworkの優劣が反転した

transport sensitivityでは次の実運用候補を比較しました。

```text
Fluent Bit: JSON + gzip
Alloy:      logproto + Snappy
```

この条件でも10/10 runが完全性ゲートを通過しました。

| 項目 | Fluent Bit + gzip | Alloy |
|---|---:|---:|
| completion | 61.455秒 | 61.350秒 |
| catch-up | 1.454秒 | 1.350秒 |
| CPU core-seconds | 9.1827 | 4.1542 |
| 平均memory | 15.214MiB | 49.646MiB |
| peak memory | 20.105MiB | 72.117MiB |
| network TX | 8.74MiB | 12.57MiB |

AlloyのCPU core-secondsはFluent Bit + gzipより約54.8%少ない結果でした。一方、Alloyの平均memoryは約3.26倍でした。network TXはFluent Bit + gzipの方が約30.5%少ない結果でした。

![CPU・memory・networkのトレードオフ](/images/2026-w30-fluent-bit-alloy-collector-selection/03-transport-tradeoff.svg)

ここから得た教訓は、collector比較でtransportを独立変数として扱わないと、networkの結論を誤るということでした。

## backend通信断中にcollectorが生きている場合

次に、100,000件を60秒で生成し、30秒からproducer終了までcollectorとLokiの間だけをToxiproxyで遮断しました。collector process自体は停止させませんでした。

formal orderを固定して各collector 5run、合計10run実行したところ、両方とも次を満たしました。

```text
visible=100,000
unique=100,000
missing=0
duplicates=0
parse_errors=0
dropped_records=0
```

ただし、回復特性は大きく異なりました。

| 中央値 | Fluent Bit | Alloy |
|---|---:|---:|
| recovery to complete delivery | 69.140秒 | 5.757秒 |
| catch-up | 69.711秒 | 6.750秒 |
| fault終了時state | 103.5MiB | 24KiB |
| CPU core-seconds | 12.7281 | 3.1838 |
| fault memory peak | 58.316MiB | 75.648MiB |

![通信断後のdelivery recovery](/images/2026-w30-fluent-bit-alloy-collector-selection/04-outage-recovery.svg)

![fault終了時のstate directory](/images/2026-w30-fluent-bit-alloy-collector-selection/05-outage-state.svg)

この結果を「Alloy engineが12倍速い」とは解釈しませんでした。Fluent Bitはdefault retry scheduler、Alloyは別のbackoff envelopeであり、transportも異なります。観測したのは**今回のprofile全体の回復時間**です。

Fluent Bitはfilesystemへ大きなbacklogを保持し、Alloyはmemory中心で短時間にdrainしました。Fluent Bitはmemoryを抑え、Alloyはmemoryを使って回復速度を得る構成でした。

## retryを短くしても速くならなかった

Fluent Bitのdefault schedulerは`base=5 / cap=2000`です。そこで、他条件を固定し、`cap=10`へ短縮しました。

結果は改善ではなくinput lagでした。

```text
producer records: 100,000
input records:     98,862
sent records:      98,436
completion timeout: yes
classification: INPUT_LAG_WITH_STORAGE_BACKLOG
```

fault終了時には648 filesystem chunks、574 down chunks、624 busy chunksが観測されました。timeout時にはchunkがdrainしていましたが、Tail inputは100,000件を読み切りませんでした。

さらに`base=1 / cap=10`でも同様にinput completion gateを通過しませんでした。

ここで重要なのは、retry intervalを短くすれば必ず回復が速くなるわけではないことでした。retry回数の増加はoutputだけでなく、input進捗やevent loopへ影響する可能性があります。内部原因を完全には証明できていないため、記事では「retry stormが原因」と断定せず、storage backlogとinput lagの同時観測までを事実として扱います。

## 通信断中にcollector processをSIGKILLした

backend通信断だけでは両collectorとも完全配送できました。次に、fault中にcollector processも停止させました。

最初はPodをforce deleteして再作成しましたが、旧process終了と新Pod起動が競合し、製品ではなくハーネスを測ってしまいました。そこで`shareProcessNamespace: true`を使い、同じPod内のcontroller sidecarからcollector processへSIGKILLし、kubeletにcontainerだけを再起動させました。

```text
0秒:  producer開始
30秒: ToxiproxyでLoki通信を遮断
45秒: collector processへSIGKILL
60秒: producer終了、通信復旧
```

これにより、Pod scheduling、Longhorn detach / attach、PVC remountを変数から除外しました。

単発B2の結果は次のとおりです。

| Profile | missing | duplicates | stateの特徴 |
|---|---:|---:|---|
| Fluent Bit normal/normal | 12 | 0 | Tail DB + filesystem chunks |
| Alloy stable | 429 | 0 | positionsのみ |
| Alloy experimental WAL | 367 | 0 | WAL生成あり |

![同一Pod SIGKILLの単発B2](/images/2026-w30-fluent-bit-alloy-collector-selection/06-process-restart-single-run.svg)

Alloy stableのpositionsはfile read offsetを保存するが、Lokiへの配送完了位置ではありません。したがって、positionsが進んだ後、`loki.write`へ到達する前またはmemory上に残ったentryはSIGKILLで失われる可能性があります。

Alloy WALでは約47MiBのWALがSIGKILL前に存在しました。しかし、公式に説明されるdurability境界はentryが`loki.write` componentへ到達した後であり、file sourceからWALまでのhandoffは別のfailure windowとして残ります。今回の367件をWAL replay不良と断定する証拠はありません。

## Fluent Bitの同期を強化した

Fluent Bitではfilesystem chunkとTail offset DBが別の永続化対象です。そこで段階的に同期設定を強化しました。

```text
normal / Normal: storage.sync=normal, DB.Sync=Normal
full   / Normal: storage.sync=full,   DB.Sync=Normal
full   / Full:   storage.sync=full,   DB.Sync=Full
```

単発smokeでは次の結果でした。

| Profile | missing | classification |
|---|---:|---|
| normal / Normal | 12 | DATA_LOSS |
| full / Normal | 20 | DATA_LOSS |
| full / Full | 0 | EXACT_PASS |

`full / Full`が初めてEXACT_PASSになりました。しかし、成功した1runを見て採用するのはselection biasになります。そこで、このprofileを固定して5run replicationを行いました。

### Fluent Bit 4.2.2 full/full formal replication

```text
EXACT_PASS: 2/5
DATA_LOSS:  3/5
missing_total: 206 / 500,000
parse_errors: 4
duplicates: 0
drop_total: 0
result: NOT_REPLICATED
```

### Fluent Bit 5.0.9 version sensitivity

versionだけを5.0.9へ変更し、同じfull/full profileを5run実行しました。

```text
EXACT_PASS: 0/5
DATA_LOSS:  5/5
missing_total: 555 / 500,000
parse_errors: 0
duplicates: 0
drop_total: 0
result: NOT_REPLICATED
```

![Fluent Bit version sensitivity](/images/2026-w30-fluent-bit-alloy-collector-selection/07-version-sensitivity-missing.svg)

4.2.2の欠損率は観測上0.0412%、5.0.9は0.111%でした。ただし、単一のKubernetes検証クラスタで各version 5runを実行した小規模な試験であり、「5.0.9は4.2.2より悪い」という一般的なregression結論には使いません。

確定したのは、**version upgradeでも今回のstrict zero-loss gateは通過しなかった**という点です。

また、5.0.9の初回連続試験では、TCP readiness成立直後にmetrics HTTP endpointが404を返すharness raceがありました。producer開始前の失敗だったため製品runへ含めず、既に有効だったsequence 1を再実行せず、HTTP 200 pollを追加してsequence 2〜5だけを継続しました。

## drop counterが0でも欠損した

最も重要な結果の一つは、全formal durability runでcollector側のdrop counterが0だったことです。

```text
collector reported drop: 0
Loki missing sequence:   206 または 555
```

collector内部metricは、そのcomponentが認識したdropしか表しません。Tail offset更新、chunk永続化、component間handoff、process crash、backend到達というend-to-end経路には、内部drop counterだけでは観測できない境界があります。

strict evidenceで必要なのは、次の複合的な完全性監視です。

- producerが発行したsequence
- collectorが読み取った位置
- durable queueへACKされた位置
- backend到達件数
- duplicateと欠損
- checksumまたはcontent hash
- queue depthとoldest age

## 最終設計判断

### 通常のObservabilityログはAlloyを第一候補にする

正常系では両collectorとも完全配送でき、完了時間も同等でした。そのうえで、Alloyは今回のtransport条件でCPU core-secondsが約54.8%少ない結果でした。

memoryはFluent Bitより約3.26倍であり、無条件に軽量とは言えません。それでも検証クラスタの通常ログでは、次の理由からAlloyを第一候補にします。

1. CPU効率が高い
2. Loki / Prometheus / Tempo / OpenTelemetryを1つのcomponent graphへ統合できる
3. LGTMのdatasource相関とOTLP pipelineへ自然に接続できる
4. collector数を将来的に削減できる可能性がある

ただし、採用時にはmemory request / limit、per-node footprint、config validation、rollbackをrelease gateにします。現在停止中のFluent Bit定義は、移行期間のrollback資産として保持します。

### strict evidenceは別pipelineにする

今回の結果から、container stdoutをfile-tail collectorが読み、local bufferからLokiへ送る構成をstrict zero-loss境界にはしません。

必要なのは、collectorより上流でdurability ACKを返す仕組みです。

![最終アーキテクチャ判断](/images/2026-w30-fluent-bit-alloy-collector-selection/08-final-architecture.png)

候補構成は次のようになります。

```text
Application / system event
  -> transactional outbox or persistent journal
  -> durable message queue
  -> OpenTelemetry Collector gateway
       sending_queue + file_storage
  -> Loki native OTLP endpoint
  -> optional immutable/archive sink
```

OpenTelemetry Collectorの`file_storage` sending queueはcollector restart時の再送に利用できるが、disk failure、queue overflow、retry expirationは別のfailure modeであり、専用message queueより保証が弱くなります。したがってsecondary bufferとして使い、system of recordにはしません。

検証クラスタ向けのdurable queue候補としてはNATS JetStreamが軽量ですが、採用前に次を比較します。

- FileStorageとACK境界
- replicas=3のquorum
- fsync interval
- duplicate windowとidempotency
- consumer ACK / redelivery
- Node障害とdisk障害
- local SSDとLonghornのどちらを使うか
- queue容量、retention、replay速度
- GitOps、backup、upgrade、運用コスト

NATS公式はJetStreamをcluster replicationと各server固有のlocal storageで運用し、NAS / NFSを避けるよう説明しています。したがって、Longhornへ単純に載せるのではなく、local disk + JetStream replicationとLonghorn-backed single volumeのfailure domainを別途測る必要があります。

## 採用後のrelease gate

Alloyへの移行は、Helm installだけでは完了としません。最低限、次をrelease gateにします。

```text
normal path:
  100,000 records
  missing=0
  duplicates=0
  parse_errors=0

backend outage:
  producer継続
  queue / memory上限以内
  recovery SLO以内

collector restart:
  通常ログSLOを満たす
  strict evidenceは別queueで完全性確認

operability:
  config validation
  resource requests / limits
  dashboard / alert
  GitOps sync
  rollback test
```

## この研究の限界

結果は次の環境に限定されます。

- 単一のKubernetes検証クラスタ
- 1 comparison Node
- Longhorn 1 replica
- Loki monolithic single replica
- 100,000件 / 60秒
- 24 streams
- 各formal group 5run
- process SIGKILLであり、Node電源断ではない
- container runtime、filesystem、kernel、storage deviceの違いは未評価
- Alloy WALはexperimental

また、normal pathとdurabilityではprofileが異なります。CPU、memory、networkの数字をそのままstrict durability profileの性能コストとして流用してはいけません。

4.2.2と5.0.9の欠損総数にも差がありましたが、5runずつであり、一般的なversion rankingには使いません。upstreamへ報告する際は、最小reproducerとraw evidenceを提示し、原因を断定しない方針にします。

## まとめ

今回得た設計原則は次のとおりです。

1. 正常系のbenchmarkだけでcollectorを選ばない
2. transportを揃えずにnetworkを比較しない
3. backend outageとcollector crashを別faultとして扱う
4. retryを短くすれば速くなるとは限らない
5. internal drop counterをend-to-end完全性とみなさない
6. candidate 1runの成功をformal resultへ混ぜない
7. strict evidenceはcollectorより上流にdurability boundaryを置く
8. 通常のObservabilityと監査相当ログを同じSLOにしない

この結論により、collector選定は「AlloyかFluent Bitか」だけではなくなりました。

通常の可観測性ではAlloyを採用候補にします。一方、失ってはいけない証跡は、collectorの再送設定をさらに追い込むのではなく、outbox、durable queue、ACK、replication、replayを含む別pipelineとして設計します。

それが、正常時の効率と障害時の証拠保全を同じ製品の一機能へ押し込めない、今回の最終判断です。

## 参考資料

- [Grafana Alloy documentation](https://grafana.com/docs/alloy/latest/)
- [Grafana Alloy: loki.write WAL](https://grafana.com/docs/grafana-cloud/send-data/alloy/reference/components/loki/loki.write/)
- [Loki: Ingesting logs using OpenTelemetry Collector](https://grafana.com/docs/loki/latest/send-data/otel/)
- [OpenTelemetry Collector: Resiliency](https://opentelemetry.io/docs/collector/resiliency/)
- [Fluent Bit: Buffering and storage](https://docs.fluentbit.io/manual/administration/buffering-and-storage)
- [Fluent Bit: Tail input](https://docs.fluentbit.io/manual/pipeline/inputs/tail)
- [Fluent Bit: Scheduling and retries](https://docs.fluentbit.io/manual/administration/scheduling-and-retries)
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream)
