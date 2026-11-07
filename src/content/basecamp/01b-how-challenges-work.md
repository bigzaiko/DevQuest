---
id: bc-09
title: How Challenges, Tests & Errors Work
level: beginner
minutes: 90
xp: 100
summary: Read a challenge, understand test() and expect(), decode red test messages, stack traces and compile errors, debug with console.log, and type every symbol on German or English keyboards.
---

In **Welcome to DevQuest** you tried each kind of exercise once. This lesson slows down and explains
what is actually happening when you press **Run tests**: what a test is, what the red messages mean,
how to read an error that points at a line number, and how to type the strange symbols code needs —
especially on a German keyboard, where `{`, `[` and the apostrophe hide behind extra keys.

None of this is "DevQuest-only" knowledge. Every company project has tests, every developer reads
error messages all day, and the red text you learn to read here looks almost the same in Vitest,
Jest, Node, the browser console and xUnit.

## Why tests exist at all

Imagine a colleague asks you to write a function that adds VAT to a price. How do you both know it
works? You could *look* at it, but eyes miss things. A **test** is a small piece of code that
**calls your code with a known input and checks that the output is what it should be**. A computer
runs it in milliseconds, every time, without getting tired.

That gives you three things:

- **A definition of "done"** — the task is finished when the tests are green, not when it "looks
  right".
- **Fast feedback** — you learn about a mistake seconds after making it, not when a customer does.
- **A safety net** — change something later, run the tests again, and you know you didn't break the
  old behaviour.

In a DevQuest challenge, the tests are written for you. Your job is to change the code until they
all pass.

## Anatomy of a code challenge

Every code challenge has the same parts:

| Part | What it is | Can you edit it? |
|---|---|---|
| **Prompt** | The text at the top: what to build, with an example. | No — read it twice. |
| **Starter** | Code in the editor that *almost* works or is empty. It fails on purpose. | Yes — this is your work. |
| **Tests** | Hidden code that calls your functions and checks the results. You see each test's **name** and, when it fails, **why**. | No |
| **Hints** | One-at-a-time nudges (💡 **Hint** button). | — |
| **Solution** | A working answer (👁 **Give up?** / **Solution** button). | — |

The tests run **in the same scope** as your code. That means the test can call your function by its
name. If the prompt says "write `greet(name)`", the test literally contains `greet('Ada')` — so if you
rename the function to `hello`, every test fails with `greet is not defined`.

:::tip title="Read the prompt like a contract"
Exact names, exact spelling, exact output. If the prompt says `"Hello, Ada!"`, then `"Hello Ada!"`
(no comma) or `"hello, Ada!"` (small h) is wrong. Tests compare character by character.
:::

:::quiz id=bc-09-q1 xp=10
The prompt says "Write `total(prices)`". You write a working function but call it `sum`. What
happens?
- [ ] The tests pass — the code is correct, the name doesn't matter
- [x] The tests fail, because they call `total(...)` and no function with that name exists
- [ ] The editor renames the function for you
> Tests call your code **by name**. With no `total` defined, each test throws
> `ReferenceError: total is not defined`. Keep the names from the prompt exactly as given — at work,
> other code (and your teammates) depend on those names in the same way.
:::

## test() and expect(): the whole test language in five minutes

The tests use the same style as **Jest** and **Vitest**, the two most common JavaScript test tools.
You only need two words to read them.

### test(name, fn)

`test` registers one check. It takes a **name** (a string that describes the behaviour) and a
**function** (the code to run). The `() => { … }` is an *arrow function* — a short way to write
"here is some code to run later".

```js
test('adds two numbers', () => {
  // the code inside runs when you press "Run tests"
})
```

The name is what you see in the results list next to ✓ or ✖. Good names read like a sentence:
"adds two numbers", "empty cart is 0".

### expect(actual).toBe(expected)

Inside a test, `expect` checks one thing. You put the **actual** value (what your code returned)
inside `expect(…)` and the **expected** value (what it *should* be) inside the **matcher** — the
`.toBe(…)` part.

```js
function add(a, b) {
  return a + b
}

test('adds two numbers', () => {
  expect(add(1, 3)).toBe(4)   // actual: add(1, 3)   expected: 4
})
```

Read it out loud: "expect add of 1 and 3 to be 4". If the two values are the same, nothing happens
and the test is green. If they differ, `expect` **throws an error**, the test stops, and it turns red
with a message.

A test can contain several `expect` lines. It passes only if **all** of them pass.

### The matchers you'll see most

A **matcher** is the method after `expect(…)` that decides what "correct" means.

