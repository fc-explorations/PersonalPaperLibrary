# Cloudflare operations follow-up

- [ ] Confirm the deployed D1/R2 library and create a hosted backup before considering the local runtime retired.
- [ ] Create a Cloudflare Access service token for Omarchy and add a Service Auth policy to the protected application.
- [ ] Set `OMARCHY_ACCESS_CLIENT_ID` as a Worker Secret in production and preview; keep the service token client secret in the Omarchy user's secret store.
- [ ] Deploy to preview and verify unauthenticated denial, service-token read access, owner access, and service-token denial on write routes and hosted pages.
- [ ] Verify the integration list filters, pagination, tags, PDF streaming, and R2-missing error path against preview.
- [ ] After preview succeeds, deploy the Worker and repeat the authenticated smoke checks against production.
