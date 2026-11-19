# Google Play policy note (SMS permissions)

## Why v1 is outside Play

The SMS Gateway Android app declares **`RECEIVE_SMS`** and **`READ_SMS`** so it
can capture inbound messages for the paired account. Google Play treats these
as **restricted** permissions: in practice they are limited to the device’s
**default SMS handler** or to apps that receive an **approved exception** under
Play’s SMS/Call Log policy.

This product is a **sidecar SMS forwarder**, not a replacement SMS client. It
does not aim to be the default SMS app. Therefore **v1 ships outside the Play
Store** (sideloaded / GitHub Releases + Obtainium). See
[install.md](./install.md) and [releasing.md](./releasing.md).

## What a future Play listing would require

If we later want a Play listing, expect at least:

1. **Policy fit** — either become (or embed) a compliant default SMS role, or
   obtain a Play-approved restricted-permissions exception with a clear
   core-functionality justification.
2. **Play App Signing** — upload key / Play-managed signing; may differ from
   the GitHub Releases keystore used for sideload builds (plan migration and
   dual-channel signing carefully).
3. **Data safety / permissions declaration** — accurate SMS data handling,
   retention, and encryption disclosures.
4. **Target API / photo-video / foreground service** forms — keep
   `targetSdk` and FGS (`specialUse`) declarations aligned with current Play
   Console questionnaires.
5. **Store listing + review** — privacy policy URL, screenshots, and a review
   narrative that matches the actual SMS access pattern.

Until that path is approved, treat Play as **out of scope** for distribution;
keep the sideload channel documented and signed.
