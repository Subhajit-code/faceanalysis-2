---
title: Sentinel Face Engine
emoji: 🔐
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

Internal ArcFace (InsightFace) embedding-extraction + liveness-scoring API for the Sentinel biometric attendance system. Not meant for public/direct use — called only by the system's own Node API, gated by the `INTERNAL_TOKEN` secret.
