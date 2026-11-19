# Ported upstream code

`upstream/` holds unmodified copies of files from **deepseek-ai/deepseek-harness**
(GitHub, branch `master`), package `packages/client/ui-workspace`:

| file | upstream path |
|---|---|
| `WorkspaceBrowser.tsx` | `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` |
| `WorkspaceBrowser.module.css` | `.../rows/WorkspaceBrowser.module.css` |
| `Rows.tsx` | `.../rows/Rows.tsx` |
| `Rows.module.css` | `.../rows/Rows.module.css` |
| `tree.ts` | `.../client/tree.ts` |
| `slots.ts` | `.../client/contract/slots.ts` |

They are kept for reference only (never imported at runtime). Their purpose is to keep the
hand-ported remote workspace block faithful: markup order, class semantics, CSS values and
behaviour are copied from them.

`block.css` is generated from the two `*.module.css` files with every local class renamed
to a `drh-` prefix, because the shipped bundles use build-time hashed names that a plugin
cannot reuse. The CSS custom properties (`--dsw-*`, `--workspace-toolbar-*`) are global, so
the result matches the shipped look.

The upstream project is licensed under the terms in its repository `LICENSE` file; this
port keeps that licence for the derived CSS and any copied markup.
