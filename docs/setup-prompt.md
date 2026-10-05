Help me self-host imgt on my Cloudflare account and integrate it into my project.

Read https://github.com/fashn-AI/imgt and its deployment, configuration and
Next.js guides before making changes. Inspect my project and preserve its
existing configuration. Ask for missing information: my target Cloudflare
account, my own imgt deployment URL and the public HTTPS image sources I use.

1. Set up my own imgt deployment through Cloudflare's GitHub integration.
   Production branch pushes should deploy automatically. Use Wrangler to
   inspect the intended account; do not manually deploy or assume the account
   open in a browser is the correct one.
2. Set ALLOWED_HOSTS to the hosts serving my original images. Include
   images.unsplash.com if I want the playground. Wildcards such as *.example.com
   do not include the parent example.com. Validate redirect hosts too. Follow
   the deployment guide's GitHub rebuild step after dashboard variable updates.
3. Keep the imgt R2 bucket private, bound as DERIVATIVES, using Standard storage.
   Complete storage setup with an enabled lifecycle rule that deletes objects
   under derivatives/ after 30 days. Deployment does not add this rule.
4. If my app uses Next.js, adapt the TypeScript custom image loader to my
   existing configuration. Use my own imgt URL, configure the qualities my
   components use and preserve image dimensions and responsive sizes.
   Otherwise, use the /image API from my project with my own endpoint.
5. Replace every endpoint placeholder with my deployment URL. The FASHN AI
   website is a demonstration, not a shared optimization service for my app.
6. Run the repository checks and test the deployed image pipeline using
   npm run smoke -- MY_IMGT_ENDPOINT MY_PUBLIC_IMAGE_URL. Verify decoded WebP
   output, repeat cache hits and conditional 304 responses. Do not treat
   /health alone as an end-to-end check. Only use --fresh with source URLs that
   accept additional query parameters.

Keep the implementation small, explain the changes and call out any setup
steps I still need to complete in Cloudflare.
