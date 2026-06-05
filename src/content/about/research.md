---
title: 研究内容
tags:
  - Kubernetes
  - Observability
  - Cross-signal
  - Local LLM
  - Misskey
  - Fault Injection
status: in progress
scope: observability / fault injection / RCA evaluation
---

ベアメタル Kubernetes 上で Misskey、PostgreSQL、Redis、Local LLM を同居させ、cross-signal observability と evidence bundle を用いた根因推定評価を行う研究です。

## Purpose

主題はアプリケーション開発ではありません。複数の signal をどう集め、どのように incident の証拠へ変換し、根因推定の速度と精度をどのように評価するかを扱います。

## System

研究環境では、Misskey をユーザー向け workload とし、PostgreSQL、Redis、Local LLM を同じ Kubernetes クラスタ上で運用します。

![Signal flow](/images/signal-flow.svg)

## Observability Design

- logs / metrics / traces / profiles を横断して incident timeline を作る。
- OTel Collector は node-local と cluster-level の二段構成を前提にする。
- Collector 自体の queue、drop、retry、memory usage も観測対象に含める。
- signal の断片ではなく、RCA に使える evidence bundle として整理する。

## Evaluation

| Metric | Meaning |
| --- | --- |
| TTFC | time to first cause |
| MTTR | mean time to repair |
| Top-1 | primary cause accuracy |
| Top-3 | candidate coverage |

## Fault Injection

Redis saturation、PostgreSQL contention、network delay、LLM queue pressure、Collector degradation などを候補にします。

## Research Question

cross-signal evidence bundle を RCA の入力境界にしたとき、TTFC、MTTR proxy、Top-1、Top-3 の評価はどれだけ再現可能になるか。
