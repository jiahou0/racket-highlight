# Project instructions

- Keep this extension focused on small Racket programs and everyday editing; avoid features or architecture aimed at large engineering projects.
- After completing changes, generate a VSIX with `node scripts/build.mjs --package` and install it into the VS Code `Scheme/Racket` profile with `code --profile 'Scheme/Racket' --install-extension <absolute-vsix-path> --force`.
- Packaging and installation are authorized. Do not add, modify, or run tests unless the user explicitly requests them; testing and acceptance remain the user's responsibility.