| Matcher | Passes when | Tiny example |
|---|---|---|
| `toBe(x)` | exactly the same value (numbers, strings, `true`/`false`) | `expect(2 + 2).toBe(4)` |
| `toEqual(x)` | same **contents** — for arrays and objects | `expect([1, 2]).toEqual([1, 2])` |
| `toContain(x)` | an array contains the item / a string contains the text | `expect(['a', 'b']).toContain('b')` |
| `toHaveLength(n)` | `.length` is `n` | `expect('abc').toHaveLength(3)` |
| `toBeTruthy()` | the value counts as true in an `if` | `expect('hi').toBeTruthy()` |
| `toThrow(msg?)` | calling the function throws an error | `expect(() => divide(1, 0)).toThrow('zero')` |
| `.not.…` | the opposite of any matcher | `expect(5).not.toBe(4)` |

### toBe vs toEqual — the classic trap

`toBe` asks "is this **the very same thing**?" For numbers and strings that just means "same value".
But two arrays that *look* the same are two separate things in memory, so `toBe` says no:

```js
expect([1, 2]).toBe([1, 2])     // ✖ expected [1, 2] to be [1, 2]
expect([1, 2]).toEqual([1, 2])  // ✓ same contents
```

Yes, the message "expected [1, 2] to be [1, 2]" looks absurd — that is the hint that you need
`toEqual`. Rule of thumb: **`toBe` for simple values, `toEqual` for arrays and objects.**

### toThrow — testing that something fails

Sometimes the *correct* behaviour is an error, e.g. dividing by zero. To test that, you must wrap the
call in an arrow function, so `expect` can call it *for you* and catch the error:

```js
function divide(a, b) {
  if (b === 0) throw new Error('Cannot divide by zero')
  return a / b
}

expect(() => divide(1, 0)).toThrow('zero')   // ✓ the message contains "zero"
expect(divide(1, 0)).toThrow()               // ✖ the error happens before expect even runs
```

:::quiz id=bc-09-q2 xp=10
In `expect(add(2, 2)).toBe(4)`, which part is the **actual** value?
- [x] `add(2, 2)` — the value your code produced
- [ ] `4` — the number in `toBe`
- [ ] `toBe` — the matcher
> The value inside `expect(…)` is the **actual** result from your code; the value inside the matcher
> is the **expected** one. Remembering this order is what makes failure messages readable:
> "expected *actual* to be *expected*".
:::

:::quiz id=bc-09-q3 xp=10
Which line passes?
- [ ] `expect(['a', 'b']).toBe(['a', 'b'])`
- [x] `expect(['a', 'b']).toEqual(['a', 'b'])`
- [ ] `expect('3').toBe(3)`
> Two separate arrays are never `toBe` each other, even with the same items — use `toEqual` to
> compare contents. `'3'` (a string, in quotes) and `3` (a number) are different types, so `toBe`
> fails there too. Tests are strict about types: a quote mark changes the value.
:::

:::quiz id=bc-09-q4 xp=10
`divide(1, 0)` should throw. Which test is written correctly?
- [ ] `expect(divide(1, 0)).toThrow()`
- [x] `expect(() => divide(1, 0)).toThrow()`
- [ ] `expect(divide).toThrow(1, 0)`
> `toThrow` needs a **function it can call itself**. In the first option, `divide(1, 0)` runs (and
> throws) *before* `expect` gets anything, so the test crashes instead of checking. Wrapping it in
> `() => …` hands `expect` a function to call and catch the error.
:::

## Reading a failing test

A red result has three pieces of information. Learn to read them in this order:

```text
✖ 1/2 tests passing
  ✓ adds small numbers
  ✖ adds two numbers
      expected -2 to be 4
```

1. **The score** — `1/2 tests passing`. You're halfway; something specific is wrong.
2. **The name of the red test** — "adds two numbers". It tells you *which behaviour* broke.
3. **The message** — `expected -2 to be 4`. Read it as "your code returned **-2**, but the test
   wanted **4**".

Now think backwards: what would turn 1 and 3 into -2? `1 - 3`. So the code subtracts instead of
adds. You found the bug without guessing.

Strings in messages are shown **in double quotes** so you can see spaces and empty strings:

```text
expected "Hello Ada!" to be "Hello, Ada!"    ← a missing comma
expected "" to be "Hello, Ada!"              ← the function returned an empty string
expected undefined to be 4                   ← the function returned nothing (forgot "return"?)
```

Each matcher words its message a little differently, but the order is always **your value first**:

```text
expected "milk" to equal ["milk"]               ← toEqual: you returned a string, not an array
expected length 3, got 17 ("milk, eggs, bread")  ← toHaveLength: wanted 3 items, your value has 17
expected [1, 2] to contain 3                     ← toContain: the item is missing
```

