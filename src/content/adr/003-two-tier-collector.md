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

Node-local collection and cluster-level enrichment have different responsibilities.

## Decision

Use a two-tier OTel Collector topology.

## Options

- Put all processing in a DaemonSet.
- Put all processing in a gateway.
- Split node-local collection and cluster-level enrichment.

## Consequences

The topology is more explicit. There are more components to operate, but the failure domains are easier to reason about.
