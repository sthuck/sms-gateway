# Install SMS Gateway (Android)

Install the **prod** APK from this repository’s GitHub Releases. The app is
not on Google Play (see [Play policy notes](./play-policy.md)).

Recommended path: **Obtainium**, which checks GitHub Releases and notifies you
when a newer APK is available. There is **no in-app update checker** — Obtainium
covers “notify when a newer version is available” (STH-19 / Aviad).

## 1. Install Obtainium

1. Install [Obtainium](https://github.com/ImranR98/Obtainium/releases) from its
   own GitHub Releases (or F-Droid).
2. Open Obtainium on the phone that will run the SMS gateway.

## 2. Add this private repo

This repository is **private**. Obtainium needs a read-only GitHub token.

1. Create a GitHub **fine-grained personal access token**:
   - GitHub → Settings → Developer settings → Personal access tokens →
     Fine-grained tokens → Generate new token.
   - Resource owner: the account/org that owns `sthuck/sms-gateway`.
   - Repository access: **Only select repositories** → `sms-gateway`.
   - Permissions → Repository permissions:
     - **Contents**: Read-only
     - **Metadata**: Read-only (required)
   - Generate and copy the token (you will not see it again).
2. In Obtainium, add the app:
   - Source: **GitHub**
   - App repository URL:
     `https://github.com/sthuck/sms-gateway`
   - Additional options / authentication: paste the fine-grained token when
     Obtainium asks for GitHub credentials (or add the token under Obtainium
     settings for GitHub).
3. Prefer the **prod** release APK:
   - APK filter (if prompted): `prod-release` or
     `sms-gateway-.*-prod-release\\.apk`
   - Release channel: latest GitHub Release tagged `v*`
4. Enable **automatic updates** / update notifications in Obtainium for this
   app.

Step-by-step screenshots and token tips: [Obtainium setup](./obtainium.md).

## 3. First launch

1. Open **SMS Gateway**.
2. Grant **Receive SMS** and **Read SMS** when prompted.
3. Pair with the web UI (QR or short code) as usual.
4. Follow the battery-optimisation / OEM checklist if the status screen asks.

## Manual APK install (without Obtainium)

1. Open the latest [GitHub Release](https://github.com/sthuck/sms-gateway/releases)
   (sign in if the repo is private).
2. Download `sms-gateway-<version>-prod-release.apk`.
3. Install it (allow installs from the browser/file manager if Android asks).
4. For updates, repeat the download — or switch to Obtainium so you get
   notifications.

Maintainers: how to cut a release and manage the signing keystore is in
[releasing.md](./releasing.md).