:::tip title="undefined almost always means a missing return"
A function without `return` gives back `undefined`. If a message says `expected undefined to be …`,
check that your function actually **returns** the value instead of just computing it or logging it.
:::

:::quiz id=bc-09-q5 xp=10
A test fails with `expected "hello" to be "Hello"`. What should you change?
- [ ] The test — it's too strict
- [x] Your code returns a lowercase "h"; it must return "Hello" with a capital H
- [ ] Nothing — the two strings are equal
> "expected *actual* to be *expected*": your code produced `"hello"`, the test wants `"Hello"`.
> String comparison is case-sensitive, so `h` and `H` are different characters. In challenges, the
> tests are the specification — you change the code, not the test.
:::

## Three kinds of red: assertion, runtime error, compile error

Not every red result is a wrong answer. There are three different situations and they need
different fixes.

| Kind | Looks like | Means |
|---|---|---|
| **Assertion failure** | `expected 7 to be 10` | Your code ran fine, but the result is wrong. Fix the logic. |
| **Runtime error** | `ReferenceError: totl is not defined` or `TypeError: Cannot read properties of undefined (reading 'length')` | Your code crashed while running. |
| **Compile error** | `Compile error: Unterminated string constant (2:10)` | Your code isn't valid JavaScript at all, so **no** test ran. |

### Runtime errors: the name tells you the category

- `ReferenceError: x is not defined` — you used a name that doesn't exist. Usually a typo
  (`totl` instead of `total`) or a variable declared somewhere else.
- `TypeError: Cannot read properties of undefined (reading 'length')` — you wrote `something.length`
  but `something` was `undefined`. Ask: why is it undefined? Wrong property name? Missing return?
- `TypeError: x is not a function` — you called `x()`, but `x` is a number, string or `undefined`.

Where the crash shows up depends on *where* it happens. A crash **inside a test** (e.g. your function
is called by the test and throws) appears under that test's name, and the other tests still run. A
crash **outside any test** (e.g. a `console.log(totl)` at the bottom of your code) stops everything:
you see `✖ Error` and the message, but no test list.

### Compile errors: line and column

Before anything runs, your code is **compiled** — checked and translated into plain JavaScript the
browser can execute. If the code breaks the language's grammar (a missing quote, bracket or comma),
compiling fails and you get a **position** like `(2:10)`: **line 2, column 10**.

```js
function greet() {
  return 'Hello      // ← line 2: the string is never closed
}
```

```text
Compile error: Unterminated string constant (2:10)
```

The editor shows line numbers in the left gutter. Go to that line, look at that column — and also
**the line just before it**, because a missing `)` or `'` is often only noticed one line later.

:::warn title="Fix the first error first"
When there is a compile error, nothing else is meaningful yet: no test ran. Fix the very first
error the message points at, run again, and repeat. Errors further down are often just side-effects
of the first one.
:::

### Stack traces: the path the program took

When a runtime error happens in a real program (Node, the browser console, a server log), you also
get a **stack trace**: the list of functions that were running, newest first.

```text
TypeError: Cannot read properties of undefined (reading 'reduce')
    at total (file:///…/broken.js:2:17)
    at checkout (file:///…/broken.js:6:10)
    at file:///…/broken.js:9:13
```

Read it top-down:

1. **First line** — what went wrong (`TypeError`) and on what (`reading 'reduce'` of `undefined`).
2. **`at total (…broken.js:2:17)`** — where it crashed: function `total`, file `broken.js`, line 2,
   column 17.
3. **The lines below** — who called it: `checkout` on line 6 called `total`, and line 9 called
   `checkout`. The bug is often not where it crashed but in a caller that passed a bad value.

Lines that mention `node:internal`, `react-dom` or `node_modules` are framework code — skip them and
look for **your** file names. You'll practise this in the lab below.

:::quiz id=bc-09-q6 xp=10
You press **Run tests** and see `Compile error: Unexpected token (4:2)` and no test list at all.
What does it mean?
- [ ] Test number 4 failed on assertion 2
- [x] The code is not valid JavaScript — something near line 4, column 2 breaks the syntax, so no test could run
- [ ] The tests themselves are broken
> `(4:2)` is **line:column**. A compile error means the code couldn't even be translated, so zero
> tests executed — that's why there is no list. Look at line 4 *and* the line before it: a missing
> `)`, `}` or quote earlier often only "explodes" on the next line.
:::

