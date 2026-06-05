---
title: vLLM queue metrics as an RCA signal
date: 2026-05-30
tags:
  - llm
  - metrics
  - queue
---

Queue depth and waiting time are user-facing signals when Local LLM is part of the RCA path.

## Metrics to watch

```text
queue_depth
waiting_time_seconds
running_requests
preempted_requests
```

## Takeaway

LLM queue pressure should be connected to the incident timeline, not treated as a model-serving detail.
