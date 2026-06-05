---
title: Loki label and log stream boundaries
date: 2026-06-03
tags:
  - loki
  - logs
  - cardinality
---

Loki labels are not just search metadata. They define stream shape.

```yaml
labels:
  app: misskey
  namespace: social
  pod: misskey-web-0
```

High-cardinality labels make streams easier to find but harder to operate.

![Signal flow](/images/signal-flow.svg)

## Takeaway

Use labels for stable dimensions. Put request IDs and user-specific values in the log body.
