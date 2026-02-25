# Notes

A personal notes web app — create, edit, search, and delete notes from any browser.

**Live:** https://ryanbehdad.github.io/my-notes

## Stack

- Vanilla HTML / CSS / JS — no build step
- Firebase Authentication (Google Sign-In)
- Firestore — real-time notes storage
- GitHub Pages — hosting

## Security

Access is restricted to a single Google account. Firestore rules enforce this server-side; the app enforces it client-side. The Firebase web config in `app.js` is safe to commit — it's a project identifier, not a secret.

## Setup

1. Clone the repo
2. Push to `main` — GitHub Pages deploys automatically
3. In Firebase Console:
   - Authentication → Settings → Authorized domains → add `ryanbehdad.github.io`
   - Firestore → Rules → paste the rules from below

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId
        && request.auth.token.email == 'REDACTED';
    }
  }
}
```
