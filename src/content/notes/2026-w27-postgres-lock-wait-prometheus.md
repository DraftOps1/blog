---
title: PostgreSQL lock waitをPrometheus/Grafanaで0→1→0として読む
date: 2026-07-05
tags:
  - kubernetes
  - postgresql
  - prometheus
  - grafana
  - observability
  - rca
---

この記事は、metrics-only RCA実験の後編です。前編では、Private Misskeyの自然流量が少ないため、read-only synthetic SLOと実験前ゲートを先に固定しました。

前回のbaselineでは、PostgreSQLのblocking lockが通常時0であることは確認できました。ただし、その時点では `pg_stat_activity` を手動で見ていただけです。これではmetrics-only RCAとは言いづらい。

今回は、安全なテストテーブルでPostgreSQL lock waitを再現し、それをPrometheusとGrafanaで `0 → 1 → 0` の状態遷移として見えるようにしました。これにより、手動SQLでしか見えなかったDB内部のLock waitを、read-only SLOと同じdashboard上で比較できるようになりました。

## 3行まとめ

- 専用テーブル `rca_experiment.lock_test` でPostgreSQL lock waitを再現しました。
- postgres_exporterのcustom queryで、Lock waitをGrafana上の `0 → 1 → 0` として確認しました。
- 今回の範囲では、DB内部signalは立った一方で、read-only synthetic SLOは崩れていません。

## いきなりMisskey本体は触らない

最初からMisskey本体のテーブルをロックするのは避けました。今回の目的は、ユーザー影響を作ることではなく、DB内部のLock waitを観測可能にすることです。

そのため、専用schemaとテーブルを作りました。

- schema: rca_experiment
- table: rca_experiment.lock_test

このテーブルで、1行だけを対象にしてrow lockを再現しました。

## lock waitの再現

実験は3つの役割に分けました。

- holder: transactionを開いてrow lockを保持する
- blocked updater: 同じrowを更新しようとして待つ
- observer: pg_stat_activityとPrometheusを見る

SQL側では以下が見えました。

- blocked updater: wait_event_type = Lock
- wait_event = transactionid
- blocking_pids = holder pid
- holder: wait_event_type = Timeout / wait_event = PgSleep

この状態が、今回のground truthです。

![PostgreSQL lock wait sequence](/images/2026-w27-metrics-only-rca/concept/postgres-lockwait-sequence.svg)

blocked updaterは `statement_timeout` により終了しました。これは失敗ではなく、意図した安全装置です。テスト後にセッションやロックが残り続けるのを避けるためです。

## 最初の課題: 手動SQLでは見えるがdashboardには出ない

最初のsmoke testでは、`pg_stat_activity` を手動で見ればLock waitは分かりました。しかし、Grafana dashboardだけを見るとDB内部で何が起きているかは分かりませんでした。

この状態だと、metrics-only RCAとしては弱いです。RCA担当者が毎回PostgreSQLに入ってSQLを叩くなら、それはdashboard-drivenな切り分けではありません。

そこで postgres_exporter を追加しました。

## postgres_exporter v0

今回追加したものは以下です。

- Deployment: monitoring/misskey-postgres-exporter
- Service: monitoring/misskey-postgres-exporter
- ServiceMonitor: monitoring/misskey-postgres-exporter
- ConfigMap: monitoring/misskey-postgres-exporter-queries

標準メトリクスに加えて、RCA用のcustom metricsを追加しました。

- pg_rca_activity_by_wait_sessions
- pg_rca_lock_wait_sessions
- pg_rca_blocked_sessions
- pg_rca_sessions_sessions

ここで重要なのは、単にPostgreSQL exporterを入れたことではありません。今回のRCAで見たい粒度に合わせて、`wait_event_type` と `wait_event` を明示的に集計したことです。

## Grafanaで見えるようになった変化

まず通常時は、PostgreSQL exporterは起動しており、`Lock Wait Sessions` と `Blocked Sessions` は0でした。ここを先に確認しておくことで、後続の1への上昇がfault injectionに同期した変化だと判断できます。

![PostgreSQL baseline with no lock wait](/images/2026-w27-metrics-only-rca/annotated/02-postgres-baseline-zero-annotated.png)

