# 0006 — Fallback and recovery behavior

Status: accepted (M5, 2026-11-14)

The guaranteed recovery path is pointer mode: the board, toolbar, keyboard
shortcuts, history, and export never depend on the camera or the model.

| Condition | Behavior |
|---|---|
| No media APIs / insecure origin / no camera / permission denied / camera busy | Specific explanation with Try again and Use mouse; insecure origin and missing APIs are detected without prompting. |
| Permission prompt left open | Start stays disabled ("Starting…"), Cancel is available, mouse drawing works; a later answer is discarded and its stream stopped. |
| Model download fails or times out | Explanation + Try again; asset paths are versioned so retry is safe. |
| Model integrity check fails | "Model is damaged" explanation; no delegate retry (same file). |
| GPU delegate fails to start | A fresh CPU worker is started automatically. |
| GPU delegate runs on a software rasterizer (warm-up > 50 ms/frame) | A CPU worker is started too and the faster one kept (ADR 0002). |
| Worker crash or inference timeout | Up to 2 worker restarts per minute ("Restarting hand tracking…"), then a failure explanation; the board is untouched. |
| Camera unplugged / track ended | "Camera disconnected" with Try again; the board is untouched. |
| Tab hidden or window blurred | Editing and inference pause immediately; Resume (button, P, or hand) and an open hand are required to continue. |
| Tab hidden > 30 s | Camera stopped, explanation shown; restart is explicit. |
| Page hidden for navigation (pagehide) | Camera tracks stopped and worker terminated. |
| Stale results (> 100 ms since frame observation) | Treated as tracking loss: interactions freeze; no stale cursor. |
| Ambiguous hand identity | Current interaction ends conservatively; the hand must be seen open again. |
| 2D canvas context restored after loss | Caches are rebuilt from the vector document. |
| Board reaches the hard guard (500,000 points or 5,000 strokes) | New ink is refused with an explanation; existing work is kept; export and clear remain available. |
| Browser cannot encode the PNG | Explanation; board and history unchanged. |

Not provided: a main-thread inference compatibility mode (plan §6 allows it
only with acceptable measured task durations; 25–37 ms synchronous calls would
not be), a TFJS backend, and mobile camera drawing.
