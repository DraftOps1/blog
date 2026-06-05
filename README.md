# research log

Astroで作った静的サイトです。記事はMarkdownで管理します。

## 書く場所

```text
src/content/changelog/  変更履歴
src/content/notes/      技術記事
src/content/adr/        設計判断
src/content/about/      研究内容
public/images/          画像、図、グラフ
```

Markdownファイルを追加すると、一覧と詳細ページに自動で出ます。

## About

研究内容はこのファイルを編集します。

```text
src/content/about/research.md
```

## Changelog

```markdown
---
title: Evidence bundle schema v0
date: 2026-06-04
week: 2026-W23
focus: evidence bundle / RCA evaluation
tags:
  - logs
  - metrics
next: Add a reproducible Redis saturation scenario.
---

## Changed

...
```

URLはファイル名から決まります。

```text
src/content/changelog/2026-w23.md
=> /changelog/2026-w23/
```

## Note

```markdown
---
title: Loki label and log stream boundaries
date: 2026-06-03
tags:
  - loki
  - logs
  - cardinality
---

本文を書く。
```

## ADR / RFD

```markdown
---
decisionId: ADR-003
title: Use a two-tier OTel Collector topology
date: 2026-06-02
status: accepted
area: observability pipeline
tags:
  - otel
  - collector
---

## Context

## Decision

## Options

## Consequences
```

## 画像

画像は `public/images/` に置きます。

```markdown
![Signal flow](/images/signal-flow.svg)
```

SVG、PNG、WebPが扱えます。グラフもSVGやPNGにして置くのが軽くて管理しやすいです。

## コードブロック

````markdown
```yaml
receivers:
  otlp:
    protocols:
      grpc:
```
````

言語名を付けるとハイライトされます。

## 図やグラフ

基本は画像として管理します。

```text
public/images/latency-baseline.svg
public/images/collector-topology.png
```

Markdownの本文から参照します。

```markdown
![Latency baseline](/images/latency-baseline.svg)
```

Mermaidを本文で直接描画する方法もありますが、JavaScriptが増えます。速さを優先するため、今は画像として埋め込む方針です。

## 確認

```bash
npm run dev
npm run build
```

GitHub Pagesのプロジェクトページでサブパスが必要な場合は、build時に `BASE_PATH` を指定します。

```bash
BASE_PATH=/blog SITE=https://draftops1.github.io npm run build
```

## GitHub Pages

`DraftOps1/blog` の GitHub Pages として公開します。

- 公開URL: `https://draftops1.github.io/blog/`
- build成果物: `dist/`
- deploy: `.github/workflows/deploy.yml`

GitHub 側では `Settings > Pages > Build and deployment` の source を
`GitHub Actions` にします。`main` branch へ push すると Actions が
`BASE_PATH=/blog` で build して Pages に公開します。

公開 repo には `.env*`、`.npmrc`、秘密鍵、agent/tooling state、
`node_modules/`、`dist/`、`.astro/` を含めません。
