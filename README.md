# Ar/Ur/En → Bangla Translator

A browser-based PDF translator (Arabic/Urdu/English → Bangla) built with React.
It runs entirely client-side: PDF parsing (PDF.js), sanitization (DOMPurify),
and styling (Tailwind CDN) are loaded from CDNs at runtime, and translation is
done by calling the Gemini API directly from the browser using an API key you
enter in the app's Settings panel (stored only in your own browser).

## Run locally

```bash
npm install
npm run dev
```

## Build for production

```bash
npm run build
npm run preview   # optional: preview the production build locally
```

## Deploy to GitHub Pages

This repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`)
that automatically builds and publishes the site whenever you push to `main`.

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Push to `main` (or go to the **Actions** tab and run the workflow manually).
5. Your site will be live at `https://<your-username>.github.io/<repo-name>/`.

No further configuration is needed — `vite.config.js` uses a relative base
path so it works under any repository name.

## Notes

- You'll need a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
  to use translation — enter it in the app's Settings panel after it loads.
- The API key is stored in your browser (sessionStorage by default, or
  localStorage if you check "remember"), never sent anywhere except directly
  to Google's API.
