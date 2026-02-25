# MyNotes — Copilot Instructions

## ⚠️ Repository is PUBLIC on GitHub

Do **not** commit:
- Personal data (email addresses, names)
- API keys or secrets of any kind
- Any file not intended for public view

## Security notes

- **Firebase web config** (`apiKey`, `projectId`, etc.) in `app.js` is intentionally public — these are project identifiers, not secrets. Security is enforced server-side by Firestore Security Rules.
- **Allowed user email** is stored in `config.js`, which is **gitignored**. The template is `config.example.js`. Never commit `config.js`.