:::quiz id=bc-09-q7 xp=10
Which message means "your code ran, it just returned the wrong value"?
- [ ] `ReferenceError: price is not defined`
- [ ] `Compile error: Unexpected token (3:5)`
- [x] `expected 12 to be 10`
- [ ] `TypeError: items.map is not a function`
> Only `expected … to be …` is an **assertion failure**: everything ran and produced a result, just
> the wrong one — so you fix the logic. The `ReferenceError` and `TypeError` are crashes while
> running, and the compile error means nothing ran at all.
:::

## console.log: look inside while it runs

When you don't understand *why* a value is wrong, print it. `console.log(…)` writes any values you
give it to the output. In a DevQuest challenge, everything you log appears in a grey box **under the
test results** after a run.

```js
function cartTotal(items) {
  console.log('items are', items)            // what did the test pass in?
  const sum = items.reduce((s, i) => s + i.price, 0)
  console.log('sum is', sum)                 // what did we compute?
  return sum
}
```

After **Run tests** you might see:

```text
items are [{ price: 2 }, { price: 3 }]
sum is 5
items are []
sum is 0
```

Each test calls your function, so you get one group of logs per call. Comparing "what came in" with
"what I returned" usually makes the bug obvious. Remove the logs when you're done — at work, leftover
`console.log` lines are a classic code-review comment.

:::tip title="Label your logs"
`console.log(sum)` prints a bare `5`. With three logs that's confusing. Always add a label:
`console.log('sum is', sum)`. Pros often use the object shortcut `console.log({ sum, items })`,
which prints the names too.
:::

## How SQL challenges are graded

SQL challenges don't have `test()` blocks. Instead, DevQuest runs **your** query and the hidden
**solution** query on two fresh copies of the same PostgreSQL database, then compares the
**resulting tables**:

1. **Number of columns** must match. Extra or missing columns fail with
   `Expected 2 column(s) (name, stock), got 1 (name).`
2. **Number of rows** must match: `Expected 2 row(s), got 12.` — usually a missing or wrong `WHERE`.
3. **The values** in each row must match. Column *names* don't matter (`AS` aliases are fine), and
   numbers compare by value (`20.00` equals `20`).
4. **Row order** only matters when the task says to sort (then you need the exact `ORDER BY`).
   Otherwise your rows can come back in any order.

When the result is wrong, a **Show expected result** button lets you compare the target table with
yours. Only the **last** statement's result is graded, so you can run helper queries above it.

:::quiz id=bc-09-q8 xp=10
The task: "Return the `name` of every product". You write `SELECT * FROM products;`. Why does it
fail?
- [ ] `SELECT *` is not allowed in PostgreSQL
- [x] It returns all columns (id, name, price, …), but the expected result has only one column
- [ ] The rows are in the wrong order
> `*` means "every column". The grader first compares the **number of columns**, so a one-column
> expected result never matches a six-column answer. Select exactly the columns the task names —
> also a good habit at work, where `SELECT *` sends data nobody asked for.
:::

## Hints, solutions and XP

- **Hints are free.** Opening a hint never costs XP. Use them when you're stuck for more than a few
  minutes — struggling a little helps memory, struggling for an hour doesn't.
- **Your first run counts.** Pass on the first **Run tests** → 100 % XP. A failing run first → 50 %.
  Quizzes work the same way: right on the first click → full XP, after a wrong answer → half.
- **Give up? / Solution** shows a working answer and caps that exercise at 25 % XP. You still need
  to paste or type it and run the tests to collect it. Typing it yourself beats pasting.
- **Drafts are saved.** Whatever you type is stored in your browser, so you can leave and come back.
  **Reset** puts the starter code back (it asks first).
- Each exercise pays out **once**.

:::job title="Tests are your ticket at work"
At most jobs, a pull request can't be merged unless the automated tests (CI) are green. You'll spend
real time reading output exactly like the messages above — in Vitest, Jest, Playwright or xUnit.
The habit "read the name, read the message, think backwards" is the same everywhere.
:::

:::pro title="How seniors debug"
Seniors don't change random things and rerun. They form one **hypothesis** ("the function gets an
empty array"), check it with one log or one breakpoint, and only then change code. They also read
the **whole** error message — most beginners stop at the first word.
:::

## Editor shortcuts

The challenge editor is **CodeMirror**, the same kind of editor many online tools use. On macOS, use
**⌘ Cmd** wherever this table says **Ctrl**.

