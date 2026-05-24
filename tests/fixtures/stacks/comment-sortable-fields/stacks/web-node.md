---
name: web-node
schemaVersion: 1
detection:
  - anyOf:
      - package.json
      - tsconfig.json
scope:
  - "**/*.ts"
  - "**/*.tsx"
commentSyntax:
  line: "//"
  block:
    open: "/*"
    close: "*/"
sortableLists:
  - pathGlob: "**/*.ts"
    lineRangePattern: "^import "
---

# web-node conventions (commentSyntax + sortableLists fixture)

A stack fixture that declares the two optional fields (`commentSyntax` and
`sortableLists`) so the loader/validation round-trip can be asserted. The marker
values are deliberately concrete (a line `//`, a `/* */` block, and an import
block as the sortable region) but they are fixture data, not framework defaults.
