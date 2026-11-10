# License Compliance Notes

## Project License: MIT

## Third-Party Dependencies

All direct and transitive dependencies use licenses compatible with MIT:
- MIT / ISC / 0BSD / (MIT OR CC0): 579 packages
- Apache-2.0: 46 packages
- BSD-2-Clause / BSD-3-Clause: 31 packages
- MPL-2.0: 4 packages (compatible with MIT)
- Python-2.0 / CC-BY-4.0 / BlueOak: 3 packages

## LGPL-3.0-or-later Note

Two transitive dependencies (`@img/sharp-libvips-linux-x64`, `@img/sharp-libvips-linuxmusl-x64`) are licensed under LGPL-3.0-or-later. These are native binaries for `sharp` (image processing), pulled in by Next.js's built-in image optimizer.

**Status:** Next.js image optimization is **enabled** (default). The LGPL-licensed `sharp` binaries are dynamically loaded at runtime for image transformation.

**Compliance position:** This is the standard usage pattern for MIT-licensed Next.js projects. The LGPL's requirement for "user ability to replace the library" is satisfied because:

1. The application runs on a server controlled by the deployer (Vercel, self-hosted, etc.)
2. The deployer controls the runtime environment and can replace `sharp` if needed
3. Next.js itself is MIT-licensed and explicitly permits this usage

For stricter enterprise policies requiring LGPL avoidance, see the alternative configuration in `docs/self-hosting.md`.

## Generating Full License Report

```bash
# CSV (for compliance tools)
bunx license-checker --csv > LICENSES.csv

# Markdown (for documentation)
bunx license-checker --markdown > LICENSES.md

# Summary
bunx license-checker --summary
```

## MPL-2.0 Dependencies (Compatible)

| Package | Purpose |
|---------|---------|
| `axe-core` | Accessibility testing (Playwright) |
| `lightningcss` | CSS parser (Tailwind CSS v4) |

MPL-2.0 is compatible with MIT. Only requirement: if you modify MPL-licensed source files, you must share modifications under MPL. This project does not modify these dependencies.