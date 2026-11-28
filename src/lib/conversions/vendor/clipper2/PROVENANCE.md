# Clipper2 (vendored)

- Port: https://github.com/countertype/clipper2-ts (TypeScript, Jeremy Tribby), npm `clipper2-ts` 2.0.1-19
- Commit: f930d5a5e1d2c45711dc15bd0c5a8ef3125a0b8a (main on 2026-11-06, "Merge pull request #40 from countertype/deps-audit")
- Engine: Clipper2 by Angus Johnson (https://github.com/AngusJohnson/Clipper2, archived; development moved to https://github.com/PolyClipping/Clipper2, release 2.0.1). The port follows the C# implementation of that release.
- Licence: Boost Software License 1.0, Copyright Angus Johnson 2010-2025 (the text is in LICENSE next to this file, the file headers name it)
- Files copied: `src/Core.ts` as `Core.ts`, `src/Engine.ts` as `Engine.ts` and `LICENSE`, byte for byte. The offsetting, Minkowski, rectangle clipping, triangulation and exact-predicate modules of the port, its tests and its benchmark data were left out; `Engine.ts` imports `Core.ts` only.
- Local changes are listed under "Local changes" below, each made in a commit after the copy.

SHA-256 of each file as copied:

```
6d7d792b810b41967107836c6c2caae6fe7ff50248c443c59315c54408d456e6  Core.ts
f60bb69692fbcc8544dec6a7c626751dfd7dd7685ae0b94d6d964fb7dfb9daa5  Engine.ts
ea056d2c64294936b226f7360c265e77c52adc4ba171ee61029357f101f439cf  LICENSE
```

## Local changes

- `Engine.ts` line 15 and `Core.ts` line 691 import `./Core` and not `./Core.js`: the Next.js bundler of the web image does not map a `.js` specifier to a `.ts` file (`experimental.extensionAlias` is off), and the engine is reachable from the conversion modules that the web image bundles. Nothing else changed; `git diff` of the two files against the copy is these two lines.
