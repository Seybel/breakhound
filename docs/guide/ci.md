# CI

On GitHub Actions, after installing your dependencies:

```yaml
- uses: Seybel/breakhound@v1
  with:
    fail-on: error
    # url: ${{ steps.deploy.outputs.preview-url }}   # or scan a preview deployment
```

It starts your dev server (or scans `url`), turns each issue into an annotation, adds the summary to the job page, and uploads the report as an artifact.

Anywhere else, `npx @seybel/breakhound install --with-deps && npx @seybel/breakhound` does the same job; `CI=true` keeps it from opening windows or asking questions.
