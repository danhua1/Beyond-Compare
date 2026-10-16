# aisale.best API Key Automation

Creates a `test` API key in the `GPT 标准` group when one does not already exist, then writes the account JSON to `aisale-account.json`.

## Setup

```sh
npm install
```

## Run

```sh
AISALE_EMAIL='your-email@example.com' \
AISALE_PASSWORD='your-password' \
npm run create-key
```

The first run opens Chrome so the site can complete any browser verification. The persistent session is stored in `.aisale-profile/`, and the generated JSON is stored with owner-only permissions. Both paths are ignored by Git.

Optional environment variables:

- `AISALE_KEY_NAME`: defaults to `test`
- `AISALE_GROUP`: defaults to `GPT 标准`
- `AISALE_OUTPUT`: defaults to `aisale-account.json`
- `HEADLESS=true`: run without a visible browser after the session has been established
- `CHROME_PATH`: override the default macOS Google Chrome executable path
