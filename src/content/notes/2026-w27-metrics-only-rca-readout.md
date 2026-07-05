---
title: metrics-only RCAで今回どこまで切り分けられるようになったか
date: 2026-07-05
tags:
  - kubernetes
  - sre
  - observability
  - rca
  - prometheus
  - grafana
---

ここまでで、SLO v0、blackbox exporter、postgres_exporter、RCA Metrics-only v0 dashboardを用意しました。最後に確認したかったのは、これで本当にRCAらしい判断ができるのか、という点です。

今回の結論は、限定的ですが前進しています。PostgreSQL内部のLock waitはmetrics-onlyで検出できるようになりました。一方で、read-only synthetic SLOは正常のままでした。つまり、今回の事象は「ユーザー可視の障害」ではなく、「DB内部で再現したLock wait」として分離して扱えます。

## 3行まとめ

- DB内部ではLock waitが発生し、Prometheus/Grafana上でも 0 → 1 → 0 の状態遷移として見えました。
- read-only synthetic SLOはsuccess 100%、p95/p99も正常範囲でした。
- metrics-onlyでも、少なくとも「DB内部signal」と「ユーザー可視影響」を分けて判断できるようになりました。

## RCAで見たいのは「上がった」だけではない

今回の判断で見たいのは、`PostgreSQL Lock Wait Sessions` が1になったという事実だけではありません。その値が、どのDB内部状態と対応しているかです。

今回のlock waitでは、次の対応関係を確認しました。

- blocked updater が transactionid lock を待っている
- blocking_pids がholderを指している
- holderはPgSleepでlockを保持している
- つまりDB内部のlock wait ground truthが発生している

一方で、RCA Metrics-only dashboard下段の `Synthetic Success Rate 15m` は100%のままで、`Synthetic p95 Latency 15m` は約27ms、`Synthetic p99 Latency 15m` は約33msでした。ここでいうread-only syntheticは、blackbox exporterがMisskeyの読み取り系パスを定期的に叩いているsynthetic checkです。ここから、今回のlock waitは少なくともread-only pathには影響していないと判断できます。

| Signal | 観測値 | 解釈 |
|---|---:|---|
| PostgreSQL Lock Wait Sessions | 0 → 1 → 0 | DB内部でlock waitは発生し、解消した |
| Synthetic Success Rate 15m | 100% | read-only pathの失敗は発生していない |
| Synthetic p95 / p99 | 約27ms / 約33ms | latency悪化も見えていない |
| Platform health | Ready / Restart / PVCに崩れなし | platform全体の障害ではなさそう |

![RCA Metrics-only dashboard synthetic panels](/images/2026-w27-metrics-only-rca/annotated/06-synthetic-slo-stable-during-db-work.png)

下段のSynthetic panelsを見ると、DB内部でlock waitを再現している間も、read-only synthetic SLOは崩れていません。これは「DB内部signalは変化したが、今回のread-only SLOにはユーザー可視影響が出ていない」と切り分ける根拠になります。

## Grafana上で見えた状態遷移

今回いちばん重要だったのは、PostgreSQLのlock waitが1枚の静止画ではなく、Grafana上で「通常時 → 発生中 → 解消後」の流れとして見えたことです。これは、metrics-only RCAが最小限の診断ループとして機能しているかを見るうえで、かなり強い材料になります。

### 1. 通常時

![PostgreSQL baseline with no lock wait](/images/2026-w27-metrics-only-rca/annotated/02-postgres-baseline-zero-annotated.png)

通常時は、`PostgreSQL Lock Wait Sessions` と `PostgreSQL Blocked Sessions` がともに0で、`PostgreSQL Sessions` は2でした。`Activity by Wait Event` にも `idle / Client / ClientRead` と `active / none / none` が見えており、この時点ではDB内部にロック競合の兆候はありません。

この画面があることで、あとで異常が出たときに「最初から壊れていた」のではなく、fault injectionに同期して変化したと説明できます。

### 2. lock wait発生中

