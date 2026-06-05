---
decisionId: ADR-001
title: Use Misskey as the observable application
date: 2026-05-20
status: accepted
area: workload selection
tags:
  - misskey
  - workload
---

## Context

The workload needs user-facing behavior and stateful dependencies.

## Decision

Use Misskey as the observable application.

## Options

- Build a small sample app.
- Use a synthetic benchmark.
- Use an existing OSS application.

## Consequences

Misskey brings PostgreSQL, Redis, background jobs, and realistic operational behavior into the same environment.