| Action | Windows / Linux | macOS |
|---|---|---|
| Run the tests / query | `Ctrl + Enter` | `⌘ + Enter` |
| Indent line / selection | `Tab` | `Tab` |
| Un-indent | `Shift + Tab` | `Shift + Tab` |
| Comment / uncomment line(s) | `Ctrl + /` | `⌘ + /` |
| Undo / redo | `Ctrl + Z` / `Ctrl + Y` or `Ctrl + Shift + Z` | `⌘ + Z` / `⌘ + Shift + Z` |
| Select all | `Ctrl + A` | `⌘ + A` |
| Find in the editor | `Ctrl + F` | `⌘ + F` |
| Move line up / down | `Alt + ↑` / `Alt + ↓` | `Option + ↑` / `Option + ↓` |
| Select next same word | `Ctrl + D` | `⌘ + D` |
| Leave the editor with the keyboard | `Esc`, then `Tab` | `Esc`, then `Tab` |
| Jump to any lesson (outside the editor) | `Ctrl + K` | `⌘ + K` |

Because `Tab` indents inside the editor, it doesn't move focus away. Press `Esc` first, then `Tab`
moves to the next button as usual.

:::tip title="Ctrl + / on a German keyboard"
On QWERTZ, `/` is `Shift + 7`, so "comment line" becomes `Ctrl + Shift + 7` (on Mac: `⌘ + Shift + 7`).
The `/` key on the number pad works too: `Ctrl + Num /`.
:::

:::quiz id=bc-09-q9 xp=10
You're in the code editor and want to run the tests without touching the mouse. What do you press?
- [ ] `Enter`
- [ ] `Tab`
- [x] `Ctrl + Enter` (macOS: `⌘ + Enter`)
- [ ] `Ctrl + S`
> Plain `Enter` inserts a new line and `Tab` indents, because you're editing code. `Ctrl/⌘ + Enter`
> is the run shortcut in every code and SQL challenge — the same combination many SQL tools and
> notebooks use to execute.
:::

## Typing code symbols on German and English keyboards

Code is full of symbols that normal writing rarely needs: `{ } [ ] ( ) ' " ` ` \ | ~ @ ; < >`.
On an English (US) keyboard most are printed on the keys. On a German **QWERTZ** keyboard many are
the **third** symbol on a key, reached with **AltGr** (the right Alt key). On Windows, `Ctrl + Alt`
works like AltGr.

### German layout (Windows and Linux)

| Symbol | Name | Keys |
|---|---|---|
| `'` | apostrophe / single quote | `Shift + #` (key next to Enter) |
| `"` | double quote | `Shift + 2` |
| `` ` `` | backtick (template strings) | `Shift + ´`, then `Space` (key next to Backspace) |
| `{` `}` | curly braces | `AltGr + 7` / `AltGr + 0` |
| `[` `]` | square brackets | `AltGr + 8` / `AltGr + 9` |
| `(` `)` | parentheses | `Shift + 8` / `Shift + 9` |
| `\` | backslash | `AltGr + ß` |
| `\|` | pipe | `AltGr + <` (key left of Y) |
| `~` | tilde | `AltGr + +` |
| `@` | at sign | `AltGr + Q` |
| `<` `>` | less / greater than | `<` / `Shift + <` |
| `/` | slash | `Shift + 7` |
| `=` | equals | `Shift + 0` |
| `;` `:` | semicolon / colon | `Shift + ,` / `Shift + .` |
| `$` | dollar (in `${…}`) | `Shift + 4` |
| `&` | ampersand (`&&`) | `Shift + 6` |

### German layout (macOS)

The Mac uses **Option (⌥)** instead of AltGr, and several keys differ:

| Symbol | Keys |
|---|---|
| `{` `}` | `Option + 8` / `Option + 9` |
| `[` `]` | `Option + 5` / `Option + 6` |
| `\|` | `Option + 7` |
| `\` | `Shift + Option + 7` |
| `~` | `Option + N` (then `Space` if nothing appears) |
| `@` | `Option + L` |
| `'` | `Shift + #` |
| `` ` `` | `Shift + ´`, then `Space` |

### English (US) layout

| Symbol | Keys |
|---|---|
| `'` / `"` | the key left of Enter / `Shift` + that key |
| `` ` `` / `~` | the key left of 1 (below Esc) / `Shift` + that key |
| `[` `]` / `{` `}` | the two keys right of P / `Shift` + those keys |
| `\` / `\|` | the key above Enter / `Shift` + that key |
| `@` | `Shift + 2` |
| `<` `>` | `Shift + ,` / `Shift + .` |

### Dead keys and fake quotes

`´`, `` ` `` and `^` on a German keyboard are **dead keys**: they wait for the next key so they can
put an accent on it (`´` + `e` = `é`). To get the symbol alone, press **Space** after it.

The most common beginner mistake: the key next to Backspace types `´` (an accent), **not** an
apostrophe. It looks almost the same, but JavaScript doesn't treat it as a quote — your string never
closes and you get a compile error. Word processors and chat apps do something similar: they turn
`"` into “curly quotes” or „German quotes”, and code copied from such places breaks.

