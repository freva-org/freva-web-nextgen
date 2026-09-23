# Hosting

The artifact carries `host-policy.json`. Passing the conformance checks is what
matters; which tool installs the bytes does not.

## The contract

| Requirement                                                            | Why                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mount the artifact root at the pathname of `site.canonicalUrl`         | Every generated URL contains the base path exactly once. The same directory served at `/` is a deployment error, not a relocation mechanism.           |
| Serve directory `index.html` and real deep links, no SPA fallback      | Routes are files. A fallback would hide a missing page and break the auth callback.                                                                    |
| Redirect the non-slash directory form, preserving the query            | `/docs/guide` must reach `/docs/guide/` without losing `?probe=1`.                                                                                     |
| Return the generated `404.html` with status 404                        | A mistyped link should report a missing page, not silently render the home page.                                                                       |
| Point every error status you handle at its generated `<code>.html`     | The artifact ships a document for each; without them a failing request falls back to the origin's own default page, which has no way back to the site. |
| Apply declared MIME types and `nosniff`                                | Sniffing is never the policy.                                                                                                                          |
| Serve downloads as attachments with `nosniff`                          | A download must not become active inline content.                                                                                                      |
| Apply the declared CSP                                                 | Defense in depth, in addition to safe rendering.                                                                                                       |
| `no-store`, `no-referrer` and query-log redaction on the auth callback | The callback URL carries single-use credentials.                                                                                                       |
| Never grant immutable caching to stable, unhashed project asset names  | Only content-hashed names can be immutable.                                                                                                            |

## Status documents

The artifact contains one HTML document per HTTP status it can help with:

`400` `401` `403` `404` `405` `408` `410` `413` `429` `500` `502` `503` `504`

Each is a complete portal page - the header, the footer, the Freva mark, a link
home - written in plain language rather than in the specification's. They are
documents, not redirects, because the status code has to survive: the host
serves the body _at_ the URL that failed.

A host that handles none of them still gets the important one, because `404` is
the fallback every static host already has. Wiring the rest is a line each, and
the difference it makes is on the worst day: a `503` during maintenance shows
the site saying it will be back, instead of a bare page from a proxy the
visitor has never heard of.

## Cache classes

`portal-manifest.json` gives every file a class, so deployment tooling reads the
manifest instead of guessing from filename length:

| Class        | Meaning                                     |
| ------------ | ------------------------------------------- |
| `immutable`  | Content-hashed framework output             |
| `revalidate` | HTML, manifests, stable project asset names |
| `download`   | Passive downloads, served as attachments    |
| `subsite`    | Trusted documentation subsite files         |
| `no-store`   | The auth callback document                  |

## nginx

```nginx
server {
  root /srv/portal;

  # The artifact root is mounted at the canonical base path.
  location /site/ {
    alias /srv/portal/;
    index index.html;
    try_files $uri $uri/index.html =404;   # never a SPA fallback

    # One document per status, served at the URL that failed so the code
    # survives. `internal` keeps them from being browsable as ordinary pages.
    error_page 400 /site/400.html;
    error_page 401 /site/401.html;
    error_page 403 /site/403.html;
    error_page 404 /site/404.html;
    error_page 405 /site/405.html;
    error_page 408 /site/408.html;
    error_page 410 /site/410.html;
    error_page 413 /site/413.html;
    error_page 429 /site/429.html;
    error_page 500 /site/500.html;
    error_page 502 /site/502.html;
    error_page 503 /site/503.html;
    error_page 504 /site/504.html;
  }

  location ~ ^/site/_portal/ {
    alias /srv/portal/_portal/;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location ~ ^/site/downloads/ {
    alias /srv/portal/downloads/;
    add_header Content-Disposition "attachment";
    add_header X-Content-Type-Options "nosniff";
  }

  location = /site/auth/callback/ {
    alias /srv/portal/auth/callback/index.html;
    add_header Cache-Control "no-store";
    add_header Referrer-Policy "no-referrer";
    add_header X-Content-Type-Options "nosniff";
    # The callback query string carries single-use credentials.
    access_log /var/log/nginx/portal.log redacted;
  }
}

# Paired with:
# log_format redacted '$remote_addr - "$request_method $uri" $status';
```

## Object storage and CDNs

Use the platform's native immutable deployment mechanism. Two things need
attention:

- **Directory indexes.** Many object stores do not serve `index.html` for a
  directory URL by default. Enable it; do not substitute a rewrite that returns
  the shell for unknown paths.
- **Redirect preservation.** Confirm that the slash redirect keeps the query
  string, and that `404.html` is returned with status 404 rather than 200.

## Verifying a deployment

```console
freva-portal-builder host-check --dir build/portal --url https://portal.example.org/
```

It checks the root document, deep links, the slash redirect with its query, the
real 404, download headers, the callback's cache and referrer policy, and cache
classes. It reports what the target actually did.

One thing it cannot observe over HTTP is access-log redaction; confirm that in
the host configuration. `preview` approximates routing and headers for local
inspection and proves nothing about a deployment.
