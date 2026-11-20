# fast-formula-parser (vendored)

- Repository: https://github.com/LesterLyu/fast-formula-parser
- Commit: ed38a50f759c1ed918444e94e8b5876e6d1e873b (master on 2026-11-20; 15 commits after the 1.0.19 release, among them the fixes for VLOOKUP and HLOOKUP on a one-row or one-column table and the UPPER function)
- Licence: MIT, Copyright (c) 2019 Dishu(Lester) Lyu (the text is in LICENSE next to this file)
- Files copied: `index.js`, `LICENSE`, `formulas/`, `grammar/` (without `grammar/diagram.js`, a documentation tool that reads the file system) and `ssf/`, byte for byte from the repository at that commit. Tests, examples, logos, the webpack config and the build output were left out.
- Part under another licence: `ssf/ssf.js` is the SheetJS number format code (ssf 0.10.3, Apache-2.0, Copyright 2013-present SheetJS LLC), carried inside the repository.
- Runtime dependencies, from npm: chevrotain (Apache-2.0), jstat (MIT), bessel (Apache-2.0), bahttext (MIT).
- Local changes are listed under "Local changes" below; they were made in the commit after the copy. `index.d.ts` is a type declaration written for EasyConvert. The adapter that bounds ranges, narrows the function set and fills the functions this version does not implement is `../../spreadsheet-formula.ts`.

SHA-256 of each file as copied:

```
7241f4a5c315fd8b5df6a32d54a9e12c7d162eab603253ebcbbea56364c71813  formulas/error.js
2c94c9e9c898151d4171f0b1a3eccb5f7ea73d638507a5e5fb01b934321dac27  formulas/functions/date.js
01bbc9aa995d756d896a10a6a56af3f58070151443c0ca929de8ed574a811f16  formulas/functions/distribution.js
cba829dc4bfc83bfb63c4eb5b0be34e4b4febe0745788fce39cb8b0d1bd9ab5e  formulas/functions/engineering.js
db483b5d2feb54f7d61d5630675a49d4cf03ddc1da5e60deaa9c4a362176a441  formulas/functions/financial.js
937ac99a8c0716a524d643e4dd89b624aeef31cf7908164398b53b76c6b9656d  formulas/functions/information.js
a60c36569f66ed09d41266bd60e35451a6e1b0ffa3450debc592c1734bfb947f  formulas/functions/logical.js
8cd1c49be858430b8c9521a8127a7264e0acc3f96de7ee83c4169c4505e55e16  formulas/functions/math.js
9074c1b76e0b898bf433c6529995102dcfdc123a0909ca0474016a4141f412e7  formulas/functions/reference.js
1c189bf8f90b921e33fd38c2f4f65097a597a41dd33917daf160bfbc9c6cfe3c  formulas/functions/statistical.js
f22b1cd097c6a9010012e9dcdf409d43120a7595f803cf936f071721c6eb8c4c  formulas/functions/text.js
9d51ed6e5e02686cec98649b2ccd3b68afdf82b2cd56d1f3edba549e983e4717  formulas/functions/trigonometry.js
4104db6386b0c386d3569e0b95d5ca3df8c444dfad71e0a69213fe6fdf30b8fc  formulas/functions/web.js
984599a4a953b363d95ed2419b5c8e1656836ee9a4417d7624d6fcd16065caf1  formulas/helpers.js
10bc5561f2b78ac7f5c3959b341963b6063e6dec1c2fbcf6251451afc7b1c8cc  formulas/operators.js
be8bdd3c528d4394097945c06868db25ec2687e5f4f3306e3a2d4644d1d01581  grammar/dependency/hooks.js
7c3c6cc50f8220f9fbbc03153858ac7892322f3318df9b18d7ee3e6b58eaf353  grammar/dependency/utils.js
3d216ccecb6210a5d4f3d9ef8ce3523fcfd622f6188c48f2f20e4f85bd49ef0a  grammar/hooks.js
7e61ee9c584856462be07b454969daf3864ddaabd88890ef31086678f5c8c280  grammar/lexing.js
62803a45fc784accd05c051c7d5f0c5bde73d6269d5176735b19d3cf00c06634  grammar/parsing.js
246f28e7b6ebf954ca766f02966ccd3fb9ac570f1bd9eaa03159fda80302e638  grammar/type/collection.js
6a6593658d7b90505e532696787ad60f1d317636c925920b9a4a91c15d53be43  grammar/utils.js
790cde46fb2c4773878a7b40a140e66cbf553decd8551ad878bde0af77d6855e  index.js
8df18aabde6a402b375655122f6ed4146e92043356cab671cfbdd2f6987f0c32  LICENSE
cc7bceb97cff8f1a96a3bb6e429cad914ab68303ad26e039b501c4c7d6b6da22  ssf/ssf.js
```

## Local changes

The copy above is the upstream code byte for byte. These edits came after it, each found by comparing the adapter's results with LibreOffice (`tests/spreadsheet-formula-oracle.test.ts`). SHA-256 after the edits:

- `formulas/operators.js` be89819bd95b7a1116006231c03481d1730ed07b568bc94fa1647159f5174060
- `formulas/helpers.js` 3fe0f1f2d7e471a4bdf3bea73cb01ee3e454621404575a63b91d098e55b577ad
- `formulas/functions/statistical.js` 9a509eaf5029656eca40781b5441f876d2e54fa1264da18a0257cc3af189de8d
- `formulas/functions/text.js` b2036d4ad9445b23d7fd04351dbfb937ad89ab783f94e60f9364af7dda14ce2c
- `formulas/functions/reference.js` 6edc3f2e0f4452981b7606823904975549abb557a8aa4542f806e8221730cfde
- `formulas/functions/math.js` 3ac07a0b129dd752845c66cf7b491280772d7258740535ce31e72dc280be8213

- `formulas/operators.js`, `compareOp`: text compares without regard to case, as Excel does (`"A"="a"` was FALSE); an empty cell is `""` next to text (`Z99=""` was FALSE).
- `formulas/helpers.js`, `Criteria.parse` and `WildCard.toExactRegex`: a wildcard criterion matches the whole text and ignores case (`"*e"` matched every text with an `e` in it); `"<>"` and `"="` alone mean not empty and empty (they compared with 0).
- `formulas/functions/reference.js`, `VLOOKUP` and `HLOOKUP`: an exact lookup ignores the case of text and a wildcard matches the whole text.
- `formulas/functions/text.js`, `SEARCH`: a search without wildcards ignores case (`SEARCH("L","hello")` was `#VALUE!`).
- `formulas/functions/statistical.js`, `AVERAGE`: no number gives `#DIV/0!`, not `#VALUE!`.
- `formulas/functions/math.js`, `SUMPRODUCT`: the products go into a copy; the original wrote into the arrays it was given, which are the cells a later formula reads (after `SUMPRODUCT(A1:A5,B1:B5)`, `GEOMEAN(A1:A5)` read other numbers).
- `formulas/helpers.js`, `flattenDeep`: one output array instead of a copy of the array for every element. `SUM(A1:A90000)` took 4.2 s and takes 8 ms (every function that reads a range goes through it).