:::info title="The DevQuest editor fixes look-alike quotes for you"
When you type or paste `´ ’ ‘ “ ” „` in a challenge editor, it is automatically converted into the
real `'` and `"`. Your code editor at work (VS Code, Rider) does **not** do that — there, learn
`Shift + #` for `'`, and check pasted code for curly quotes when you get a strange syntax error.
:::

:::warn title="Many developers switch layouts"
Typing `{` with `AltGr + 7` hundreds of times a day is tiring. Many German developers use an English
(US) layout for coding, or the "EurKEY" layout, and switch with `Win + Space` (Windows) or
`Ctrl + Space` (macOS). Try it if you like — but practise one layout until it's muscle memory.
:::

:::warn title="Can't find a symbol? Ask your operating system"
Keyboards differ slightly (laptop vs. desktop, Linux "nodeadkeys" variants, Swiss or Austrian
layouts), so a table can't be 100 % right for every machine. Your OS can show you the truth:
**Windows** — the *On-Screen Keyboard* (`Win + Ctrl + O`), then hold AltGr to see the third symbols;
**macOS** — enable *Show Input menu in menu bar* in **System Settings → Keyboard → Input Sources**,
then pick *Show Keyboard Viewer* and hold Option; **Linux (GNOME)** — **Settings → Keyboard**, click
the layout, then *View Keyboard Layout*.
:::

:::quiz id=bc-09-q10 xp=10
On a German Windows keyboard, how do you type `{`?
- [ ] `Shift + 7`
- [x] `AltGr + 7`
- [ ] `Shift + 8`
- [ ] `Alt + {`
> `Shift + 7` gives `/` and `Shift + 8` gives `(`. The curly braces are the **third** symbol on the
> 7 and 0 keys, reached with **AltGr** (right Alt, or `Ctrl + Alt`). On a German Mac it's
> `Option + 8` instead.
:::