通常時。Lock waitもblocked sessionも発生しておらず、DB内部の競合兆候は見えていません。

lock waitを再実行すると、Grafana上で次の変化が見えました。

- PostgreSQL Lock Wait Sessions が 0 から 1 に上がる
- PostgreSQL Blocked Sessions が 0 から 1 に上がる
- PostgreSQL Sessions が 2 から 5 に増える
- Activity by Wait Event に `active / Lock / transactionid` が出る
- holder側は `active / Timeout / PgSleep` として見える

![PostgreSQL lock wait detected in dashboard](/images/2026-w27-metrics-only-rca/annotated/03-postgres-lock-wait-detected-annotated.png)

lock wait発生中。`blocked updater` が `holder transaction` を待ち、Lock Wait Sessions / Blocked Sessions がともに1へ上がっています。

`Lock Wait Sessions` と `Blocked Sessions` が同時に1へ上がっているため、これは単なるPostgreSQL接続増加ではなく、実際にブロックされたSQLが存在することを示します。

## lock waitは一過性で戻った

テスト後、メトリクスは0に戻りました。

![PostgreSQL lock wait returned to zero](/images/2026-w27-metrics-only-rca/annotated/04-postgres-lock-returned-to-zero-annotated.png)

解消後。現在値は0に戻っていますが、時系列には直前のスパイクが残り、発生から解消まで追跡できます。

ここで見たいのは、過去にスパイクが残っていることと、現在値が0に戻っていることです。つまり、DB内部ではLock waitを再現できたが、テスト後に残留ロックや残留セッションはありません。

## read-only SLOは崩れていない

今回のlock waitは、Misskey本体のテーブルではなく専用テーブルで起こしています。そのため、read-only pathには大きな影響は出ないはずです。ここは推測で終わらせず、RCA Metrics-only dashboard上のsynthetic panelsでも確認しました。

![RCA Metrics-only dashboard synthetic panels](/images/2026-w27-metrics-only-rca/annotated/06-synthetic-slo-stable-during-db-work.png)

smoke test中のread-only syntheticは、次の状態でした。

| Signal | 観測値 | 解釈 |
|---|---:|---|
| PostgreSQL Lock Wait Sessions | 0 → 1 → 0 | DB内部でlock waitは発生し、解消した |
| Synthetic Success Rate 15m | 100% | read-only pathの失敗は発生していない |
| Synthetic p95 / p99 | 約27ms / 約33ms | smoke test中のlatency悪化は見えていない |
| Platform health | Ready / Restart / PVCに崩れなし | platform全体の障害ではなさそう |

この値は前編のbaseline値とは測定タイミングが違います。前編のp95 9.6ms / p99 10.5msは、fault injection前にLAN内から取得した初期baselineです。ここで見ている約27ms / 約33msは、smoke test中にdashboard上で見た15分窓の値です。

ここから、今回の事象は「DB内部ではlock waitが発生したが、read-only synthetic SLOには影響していない」と切り分けられます。ただし、これはread-only pathに限定した判断です。Misskeyのwrite pathや実ユーザー影響まで確認できたわけではありません。

## 既知の問題

postgres_exporter の標準collectorで `stat_replication` のエラーが出ています。

- collector: stat_replication
- error: column "slot_name" does not exist

今回の `pg_rca_*` メトリクスは取れているため、実験は進められます。ただし、長時間実験に入る前にはログノイズを消す必要があります。

## metrics-onlyで今回分かったこと

今回の前後で、見えるものが変わりました。

Before:

- `pg_stat_activity` を手動で見ればLock waitが分かる
- GrafanaだけではDB内部のLock waitが分からない
- read-only SLOとDB内部signalを同じ画面で比較できない

After:

- Prometheusで `pg_rca_lock_wait_sessions` が見える
- GrafanaでLock waitの発生と解消を見られる
- `wait_event_type` / `wait_event` の種類まで追える
- read-only SLOとDB内部signalを同じdashboardで比較できる

今回の範囲では、metrics-onlyだけで「DB内部のlock waitは発生したが、read-only pathのSLOは破っていない」と判断できました。これは完成したRCA基盤ではありませんが、metrics-only baselineの最初の穴は埋まりました。

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

ここから先は、metrics-onlyだけで進めるか、logs/tracesを足すかの比較に入れます。
