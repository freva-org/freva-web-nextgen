---
title: Guide
description: A single prose page, to show what the minimal profile renders.
---

This page exists to prove the smallest useful thing: a Markdown source becomes a
real HTML file at a predictable route, with a heading anchor a reader can link to.

## Headings get stable anchors

The slug algorithm is package-owned and published in the profile, so an anchor
someone wrote into a ticket keeps working across builds.

## Admonitions

:::note[Worth knowing]
Only four directive names are accepted, and an unknown one stops the build.
:::
