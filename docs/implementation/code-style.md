# Code style

The house style, in the order the difference actually shows up. Two reference
files, both already written this way: `src/tasks/states.mjs` for shape,
`src/store/lock.mjs` for comments.

Not a lint rule. Nothing in `tools/check/` enforces this and nothing should —
the moment a rule decides where a comment goes, the comments start coming from
the rule again.

## The tell, in one line

Machine-written code comments **what the line does**, at a constant rate. A
person comments **why the obvious thing is wrong**, in the one place they got it
wrong, and leaves most functions bare.

That is why density is not the metric. `src/store/lock.mjs` is 45 % comments and
reads like a person, because every one of them is an argument. `src/tasks/states.mjs`
was 53 % and read as machine-written, because most of them restated the table
underneath them.

## Rules

1. **Cut any comment that restates the code.** A note above `transition(id, 'cancelling')`
   saying "move the task to cancelling" is furniture.
2. **Keep the ones that record a failure.** "Returned `ERROR_INVALID_HANDLE`,
   which is a job-nesting refusal wearing the wrong code" is worth ten lines. It
   cost someone an afternoon.
3. **JSDoc only where the type checker needs it, or where a caller cannot guess.**
   `@param`/`@returns` on a two-line private helper is JSDoc spent to look
   thorough. On `transitionRequirements`, whose second argument is a shape, it is
   load-bearing — `tsc` reads it and the callers rely on it. The test is
   mechanical: delete it, run `node tools/check/types.mjs`, and keep it if the
   error count moves.
4. **First person for a decision.** "I asked for the lock again after the commit,
   because the commit releases it" beats "the lock is re-acquired after the
   commit". Lain has one author and no reason to pretend otherwise.
5. **No hedging.** "Fail-closed, deliberately: a refusal that queues silently is
   worse than one that says no" — not "this ensures that in the event of a
   failure, the system will not silently queue".
6. **Cut the essay.** A comment shaped like *"the interesting part is…"*, *"and
   this is the point"*, *"which is worth stating"* is prose about the code, not a
   note in it. Say the fact, stop.
7. **Vary the shape.** Some comments are one word, some are a paragraph. One
   tidy paragraph per function is the strongest single tell.
8. **Say it once.** If `docs/implementation/` already states the rule, the code
   points at it instead of repeating it. Two copies drift.
9. **Don't explain one behaviour at three levels.** Header, block and line
   comments all describing the same thing is three chances to disagree.

## What must not be cut

- Why a ceiling is `enforced_by: 'none'`, and the measurement behind it.
- Why a failure is fail-closed rather than retried.
- Any measured fact, with its number.
- The note marking which of two behaviours is deliberate, where the code
  otherwise reads as a bug.

Losing those makes the file shorter and the project worse: they are the part a
reader cannot reconstruct from the code.
