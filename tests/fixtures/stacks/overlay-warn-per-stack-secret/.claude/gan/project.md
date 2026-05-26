---
schemaVersion: 1
web-node:
  buildCmd: "deploy --token=SECRET_TOKEN_abc123XYZ"
---

# Project overlay (secret-bearing per-stack-override fixture)

The per-stack `web-node.buildCmd` override value embeds a recognisable
secret-like token. The PerStackOverrideUnsupported warning must name only the
stack and the field — never the override value — so the token cannot leak into
the persisted snapshot or the startup log.
