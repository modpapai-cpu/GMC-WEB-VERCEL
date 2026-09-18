# GMC Vercel Deployment

1. Upload this project to GitHub (do not upload `.env` or real API keys).
2. In Vercel: Add New Project -> Import the GitHub repository.
3. Framework Preset: Other. Build Command can be empty; the included `vercel.json` handles routing.
4. Add the environment variables from `.env.example` in Vercel Project Settings -> Environment Variables.
5. Redeploy.

Important:
- `PUBLIC_BASE_URL` must be the final HTTPS Vercel URL.
- For Cashfree, configure the webhook/return URLs in Cashfree to use the Vercel HTTPS domain.
- Keep Firebase, Cashfree, and Mailjet secrets only in Vercel Environment Variables.
- The JSON files in `public/` are only seed data; the app persists data in Firestore.
