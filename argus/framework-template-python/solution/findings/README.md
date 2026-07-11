# solution/findings

This directory contains immutable path-analyst leads (`THE-*`, `PEN-*`, `PIS-*`), not
confirmed or counted defects. A lead records the observed divergence, cited oracle,
reproduction context, and privacy-safe evidence, then routes through Odysseus to the
lane hunter. The hunter independently confirms it and, when warranted, files exactly
one origin bug under `bugs/`; Minos deduplicates the lead and promoted bug as one
canonical defect.

Never mark a lead confirmed here, assign `BUG-NNNN`, or claim it has regression coverage.
The canonical roll-up is Minos's `../BUG-LEDGER.md` and `../bug-ledger.json`.
