# Obtainium setup (private GitHub Releases)

Obtainium tracks GitHub Releases and can install/update the SMS Gateway APK
automatically. Per the STH-19 decision, **Obtainium’s update notifications**
satisfy the “app notifies when a newer version is available” criterion — the
Android app does **not** include an in-app update checker.

## Why a GitHub token?

`sthuck/sms-gateway` is a **private** repository. Without authentication,
Obtainium cannot list releases or download APK assets. Use a **fine-grained**
personal access token with the least privilege needed.

## Create a read-only fine-grained token

1. Sign in to GitHub as a user who can read `sthuck/sms-gateway`.
2. Open **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens**.
3. **Generate new token**:
   - **Token name**: e.g. `obtainium-sms-gateway` (phone-specific is fine).
   - **Expiration**: pick a date you will rotate (e.g. 90 days).
   - **Resource owner**: the owner of the private repo.
   - **Repository access**: Only select repositories → **sms-gateway**.
   - **Permissions** → Repository permissions:
     | Permission | Access |
     | --- | --- |
     | **Contents** | Read-only (releases + assets live under Contents) |
     | **Metadata** | Read-only (required by GitHub for fine-grained tokens) |
   - Leave all other permissions at **No access**.
4. Generate the token and copy it once. Store it in a password manager; treat it
   like a password.

Do **not** use a classic token with `repo` scope on a shared/org machine if a
fine-grained token is available — Contents/Metadata read on one repo is enough.

## Add the app in Obtainium

1. Install Obtainium from
   [ImranR98/Obtainium releases](https://github.com/ImranR98/Obtainium/releases).
2. Open Obtainium → **Add App** (or equivalent).
3. **Source**: GitHub.
4. **URL**: `https://github.com/sthuck/sms-gateway`
5. When prompted for GitHub authentication, enter:
   - Username: your GitHub username
   - Password / token: the fine-grained token (not your GitHub account password)
6. After Obtainium lists releases, select the latest `v*` release and the
   **prod** APK asset:
   - Name pattern: `sms-gateway-<version>-prod-release.apk`
   - Optional APK filter regex: `prod-release`
7. Enable:
   - Release / update **notifications**
   - **Auto-update** if you want Obtainium to install newer `versionCode`s
     without a manual tap (optional; notifications alone meet the product bar)

Obtainium compares Android `versionCode` (and usually `versionName`) from the
APK. Every tagged release must bump `versionCode` — see
[releasing.md](./releasing.md).

## Rotating or revoking the token

- Rotate before expiry: create a new fine-grained token, update Obtainium’s
  GitHub credentials, revoke the old token.
- If a phone is lost: revoke the token in GitHub immediately.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| “Not found” / empty releases | Token missing, expired, or lacks Contents read on this repo |
| Wrong APK flavour | Filter for `prod-release`; ignore CI `dev` debug artifacts |
| Update not offered | New tag must increase `versionCode`; confirm the Release has an APK asset |
| Install blocked | Allow Obtainium / the installer to install unknown apps |

End-user short version: [install.md](./install.md).
