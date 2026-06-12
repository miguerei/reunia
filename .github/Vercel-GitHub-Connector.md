# Vercel + GitHub Connector Setup

## For the Landing Page (preview.html)
1. Push this repo to GitHub (see main README).
2. In Vercel Dashboard:
   - Go to your project (reunia)
   - Settings > Git
   - Connect GitHub repository: select `miguerei/reunia`
   - This will auto-deploy the landing page on every push to main (using vercel.json which serves preview.html).

## For the App (Electron binaries)
- Use the release workflow in .github/workflows/release.yml (triggers on tags).
- Or manually build and upload .dmg to GitHub Releases.

## Current Deploy
- Landing: https://reunia-pied.vercel.app
- To update: push to GitHub after connecting, or run `npx vercel --prod` locally.

