---
decisionId: ADR-004
title: Make evidence bundle the RCA boundary
date: 2026-06-04
status: proposed
area: root cause evaluation
tags:
  - rca
  - evidence
---

## Context

Ad hoc backend queries make RCA results hard to compare across runs.

## Decision

Use a versioned evidence bundle as the input boundary for RCA.

## Options

- Query each backend directly during evaluation.
- Export screenshots and notes by hand.
- Use a structured evidence bundle.

## Consequences

The evaluation becomes easier to repeat. The bundle schema also becomes part of the research surface.
