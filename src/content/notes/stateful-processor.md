---
title: Stateful processor means operational ownership
date: 2026-06-01
tags:
  - otel
  - collector
  - state
---

A stateful processor changes the risk of the telemetry path.

If it keeps memory, it also needs capacity planning, restart behavior, and failure handling.

## Checklist

- What state is kept?
- What happens on restart?
- What is dropped first under pressure?
- Which dashboard shows the processor health?