:::quiz id=bc-09-q11 xp=10
On a German keyboard, which key gives a real apostrophe `'` for a JavaScript string?
- [ ] The key next to Backspace (`´`)
- [x] `Shift + #`
- [ ] `AltGr + Q`
> The key next to Backspace is the accent `´`, a dead key that JavaScript does not accept as a
> quote (the DevQuest editor converts it, other editors won't). `AltGr + Q` is `@`. The real
> apostrophe is `Shift + #`, the key just left of Enter.
:::

## Your turn: three tiny challenges

### Fix the quotes

A string in JavaScript is text between matching quotes: `'single'`, `"double"`, or `` `backtick` ``.
The opening and closing quote must be the **same kind**. And if the text itself contains an
apostrophe (`It's`), wrap it in the *other* kind of quote, so the apostrophe isn't mistaken for the
end of the string:

```js
'It's'    // ✖ the string ends after "It", then s' is garbage
"It's"    // ✓
```

:::challenge id=bc-09-c1 lang=js xp=15
title: Fix the broken strings
The starter doesn't even compile — the quotes are wrong. Fix them so that `motto()` returns the
text `It's working!` and `shop()` returns the text `Coffee & Code`. Press **Run tests** first to see
what a compile error looks like: something like `Unexpected token, expected ";"`. The string
`'It'` ended early, and JavaScript has no idea what the leftover `s working!'` is supposed to be.

hint: In `motto`, the apostrophe in "It's" ends the single-quoted string. Use double quotes around the whole text.
hint: In `shop`, the string starts with `"` but ends with `'`. Both ends need the same quote.

```js starter
function motto() {
  return 'It's working!'
}

function shop() {
  return "Coffee & Code'
}
```

```js solution
function motto() {
  return "It's working!"
}

function shop() {
  return "Coffee & Code"
}
```

```js tests
test('motto returns the text with an apostrophe', () => {
  expect(motto()).toBe("It's working!")
})
test('shop returns the shop name', () => {
  expect(shop()).toBe('Coffee & Code')
})
```
:::

### Make the red test green

One green test doesn't prove the code is right. Here `double(2)` happens to give the right answer —
read the **message** of the failing test to see what's really going on.

:::challenge id=bc-09-c2 lang=js xp=15
title: Make the failing expect pass
`double(n)` should return `n` times two: `double(2)` is `4`, `double(5)` is `10`. Run the tests
first: one is green, one is red. Read the red message, figure out what the code does wrong, and fix
the function (not the tests).

hint: The message says `expected 7 to be 10`. Which calculation turns 5 into 7?
hint: Multiplication in JavaScript is `*`: `return n * 2`

```js starter
function double(n) {
  return n + 2
}
```

```js solution
function double(n) {
  return n * 2
}
```

```js tests
test('double(2) is 4', () => {
  expect(double(2)).toBe(4)
})
test('double(5) is 10', () => {
  expect(double(5)).toBe(10)
})
test('double(0) is 0', () => {
  expect(double(0)).toBe(0)
})
```
:::

### Return an array

An **array** is an ordered list of values in square brackets: `['milk', 'eggs']`. It is a different
thing from a string that happens to contain commas, `'milk, eggs'`. Tests for arrays use `toEqual`
(same contents) and `toHaveLength` (number of items).

:::challenge id=bc-09-c3 lang=js xp=15
title: A real shopping list
`shoppingList()` should return an **array** with three strings, in this order: `milk`, `eggs`,
`bread`. Right now it returns one string. Try adding `console.log(shoppingList())` at the bottom of
your code and look at the log box under the results. (Don't be surprised that `contains eggs` is
already green on the starter: `toContain` also works on strings, and the text `'milk, eggs, bread'`
does contain `eggs`. The other three tests need a real array.)

hint: Square brackets make an array: `[ … ]`. On a German keyboard: `AltGr + 8` and `AltGr + 9` (Mac: `Option + 5` / `Option + 6`).
hint: Each item is its own string, separated by commas: `['milk', 'eggs', 'bread']`

```js starter
function shoppingList() {
  return 'milk, eggs, bread'
}
```

```js solution
function shoppingList() {
  return ['milk', 'eggs', 'bread']
}
```

```js tests
test('returns an array', () => {
  expect(Array.isArray(shoppingList())).toBe(true)
})
test('has three items', () => {
  expect(shoppingList()).toHaveLength(3)
})
test('has the right items in order', () => {
  expect(shoppingList()).toEqual(['milk', 'eggs', 'bread'])
})
test('contains eggs', () => {
  expect(shoppingList()).toContain('eggs')
})
```
:::

### A SQL mini challenge

:::sql id=bc-09-sql1 db=shop xp=15
title: What's out of stock?
The shop's `products` table has a `stock` column (how many are in the warehouse). Return the `name`
**and** the `stock` of every product that is out of stock (`stock` is 0). Run the starter first and
read the message: it has the right rows, but not the right columns.

hint: List both columns, separated by a comma: `SELECT name, stock FROM …`
hint: Keep the filter: `WHERE stock = 0`

```sql starter
SELECT name FROM products WHERE stock = 0;
```

```sql solution
SELECT name, stock FROM products WHERE stock = 0;
```
:::

:::quiz id=bc-09-q12 xp=10
In the SQL challenge, the starter fails with `Expected 2 column(s) (name, stock), got 1 (name).`
Would `SELECT stock, name …` (columns swapped) pass?
- [ ] Yes — only the column names are compared, not their order
- [x] No — rows are compared value by value, in column order, so a row `(0, 'The Pragmatic Programmer')` does not match `('The Pragmatic Programmer', 0)`
- [ ] Yes — the grader ignores columns entirely
> The grader ignores column **names** (aliases are fine) but compares each row's **values in
> position**. Swapping the columns changes every row. Row *order* is ignored here because the task
> didn't ask for sorting — but column order always matters.
:::

## Lab: read real test output and a real stack trace

:::lab id=bc-09-lab1 xp=25
title: Your first local test run with Node
The in-browser runner imitates real tools. Here you use the real thing: Node's built-in test
runner, which needs nothing installed except Node 22 or newer (see **Your Dev Environment**).

**1. Create a folder** (bash/zsh on macOS/Linux, or PowerShell on Windows — the commands are the
same):

```bash
mkdir test-playground
cd test-playground
node --version
```

Expected: `v22.x` or higher (`v24…`, `v26…` are fine).

**2. Create three files** in that folder with your editor.

`package.json` — tells Node to use modern `import` syntax:

```json
{ "type": "module" }
```

`math.js` — the code, with a bug on purpose:

```js
export function add(a, b) {
  return a - b
}
```

`math.test.js` — the tests (`assert.equal` is Node's version of `expect(…).toBe(…)`):

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add } from './math.js'

test('adds two numbers', () => {
  assert.equal(add(1, 3), 4)
})

test('adding zero changes nothing', () => {
  assert.equal(add(7, 0), 7)
})
```

**3. Run the tests:**

```bash
node --test
```

Expected output (times and paths will differ):

```text
✖ adds two numbers (0.6ms)
✔ adding zero changes nothing (0.1ms)
ℹ tests 2
ℹ pass 1
ℹ fail 1
…
✖ failing tests:

test at math.test.js:5:1
✖ adds two numbers (0.6ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -2 !== 4

      at TestContext.<anonymous> (file:///…/test-playground/math.test.js:6:10)
      at Test.runInAsyncScope (node:async_hooks:…)
      …
```

:::warn title="Your output may look slightly different"
This was checked with Node 26. Other Node versions add or drop summary lines (`ℹ suites 0`,
`ℹ duration_ms …`) and print a few more `node:internal` lines — the name, the `-2 !== 4` message and
the `math.test.js:6:10` location are what matter. Reference: https://nodejs.org/api/test.html
:::

Read it like in the browser: the red test's **name**, the **message** (`-2 !== 4` = actual `-2`,
expected `4`), and the **location** `math.test.js:6:10` (line 6 is the `assert.equal` line). Note
that "adding zero" passes even though the code is wrong — `7 - 0` and `7 + 0` are both 7.

**4. Fix** `math.js` (`return a + b`) and run `node --test` again. Expected: `ℹ pass 2` and
`ℹ fail 0`.

**5. Read a stack trace.** Create `broken.js`:

```js
function total(prices) {
  return prices.reduce((sum, p) => sum + p, 0)
}

function checkout(cart) {
  return total(cart.prices)
}

console.log(checkout({ items: [3, 4] }))
```

Run it:

```bash
node broken.js
```

Expected output (start). Node first prints the line that crashed with a `^` under the exact spot,
then the error and the stack trace:

```text
file:///…/test-playground/broken.js:2
  return prices.reduce((sum, p) => sum + p, 0)
                ^

TypeError: Cannot read properties of undefined (reading 'reduce')
    at total (file:///…/broken.js:2:17)
    at checkout (file:///…/broken.js:6:10)
    at file:///…/broken.js:9:13
```

It crashes in `total` (line 2), but the real bug is the caller on line 6: the cart has `items`, not
`prices`. Change line 6 to `return total(cart.items)` and run again. Expected output: `7`.

:::tip
Delete the folder afterwards if you like (`cd ..` then `rm -r test-playground`, or
`Remove-Item -Recurse test-playground` in PowerShell).
:::

- [ ] `node --test` showed 1 failing and 1 passing test, and I can say what `-2 !== 4` means
- [ ] After fixing `add`, `node --test` reports `pass 2` and `fail 0`
- [ ] I read the stack trace of `broken.js`, found the bad line (6), fixed it and saw `7`
:::

## Flashcards

:::cards id=bc-09-cards1 xp=10 title="Tests & errors basics"
Q: What does `test(name, fn)` do?
A: Registers one named check. `fn` runs when the tests run; the test is green if nothing inside throws.
Q: How do you read `expected 7 to be 10`?
A: Your code produced 7 (actual), the test wanted 10 (expected).
Q: `toBe` or `toEqual` for arrays and objects?
A: `toEqual` — it compares contents. `toBe` checks it's the very same value/object.
Q: How do you test that a function throws?
A: Wrap the call in an arrow function: `expect(() => divide(1, 0)).toThrow()`.
Q: What does `(4:2)` in a compile error mean?
A: Line 4, column 2. Check that line and the one before it — no tests ran.
Q: `expected undefined to be …` usually means?
A: The function has no `return` (or returns too early).
Q: How do you read a stack trace?
A: Top line = what went wrong; first `at` line = where it crashed; lines below = who called it. Look for your own file names.
Q: How are SQL challenges graded?
A: Your last result vs. the solution's: same column count, row count and values; column names ignored; row order only if the task asks for sorting.
Q: German keyboard: `{ }`, `[ ]`, `'`?
A: `AltGr + 7/0`, `AltGr + 8/9`, `Shift + #`. (Mac: `Option + 8/9`, `Option + 5/6`, `Shift + #`.)
Q: Run the tests from the editor?
A: `Ctrl + Enter` (macOS `⌘ + Enter`).
:::

## Recap

- A **test** calls your code with a known input and checks the output; `expect(actual).toBe(expected)`
  throws when they differ.
- `toBe` for simple values, `toEqual` for arrays/objects, `toThrow` needs `() => …` around the call.
- Read red results in order: score → test name → message (`expected actual to be expected`).
- Three kinds of red: **assertion** (wrong value), **runtime error** (crash, read the error name),
  **compile error** (invalid code, `(line:column)`, no tests ran).
- Stack traces: top line = what, first `at` = where, lines below = who called it.
- `console.log('label', value)` output appears under the test results.
- SQL is graded by comparing result tables: columns, rows, values; order only when asked.
- Hints are free; first-run success = full XP, after a miss 50 %, after the solution 25 %.
- `Ctrl/⌘ + Enter` runs; on German keyboards `{}` = `AltGr + 7/0`, `[]` = `AltGr + 8/9`, `'` = `Shift + #`.