![PostgreSQL lock wait detected in dashboard](/images/2026-w27-metrics-only-rca/annotated/03-postgres-lock-wait-detected-annotated.png)

ロックを保持したまま別セッションから更新を流すと、`Lock Wait Sessions` と `Blocked Sessions` がともに1に上昇しました。同時に `Sessions` は2から5に増え、`Activity by Wait Event` には `active / Lock / transactionid` と `active / Timeout / PgSleep` が現れました。

これは単なる接続数増加ではありません。`blocked updater` が `holder transaction` を待っているという `pg_stat_activity` の観測結果と対応しています。

### 3. 解消後

![PostgreSQL lock wait returned to zero](/images/2026-w27-metrics-only-rca/annotated/04-postgres-lock-returned-to-zero-annotated.png)

テスト終了後は、`Lock Wait Sessions` と `Blocked Sessions` が再び0に戻り、`Sessions` も2に収束しました。一方で時系列グラフには直前のスパイクが残っています。

この「現在値は正常に戻ったが、履歴には発生痕跡が残っている」状態がRCAでは重要です。障害が瞬間的に終わったあとでも、発生と解消の両方を同じダッシュボードで追跡できるからです。

## ダッシュボードから読めること

今回のダッシュボードでは、少なくとも次の3つを同時に見られます。

1. Platform gate
2. User-visible read-only SLO
3. PostgreSQL内部signal

この3つを並べることで、単に「DBで何か起きた」ではなく、影響範囲を少し切り分けられます。

![RCA Metrics-only dashboard overview](/images/2026-w27-metrics-only-rca/annotated/05-misskey-panels-during-db-work-annotated.png)

この画面では、DB/exporter作業のタイミングでPostgreSQL CPUやMemoryが少し上がっています。一方で、Nodes Ready、Pressure、Misskey Ready Pods、Container Restarts、PVC Phaseは崩れていません。

つまり、少なくともこの画面からは、実験中にアプリ全体が壊れたわけではない、と読めます。

## ログとの対応関係

この3枚が説得力を持つのは、Grafana上の変化がPostgreSQL側のground truthと対応していたからです。

実際の `pg_stat_activity` では、`rca-lock-blocked-updater` が `wait_event_type=Lock`、`wait_event=transactionid` になり、`blocking_pids` はholderを指していました。一方で `rca-lock-holder` は `wait_event_type=Timeout`、`wait_event=PgSleep` でした。

テスト後は `remaining RCA sessions=0`、`blocking locks after test=0` も確認しました。つまり、Grafanaの異常シグナル、PostgreSQL内部状態、後始末後の復帰確認がつながっています。

## metrics-onlyで分かるようになったこと

今回の構成で、次は分かるようになりました。

- Misskey read-only pathが生きているか
- synthetic latencyが悪化しているか
- Kubernetes node/pod/PVCが正常か
- GPU nodeが見えているか
- PostgreSQL exporterが生きているか
- PostgreSQLでLock waitが発生しているか
- Lock waitが解消したか

これは、最初のmetrics-only RCAとしては十分な進歩です。

## まだ分からないこと

一方で、まだ分からないこともあります。

- MisskeyのPOST /notesに影響するlock waitは未検証
- logsでどのエラーが出るかは未整理
- tracesでどのspanが伸びるかは未整理
- DB lock waitとアプリケーションlevelのqueue/backpressureの関係は未確認
- LLMに渡すevidence bundleはまだ作っていない

ここを曖昧にせず、次フェーズに分けます。

## 次にやること

次は2つの方向があります。

1つ目は、exporterのログノイズを消すこと。postgres_exporterの `stat_replication` collectorがエラーを出しているので、長時間実験の前に片付けます。

2つ目は、controlled write workloadです。read-only pathではなく、Misskeyの書き込みに近い経路を使って、実際にユーザー可視のSLOが悪化するかを見ます。

ここから先は、metrics-onlyだけで進めるか、logs/tracesを足すかの比較に入れます。ようやく、RCA実験の入口に立てた感覚があります。
