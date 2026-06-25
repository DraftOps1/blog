---
title: GitHub Issuesに研究ロードマップを逃がして、タスク管理を整理する
date: 2026-06-24
tags:
  - kubernetes
  - sre
  - platform
  - observability
  - rca
  - github
  - research-log
---

前回の記事を書いたあと、次にやることを整理しようとして、少し手が止まった。  
`metrics-only RCA baseline`、`k6 workload`、`Chaos Engineering`、`Beyla`、`logs baseline`、`Misskey invite-only公開` など、やりたいことは増えている。一方で、それらを頭の中やローカルのメモ帳だけに置いておくと、タスクが増えるほど全体像が掴みづらくなる。さらにクラスタ状態も日々変わるので、前にメモした前提がすぐ古くなってしまう。

そこで、研究ロードマップをGitHub Issues / Projectに逃がし、タスクと状態管理を切り離す形に変え始めました。


## 前提と非スコープ

今回扱うものは、研究ロードマップとタスクの管理方法である。

今回扱うもの:

- GitHub Issues / Project を使った研究タスク管理
- 公開ロードマップと非公開運用情報の分離
- 既存構成図の位置づけ

この記事は、実験そのものではなく、実験に進む前の研究の進め方を整理するためのログとする。また、publicにしているのでFBを貰えると嬉しいです。

## なぜローカルのメモだけではつらくなったのか

ここまで、クラスタの状態確認や復旧作業は、ほとんど手元のローカルメモなどで管理しながら進めてきた。  
ただ、タスクが複雑化するにつれて限界が見えた。

たとえば、OpenSearchも最初は動いていたが、metrics-only baseline前には停止した。worker1のLAN IPも、配線変更で変わった。これらを変わりゆくメモの中で追いかけ続けると、古い前提のまま次の作業に進んでしまう可能性がある。

正直、ここは最初からもう少し分けておくべきだったと思う。  
一時的なメモは作業記録としては便利だが、変わり続ける状態の保存場所には向いていない。

## GitHub Issuesにロードマップを逃がす

まず、公開できる研究タスクを `platform-lab-roadmap` というpublic repoのIssuesに置いた。

![metrics-only RCA baseline issue](/images/2026-w26-roadmap-context/01-roadmap-issue-metrics-only.png)

最初に作ったIssueの一つが、`metrics-only RCA baselineを1周回す` である。

このIssueでは、次のように分けた。

- 背景
- やること
- 完了条件
- labels
- Project status

Issueを単にtodoにしないために気を付けている。具体的には、 
`metrics-only RCA baselineをやる` だけでは、あとから見たときに何をもって完了とするか分からない。なので、最低限「公開可能な粒度で説明できる」「metrics-onlyで判断できたこと / できなかったことを整理する」「次に追加するlogs / traces / profilesの候補を出す」という完了条件を入れた。

この粒度なら、あとで見返したときにも、次の作業に落とし込みやすい。

## Issue一覧は、外部メモに近い

Issue一覧はこんな状態になった。

![roadmap issues list](/images/2026-w26-roadmap-context/02-roadmap-issues-list.png)

現時点では、metrics-only baseline、PostgreSQL lock wait、logs baseline、traces baseline、Beyla、Misskey invite-only公開、Chaos Engineering、k6 workload、などを並べています。


研究タスクを次のように分けた。

```text
GitHub Issues:
  公開できる研究・実験・ブログ・ADRタスク

Private GitOps repo:
  実クラスタの設定、運用ログ、内部状態

Blog:
  公開できる範囲に整えた研究ログ
```

今回作成した [`platform-lab-roadmap`](https://github.com/DraftOps1/platform-lab-roadmap) は、publicリポジトリとして公開しています。

もしこのブログを読んで興味を持っていただけた方がいれば、GitHubのIssueやProjectを覗いてもらえると嬉しいです。実験の進め方に対するアドバイス、別ツールの提案、Issueへのコメントなど、どんな形でも歓迎したします。


## 既存構成

現在の構成図も載せておく。

![existing platform architecture](/images/2026-w26-roadmap-context/03-existing-platform-architecture.png)

この図は、現時点のruntime stateを厳密に表す図ではない。  
たとえば、OpenSearchは図の中にあるが、metrics-only baselineに入る前の状態では停止している。Cloudflare Tunnel / Accessも、現在の主なアクセス経路として常に使っているわけではない。

自分がこのクラスタのどの範囲を研究対象として見ているのかを、ざっくり共有する目的です。

今の関心領域は、大きく分けると以下になる。

```text
Edge / Ingress:
  Traefik
  MetalLB
  cert-manager
  Cloudflare系の入口

Workload:
  Misskey
  Local LLM
  other apps

Storage / Backup:
  Longhorn
  Velero
  MinIO / NAS

Observability:
  Prometheus
  Grafana
  OpenSearch
  OpenTelemetry
  Jaeger

Delivery:
  Argo CD
  Harbor
  GitHub Actions

Cost / FinOps:
  OpenCost
```


## public roadmap に置くもの、置かないもの

publicにすると研究の進捗は見える。一方で、クラスタの詳細を出しすぎるとセキュリティ上よくないため、現時点では、public roadmap に置くものは以下に限定する。

```text
公開する:
  - 実験テーマ
  - fault class の候補
  - 比較したいobservability signal
  - 公開記事のtodo
  - 技術選定のADR
  - 高レベルな構成図
  - 成果物の粒度

公開しない:
  - kubeconfig
  - Secret
  - token
  - 詳細すぎる内部IPや認証情報
  - 未整理のraw logs
```


## 今回の時点での運用判断

現時点では、以下のように進めるのがよさそうだと考えている。

```text
今すぐやる:
  - GitHub Issues / Project を研究todoの入口にする
  - 日次operability logを保存する
  - 1か月の通常運用ログを取る
  - 次の実験条件をIssueに落とす

まだ急がない:
  - Misskeyの不特定多数公開
  - federation有効化
  - logs / traces の本格比較
  - LLM RCA

次の実験候補:
  - PostgreSQL lock wait smoke test
  - metrics-only RCA baseline
```

Misskeyを公開するかどうかも少し考えた。  
固定IPはあるが、今すぐ不特定多数に公開する必要はないと思っている。まずはTailscale経由、自分だけの利用、synthetic workloadで1か月運用する方がよさそうだ。公開すると、spam、abuse、moderation、TLS、rate limit、メール配送などが一気に混ざる。これは研究としては面白いが、最初のRCA baselineにはノイズが多すぎる。

## 次にやること

次は、日次operability logを保存する仕組みを作る。  
その後、1か月分の運用ログを見ながら、PostgreSQL lock wait の smoke test と metrics-only RCA baseline に進む。

今回の作業は、Kubernetesの新機能を試したわけではない。  
ただ、研究タスクを頭の中やローカルメモだけで管理するのは限界があると分かった。GitHub Issuesに逃がすことで、少なくとも次に何をやるべきかを会話や記憶から切り離せるようになった。
