# Reference implementations (test oracles only)

`OneEuroFilter.ts` is the One Euro filter reference implementation by Alix
Giguey and Géry Casiez (Copyright 2019 Inria, BSD-3-Clause; license header
preserved in the file), downloaded unmodified from
https://github.com/casiez/OneEuroFilter/blob/main/typescript/src/OneEuroFilter.ts
on 2026-11-14. `tests/unit/one-euro.test.ts` checks `src/signal/one-euro.ts`
against it. It is never bundled into the app.
