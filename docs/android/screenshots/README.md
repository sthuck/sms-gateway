# Android UI screenshots

Synthetic Compose captures from the instrumented `UiScreenshotTest` suite
(CI artifact `android-screenshots`). Fake pairing codes, demo device ids, and
demo senders only — no real SMS bodies, tokens, or keys.

| File | Caption | Raw URL (on `main`) |
| --- | --- | --- |
| [01-pairing-entry.png](./01-pairing-entry.png) | Pairing entry — empty code field and example server hint | https://raw.githubusercontent.com/sthuck/sms-gateway/main/docs/android/screenshots/01-pairing-entry.png |
| [02-pairing-confirm.png](./02-pairing-confirm.png) | Pairing confirmation — review code/host before confirming | https://raw.githubusercontent.com/sthuck/sms-gateway/main/docs/android/screenshots/02-pairing-confirm.png |
| [03-status-parked-retry.png](./03-status-parked-retry.png) | Status screen — queued + parked messages with **Retry parked messages** | https://raw.githubusercontent.com/sthuck/sms-gateway/main/docs/android/screenshots/03-status-parked-retry.png |
| [04-permission-rationale.png](./04-permission-rationale.png) | SMS permission rationale / prompt before `RECEIVE_SMS` / `READ_SMS` | https://raw.githubusercontent.com/sthuck/sms-gateway/main/docs/android/screenshots/04-permission-rationale.png |

Source run for these PNGs: Android CI instrumented job on PR #23,
[run 44470555374](https://github.com/sthuck/sms-gateway/actions/runs/44470555374)
(head `0a03363`).
