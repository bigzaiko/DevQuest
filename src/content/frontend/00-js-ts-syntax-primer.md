---
id: fe-31
title: JavaScript & TypeScript Syntax Primer
level: beginner
minutes: 105
xp: 100
summary: The grammar of JavaScript and TypeScript from zero — variables, types, strings, operators, conditions, loops, functions, arrays, objects, type annotations and modules — with a tiny example for every piece.
---

Every React component, every API call and every test you will write in this academy is written in
**JavaScript** (JS) or **TypeScript** (TS). Before you can learn what React does, you need to be able
to *read* the code fluently — the same way you need the alphabet before you read a novel.

This lesson is the alphabet. It assumes **no** previous programming. Every concept gets three things:
*why it exists*, *what the syntax looks like*, and *a tiny example you can run*. The next lesson,
**Modern JavaScript Refresher**, then builds on this with destructuring, spread, optional chaining and
the array methods React code uses everywhere.

:::tip title="Where to run the examples"
Open your browser's developer tools (`F12`, or `Ctrl+Shift+J` / `⌘+⌥+J`), click the **Console**
tab, paste an example and press `Enter`. `console.log(x)` prints `x` there. You can also use this
site's **Playground** page. The comments starting `// →` show what gets printed.

If the console answers `SyntaxError: Identifier 'add' has already been declared`, an earlier example
already created that name. Reload the page (which clears everything) and paste again.
:::

## Two languages, one family

- **JavaScript** is the language browsers understand. It was created in 1995 to make web pages
  interactive and today also runs on servers (Node.js) and in tools (Vite).
- **TypeScript** is JavaScript **plus type annotations** — little labels such as `: string` that say
  what kind of value a variable holds. A tool (the TypeScript compiler, or Vite) checks the labels
  *before* the code runs and then **removes them**, leaving plain JavaScript for the browser.

So every JavaScript program is (almost) valid TypeScript. Learn JS syntax first; TS adds a layer on
top that you'll learn to read at the end of this lesson.

## Statements, semicolons and comments

A **statement** is one instruction — "create this variable", "print that". Programs are lists of
statements run top to bottom. Statements traditionally end with a semicolon `;`.

```js
console.log('first');
console.log('second')   // also fine: the semicolon is optional here
```

**Why are semicolons optional?** JavaScript has *Automatic Semicolon Insertion* (ASI): when a line
ends and the next line can't continue it, the engine inserts the `;` for you. Many teams write
semicolons everywhere; many (including this site's code) leave them out. Both are fine — a formatter
such as **Prettier** (a tool that rewrites your code into one consistent layout) enforces one style
automatically, so you never argue about it.

:::warn title="The one semicolon trap"
If you leave semicolons out, never start a line with `(` or `[`. JavaScript then joins it to the
line above: `const a = 1` followed by `[1, 2].forEach(…)` on the next line is read as
`const a = 1[1, 2].forEach(…)` and crashes. Prettier adds a protective `;` for you in that case.
:::

**Comments** are notes for humans; the engine ignores them.

```js
// A single-line comment runs to the end of the line.

/* A block comment
   can span several lines. */

/** A "JSDoc" comment documents the thing below it — editors show it on hover. */
```

:::quiz id=fe-31-q1 xp=10
What does this print?

```js
// console.log('A')
console.log('B') /* console.log('C') */
```

- [ ] `A` then `B`
- [x] Only `B`
- [ ] `B` then `C`
- [ ] Nothing — it's a syntax error
> `//` turns the rest of the first line into a comment, and `/* … */` turns everything between the
> markers into a comment. Only `console.log('B')` is real code. "Commenting out" a line like this is
> how developers temporarily disable code without deleting it.
:::

## Variables: `let` and `const`

A **variable** is a named box that holds a **value**. You need them so you can compute something once
and use it later by name.

```js
const name = 'Ada'   // a box called "name" holding the text 'Ada'
let score = 0        // a box called "score" holding the number 0
score = score + 10   // put a new value in the box
console.log(name, score)   // → Ada 10
```

- `const` = the variable can't be **reassigned** (you can't point it at another value later).
- `let` = it can be reassigned.
- `=` means **assign** ("put the right side into the left side"), *not* "is equal to".
- `var` is the old (pre-2015) keyword with confusing scoping rules. You'll see it in old code; don't
  write it.

**Default to `const`.** When a reader sees `const`, they know the value never changes, which makes
code easier to follow. Use `let` only when you really reassign (counters, running totals).

Names (called **identifiers**) may contain letters, digits, `_` and `$`, can't start with a digit, and
are **case-sensitive** (`score` and `Score` are different). The convention is **camelCase**:
`firstName`, `totalPrice`, `isLoggedIn`.

:::quiz id=fe-31-q2 xp=10
Which line causes an error?

```js
const a = 1
let b = 2
b = 3
a = 4
```

- [ ] `let b = 2`
- [ ] `b = 3`
- [x] `a = 4`
- [ ] None of them
> `a` is a `const`, so assigning a new value throws **TypeError: Assignment to constant variable.**
> `b` is a `let`, so `b = 3` is allowed. Note that `const` only stops *reassignment* — if a `const`
> holds an object, you can still change properties inside it (more on that below).
:::

## Primitive types: the basic kinds of values

Every value has a **type** — what kind of thing it is. JavaScript has a handful of **primitive**
(simple, built-in) types:

| Type | Examples | Used for |
|---|---|---|
| `string` | `'hello'`, `"Ada"`, `` `Hi ${name}` `` | Text |
| `number` | `42`, `3.14`, `-7`, `NaN` | All numbers (no separate int/float) |
| `boolean` | `true`, `false` | Yes/no answers |
| `undefined` | `undefined` | "No value was ever given" |
| `null` | `null` | "Deliberately empty" |
| `bigint` | `9007199254740993n` | Huge whole numbers (rare) |
| `symbol` | `Symbol('id')` | Unique keys (rare) |

Everything else — arrays, objects, functions — is an **object**. The `typeof` operator tells you the
type at runtime:

```js
console.log(typeof 'hi')    // → string
console.log(typeof 42)      // → number
console.log(typeof true)    // → boolean
console.log(typeof [1, 2])  // → object   (arrays are objects)
console.log(typeof null)    // → object   (a famous bug from 1995, kept forever)
```

## Strings: three kinds of quotes

A **string** is a piece of text. JavaScript lets you write one with **single quotes**, **double
quotes** or **backticks**. Why three?

```js
const a = 'single'
const b = "double"
const c = `backtick`
```

- **Single and double quotes are identical.** Two exist so you can put one kind *inside* the other
  without trouble: `"It's fine"`, `'She said "hi"'`. Otherwise you escape it with a backslash:
  `'It\'s fine'`.
- **Backticks** create a **template literal**, which can do two extra things:
  1. **Interpolation** — insert any expression with `${…}`.
  2. **Multiple lines** — line breaks are kept as written.

```js
const name = 'Ada'
const items = 3
console.log(`Hi ${name}, you have ${items * 2} points`)   // → Hi Ada, you have 6 points

const html = `<ul>
  <li>one</li>
</ul>`   // keeps the line breaks
```

Before template literals (2015) you had to glue strings with `+`: `'Hi ' + name + '!'`. That still
works, but the template version is easier to read and harder to get wrong (missing spaces!).

A few things strings can do (called **methods** — functions attached to a value, called with a dot):

```js
const s = 'DevQuest'
console.log(s.length)          // → 8   (a property, no parentheses)
console.log(s.toUpperCase())   // → DEVQUEST
console.log(s.includes('Quest')) // → true
console.log(s[0])              // → D   (positions start at 0)
console.log('  hi  '.trim())   // → hi
```

:::quiz id=fe-31-q3 xp=10
`const n = 2`. Which line prints `Total: 4`?
- [ ] `console.log('Total: ${n * 2}')`
- [ ] `console.log("Total: ${n * 2}")`
- [x] ``console.log(`Total: ${n * 2}`)``
- [ ] `console.log(Total: n * 2)`
> Only **backticks** make a template literal where `${…}` is evaluated. Inside single or double
> quotes, `${n * 2}` is just ordinary characters, so you'd print `Total: ${n * 2}` literally. The last
> option isn't valid syntax at all — text must be inside quotes.
:::

## Numbers and operators

JavaScript has one `number` type for both whole numbers and decimals. **Operators** are the symbols
that combine values:

```js
console.log(7 + 2)    // → 9   addition
console.log(7 - 2)    // → 5   subtraction
console.log(7 * 2)    // → 14  multiplication
console.log(7 / 2)    // → 3.5 division (gives decimals; there is no separate whole-number division)
console.log(7 % 2)    // → 1   remainder ("modulo"): is it even? n % 2 === 0
console.log(2 ** 3)   // → 8   power

let count = 5
count += 2            // shorthand for count = count + 2  → 7
count++               // add one → 8
```

Two surprises worth knowing on day one:

```js
console.log(0.1 + 0.2)   // → 0.30000000000000004 (binary decimals aren't exact — never store money as floats; use cents)
console.log('5' + 1)     // → 51    (a string! + with a string glues text: '5' + '1')
console.log('5' - 1)     // → 4     (- converts the string to a number)
console.log(Number('42'))  // → 42  convert explicitly instead
console.log(Number('abc')) // → NaN "Not a Number" — the result of failed maths
```

Why does `'5' + 1` glue but `'5' - 1` subtract? `+` has two jobs (adding numbers *and* joining
strings), and as soon as one side is a string, joining wins. `-` only means subtraction, so
JavaScript turns `'5'` into the number 5. Values typed into a form field always arrive as strings,
so convert them with `Number(…)` before doing maths.

:::quiz id=fe-31-q13 xp=10
A form field gives you `const qty = '3'` (a string). What does `console.log(qty + 2)` print?
- [ ] `5`
- [x] `32`
- [ ] `NaN`
- [ ] It throws a TypeError
> One side of `+` is a string, so `+` joins text: `'3' + 2` becomes the string `'32'`. To add
> numbers, convert first: `Number(qty) + 2` is `5`. This is one of the most common bugs with form
> input, because input values are always strings.
:::

**Comparison** operators answer with a boolean: `<`, `>`, `<=`, `>=`, `===` (equal), `!==` (not
equal). **Logical** operators combine booleans: `&&` (and), `||` (or), `!` (not).

```js
const age = 20
console.log(age >= 18 && age < 65)   // → true
console.log(!true)                   // → false
```

## `===` versus `==`

JavaScript has two equality operators, and you should almost always use the three-character one.

- `===` (**strict equality**) is `true` only if both values have the **same type and same value**.
- `==` (**loose equality**) first **converts** (coerces) the values to a common type, using rules
  that are hard to remember.

```js
console.log(1 === 1)      // → true
console.log(1 === '1')    // → false  (number vs string)
console.log(1 == '1')     // → true   ('1' converted to 1)
console.log(0 == '')      // → true   (!)
console.log(0 == false)   // → true   (!)
console.log(null == undefined)  // → true
```

The rule at almost every company (enforced by the ESLint rule `eqeqeq`): **use `===` and `!==`.** The
one common exception is `x == null`, a short way to test "null or undefined" — but write
`x === null || x === undefined` if you're unsure.

:::quiz id=fe-31-q4 xp=10
Which comparisons are `true`? (select all that apply)
- [x] `3 === 3`
- [ ] `3 === '3'`
- [x] `3 == '3'`
- [x] `'abc' !== 'ABC'`
> `===` needs the same type *and* value: `3` and `'3'` are a number and a string, so `3 === '3'` is
> `false`. `==` converts the string to a number first, so `3 == '3'` is `true` — which is exactly why
> it hides bugs. String comparison is case-sensitive, so `'abc'` and `'ABC'` are different, making
> `!==` true.
:::

## Making decisions: `if`, `else` and the ternary

Programs need to do different things in different situations: show an error *if* the password is
wrong, otherwise log in. That's what `if` is for.

```js
const temperature = 18

if (temperature < 10) {
  console.log('Bring a coat')
} else if (temperature < 25) {
  console.log('A jumper is enough')   // ← this one runs
} else {
  console.log('T-shirt weather')
}
```

- The condition goes in **parentheses** `( )`; the code to run goes in **curly braces** `{ }` — a
  **block**.
- Conditions are checked top to bottom; the first true one wins, the rest are skipped.

**Truthy and falsy.** An `if` accepts any value, not only booleans. These six values are the
**falsy** ones you'll meet (treated as `false`): `false`, `0`, `''` (empty string), `null`,
`undefined`, `NaN`. (Two rare cousins, `-0` and the bigint `0n`, are falsy too.) Everything else is
**truthy** — including `'0'`, `'false'`, `[]` and `{}`.

```js
const input = ''
if (input) { console.log('has text') } else { console.log('empty') }   // → empty
```

The **ternary operator** `condition ? a : b` is a compact `if/else` that *produces a value*. You'll
use it constantly in React, because JSX accepts expressions, not statements.

```js
const stock = 0
const label = stock > 0 ? 'In stock' : 'Sold out'
console.log(label)   // → Sold out
```

:::quiz id=fe-31-q5 xp=10
What does this print?

```js
const items = []
const message = items.length ? `${items.length} items` : 'Cart is empty'
console.log(message)
```

- [x] `Cart is empty`
- [ ] `0 items`
- [ ] `undefined`
- [ ] It throws an error
> `items.length` is `0`, and `0` is **falsy**, so the ternary picks the value after the `:`. Note the
> trap the other way round: an empty array `[]` itself is *truthy* — that's why you test
> `items.length`, not `items`.
:::

:::challenge id=fe-31-c1 lang=js xp=25
title: What to wear
Write `whatToWear(celsius)` that returns:

- `'coat'` when the temperature is **below 10**,
- `'jumper'` when it is **10 or more but below 25**,
- `'t-shirt'` when it is **25 or more**.

hint: Use `if (celsius < 10) { return 'coat' }`, then `else if`, then `else`.
hint: Check the boundaries: `10` should give `'jumper'`, `25` should give `'t-shirt'`.

```js starter
function whatToWear(celsius) {
  return ''
}
```

```js solution
function whatToWear(celsius) {
  if (celsius < 10) {
    return 'coat'
  } else if (celsius < 25) {
    return 'jumper'
  } else {
    return 't-shirt'
  }
}
```

```js tests
test('cold days need a coat', () => {
  expect(whatToWear(-3)).toBe('coat')
  expect(whatToWear(9)).toBe('coat')
})
test('10 up to 24 is jumper weather', () => {
  expect(whatToWear(10)).toBe('jumper')
  expect(whatToWear(24)).toBe('jumper')
})
test('25 and above is t-shirt weather', () => {
  expect(whatToWear(25)).toBe('t-shirt')
  expect(whatToWear(38)).toBe('t-shirt')
})
```
:::

## Repeating things: loops

A **loop** runs the same block several times — once per item in a list, or until a condition stops
being true. Without loops you'd copy-paste code for every item.

**The classic `for` loop** has three parts in its parentheses, separated by `;`:
*start*; *keep going while*; *after each round*.

```js
for (let i = 0; i < 3; i++) {
  console.log('round', i)
}
// → round 0
// → round 1
// → round 2
```

**`for…of`** walks through every **element** of an array (or the characters of a string). It's the
one you'll use most, because there's no counter to get wrong:

```js
const fruits = ['apple', 'pear', 'kiwi']
for (const fruit of fruits) {
  console.log(fruit)
}
// → apple / pear / kiwi
```

**`while`** repeats as long as a condition is true — handy when you don't know the count up front:

```js
let lives = 3
while (lives > 0) {
  console.log('lives left:', lives)
  lives--
}
```

`break` leaves a loop early; `continue` skips to the next round.

:::warn title="for…of vs for…in"
`for (const x of array)` gives you the **values**. `for (const k in object)` gives you the **keys**
(property names) of an object — on an array that means the indexes as *strings* (`'0'`, `'1'`).
Use `for…of` for arrays.
:::

:::quiz id=fe-31-q6 xp=10
How many times does this print `hi`?

```js
for (let i = 1; i <= 4; i++) {
  console.log('hi')
}
```

- [ ] 3
- [x] 4
- [ ] 5
- [ ] Forever
> `i` starts at 1 and the loop continues while `i <= 4`, so it runs for `i = 1, 2, 3, 4` — four
> times. When `i` becomes 5 the condition is false and the loop stops. Off-by-one errors (`<` vs
> `<=`, starting at 0 vs 1) are the most common loop bug.
:::

:::challenge id=fe-31-c2 lang=js xp=25
title: Add up 1 to n
Write `sumTo(n)` that returns `1 + 2 + … + n` using a loop. For `n` of 0 or less it returns `0`.
Example: `sumTo(4)` is `10`.

hint: Start with `let total = 0`, then `for (let i = 1; i <= n; i++) { total += i }`.
hint: If `n` is 0 the loop body never runs, so `total` stays `0` — no special case needed.

```js starter
function sumTo(n) {
  let total = 0
  // your loop here
  return total + 1
}
```

```js solution
function sumTo(n) {
  let total = 0
  for (let i = 1; i <= n; i++) {
    total += i
  }
  return total
}
```

```js tests
test('sumTo(4) is 10', () => {
  expect(sumTo(4)).toBe(10)
})
test('sumTo(1) is 1', () => {
  expect(sumTo(1)).toBe(1)
})
test('zero and negatives give 0', () => {
  expect(sumTo(0)).toBe(0)
  expect(sumTo(-5)).toBe(0)
})
test('sumTo(100) is 5050', () => {
  expect(sumTo(100)).toBe(5050)
})
```
:::

## Functions: reusable, named steps

A **function** is a named block of code you can run (**call**) as often as you like, with different
inputs. Functions let you write logic once, give it a meaningful name, and test it on its own.

- **Parameters** are the input names in the definition.
- **Arguments** are the actual values you pass when calling.
- `return` sends a value back to the caller *and stops the function*. A function without `return`
  gives back `undefined`.

**Function declaration** — the `function` keyword:

```js
function add(a, b) {   // a and b are parameters
  return a + b
}
console.log(add(2, 3))   // → 5   (2 and 3 are arguments)
```

**Arrow function** — a shorter form stored in a variable. You'll see it everywhere in React
(event handlers, `map` callbacks):

```js
const add = (a, b) => {
  return a + b
}

const double = (n) => n * 2    // one expression → braces and `return` can be dropped
const greet = () => 'hello'    // no parameters → empty parentheses
console.log(double(4))         // → 8
```

**Default parameters** fill in a value when an argument is missing:

```js
function greet(name = 'friend') {
  return `Hi ${name}`
}
console.log(greet())       // → Hi friend
console.log(greet('Ada'))  // → Hi Ada
```

Functions are values too: you can pass one to another function. A function passed in like this is
called a **callback**:

```js
const nums = [1, 2, 3]
nums.forEach((n) => console.log(n * 10))   // → 10 / 20 / 30
```

:::quiz id=fe-31-q7 xp=10
What does `result` hold?

```js
const square = (n) => { n * n }
const result = square(3)
```

- [ ] `9`
- [x] `undefined`
- [ ] `'n * n'`
- [ ] It throws a SyntaxError
> With **curly braces**, an arrow function body is a normal block and needs an explicit `return`.
> Without it, the function returns `undefined`. Either write `(n) => n * n` (no braces = automatic
> return) or `(n) => { return n * n }`. This is one of the most common beginner bugs in React `map`
> callbacks.
:::

## Arrays: ordered lists

An **array** holds many values in order. You write one with square brackets; each value is an
**element**, and its position is its **index**, starting at **0**.

```js
const colours = ['red', 'green', 'blue']
console.log(colours[0])       // → red
console.log(colours.length)   // → 3
console.log(colours[5])       // → undefined (no error!)

colours.push('pink')          // add to the end → ['red','green','blue','pink']
colours[1] = 'lime'           // replace an element
console.log(colours.includes('blue'))   // → true
```

Notice that `colours` is a `const`, yet we changed its contents. `const` means "this variable always
points to the *same array*", not "the array is frozen".

A preview of the array methods you'll learn properly in **Modern JavaScript Refresher** — each takes
a callback and returns something new without changing the original:

```js
const prices = [5, 12, 30]
prices.map((p) => p * 2)        // → [10, 24, 60]   transform every element
prices.filter((p) => p > 10)    // → [12, 30]       keep the ones that pass
prices.find((p) => p > 10)      // → 12             first match (or undefined)
prices.reduce((sum, p) => sum + p, 0)   // → 47     combine into one value
```

## Objects: named fields

An **object** groups related values under **keys** (also called property names). Where an array
answers "what's at position 2?", an object answers "what's the `email`?". Data from APIs almost always
arrives as objects.

```js
const user = {
  name: 'Ada',      // key: value, separated by commas
  age: 36,
  isAdmin: false,
}

console.log(user.name)       // → Ada        dot notation
console.log(user['age'])     // → 36         bracket notation (key in a string or variable)
user.age = 37                // change a property
user.email = 'ada@example.com'   // add a new one
console.log(user.phone)      // → undefined  (missing keys are undefined, not an error)
```

Objects and arrays nest freely — this is what JSON (the format APIs send) looks like:

```js
const order = {
  id: 1001,
  items: [
    { name: 'Pen', qty: 2 },
    { name: 'Book', qty: 1 },
  ],
}
console.log(order.items[1].name)   // → Book
```

A function stored in an object is called a **method**. Inside a method, the keyword `this` means
"the object the method was called on":

```js
const counter = {
  value: 0,
  increment() { this.value++ },   // short for  increment: function () { this.value++ }
}
counter.increment()          // here `this` is counter
console.log(counter.value)   // → 1
```

:::quiz id=fe-31-q8 xp=10
Given `const cart = { items: [{ title: 'Mug', price: 8 }] }`, which expression is `8`?
- [ ] `cart.items.price`
- [x] `cart.items[0].price`
- [ ] `cart[0].items.price`
- [ ] `cart.items(0).price`
> Read it left to right: `cart.items` is the array, `[0]` picks its first element (the mug object),
> and `.price` reads that object's property. `cart.items.price` asks the *array* for a `price` key and
> gets `undefined`. Parentheses `( )` call functions; square brackets `[ ]` index into arrays.
:::

## `null` and `undefined`: two kinds of "nothing"

Both mean "no value", but they have different stories:

- **`undefined`** is what JavaScript gives you *automatically*: a variable declared but not
  assigned, a missing object key, a missing argument, a function with no `return`.
- **`null`** is what a programmer writes *on purpose* to say "empty for now" — e.g.
  `let selectedUser = null` until someone is picked.

```js
let x
console.log(x)               // → undefined
const user = { name: 'Ada' }
console.log(user.address)    // → undefined
console.log(user.address.city)   // ✗ TypeError: Cannot read properties of undefined (reading 'city')
```

That last error is the single most common JavaScript crash. The fix is to check first —
`if (user.address) { … }` — or use **optional chaining** `user.address?.city`, which returns
`undefined` instead of crashing (covered in the next lesson). TypeScript's big win is that it
warns you about this *before* the code runs.

:::quiz id=fe-31-q14 xp=10
What does this print?

```js
function findUser(id) {
  if (id === 1) {
    return { name: 'Ada' }
  }
}
console.log(findUser(2))
```

- [ ] `null`
- [x] `undefined`
- [ ] `{ name: 'Ada' }`
- [ ] It throws a ReferenceError
> For `id = 2` the `if` is skipped and the function reaches its end without a `return`, so it gives
> back `undefined` automatically. JavaScript never invents `null` — you only get `null` when some code
> writes it on purpose (e.g. `return null` for "no user found").
:::

:::challenge id=fe-31-c3 lang=js xp=25
title: Count the long words
Write `countLong(words, min)` that returns how many strings in the array `words` have **at least**
`min` characters. Use a `for…of` loop. Example: `countLong(['hi', 'hello', 'hey'], 3)` is `2`.

hint: Keep a counter: `let count = 0`, then `for (const word of words) { … }`.
hint: A string's length is `word.length`; "at least" means `>=`.

```js starter
function countLong(words, min) {
  let count = 0
  return count
}
```

```js solution
function countLong(words, min) {
  let count = 0
  for (const word of words) {
    if (word.length >= min) {
      count++
    }
  }
  return count
}
```

```js tests
test('counts words with at least min characters', () => {
  expect(countLong(['hi', 'hello', 'hey'], 3)).toBe(2)
})
test('empty array gives 0', () => {
  expect(countLong([], 1)).toBe(0)
})
test('exactly min counts', () => {
  expect(countLong(['abcd', 'abc', 'ab'], 4)).toBe(1)
})
test('min of 0 counts everything', () => {
  expect(countLong(['', 'a'], 0)).toBe(2)
})
```
:::

## Reading TypeScript annotations

TypeScript adds **type annotations**: a colon after a name, then the type. They don't change what
the code *does* — they let the editor and compiler catch mistakes such as passing a number where text
is expected, or misspelling a property.

```ts
let title: string = 'Hello'       // title must always hold a string
let count: number = 0
let done: boolean = false
let tags: string[] = ['a', 'b']   // an array of strings

// parameters and the return type of a function
function add(a: number, b: number): number {
  return a + b
}
add(2, '3')   // ✗ Argument of type 'string' is not assignable to parameter of type 'number'.
```

Read `name: Type` aloud as "*name* is a *Type*". `(a: number, b: number): number` reads "takes two
numbers, returns a number".

You often **don't** write the annotation: TypeScript **infers** (works out) the type from the value.
`const n = 5` is already known to be a `number`. Annotate function parameters and leave the obvious
rest to inference.

**Interfaces** describe the *shape* of an object — which keys it has and their types:

```ts
interface User {
  id: number
  name: string
  email?: string        // ? = optional: may be missing (type is string | undefined)
}

const ada: User = { id: 1, name: 'Ada' }             // OK — email is optional
const bob: User = { id: 2 }                          // ✗ Property 'name' is missing
```

A few more symbols you'll meet:

| You see | It means |
|---|---|
| `string \| null` | **union**: either a string or `null` |
| `'small' \| 'large'` | **literal type**: only these exact strings |
| `type Id = number` | a **type alias** — a new name for a type |
| `Array<string>` | same as `string[]` (generic syntax) |
| `(n: number) => string` | the type of a function |
| `value as User` | a **type assertion**: "trust me, it's a User" (use sparingly) |
| `<T>` | a **generic** type parameter — a placeholder type (see **TypeScript for Real Apps**) |

**TypeScript Essentials** goes deep on all of these; for now, aim to *read* them.

:::quiz id=fe-31-q9 xp=10
Given this interface, which object is **not** a valid `Product`?

```ts
interface Product {
  name: string
  price: number
  discount?: number
}
```

- [ ] `{ name: 'Pen', price: 2 }`
- [ ] `{ name: 'Pen', price: 2, discount: 0.5 }`
- [x] `{ name: 'Pen', price: '2' }`
- [ ] `{ name: 'Mug', price: 0 }`
> `price` must be a `number`, and `'2'` (in quotes) is a `string`, so TypeScript reports
> *Type 'string' is not assignable to type 'number'*. `discount?` is optional, so it can be present
> or missing. `0` is a perfectly valid number.
:::

:::challenge id=fe-31-c4 lang=ts xp=30
title: A typed display name
Write `displayName(user)` for this `User` interface. It returns `"First Last"` (one space between),
or `"First M. Last"` when `middle` is a **non-empty** string (only its first letter, followed by a
dot). A missing or empty `middle` (`''`) gives `"First Last"`. Use a template literal.

```ts
interface User {
  first: string
  last: string
  middle?: string
}
```

hint: Check the optional field: `if (user.middle) { … }` — when it's missing it is `undefined` (falsy).
hint: The first letter of a string is `user.middle[0]`.

```ts setup
interface User {
  first: string
  last: string
  middle?: string
}
```

```ts starter
function displayName(user: User): string {
  return user.first
}
```

```ts solution
function displayName(user: User): string {
  if (user.middle) {
    return `${user.first} ${user.middle[0]}. ${user.last}`
  }
  return `${user.first} ${user.last}`
}
```

```ts tests
test('first and last', () => {
  expect(displayName({ first: 'Ada', last: 'Lovelace' })).toBe('Ada Lovelace')
})
test('with a middle name', () => {
  expect(displayName({ first: 'John', middle: 'Ronald', last: 'Tolkien' })).toBe('John R. Tolkien')
})
test('empty middle name is ignored', () => {
  expect(displayName({ first: 'Grace', middle: '', last: 'Hopper' })).toBe('Grace Hopper')
})
```
:::

:::challenge id=fe-31-c5 lang=ts xp=30
title: Total stock value
Write `stockValue(items)` that returns the sum of `price * qty` over all items, skipping items whose
`active` flag is `false`. Use a loop and the `Item` interface (shown below, already defined for you).

```ts
interface Item {
  name: string
  price: number
  qty: number
  active: boolean
}
```

hint: `let total = 0` then `for (const item of items) { … }`.
hint: Skip inactive ones with `if (!item.active) continue`, or only add when `item.active` is true.

```ts setup
interface Item {
  name: string
  price: number
  qty: number
  active: boolean
}
```

```ts starter
function stockValue(items: Item[]): number {
  return -1
}
```

```ts solution
function stockValue(items: Item[]): number {
  let total = 0
  for (const item of items) {
    if (!item.active) continue
    total += item.price * item.qty
  }
  return total
}
```

```ts tests
test('empty list is 0', () => {
  expect(stockValue([])).toBe(0)
})
test('adds price * qty', () => {
  expect(
    stockValue([
      { name: 'Pen', price: 2, qty: 10, active: true },
      { name: 'Mug', price: 8, qty: 3, active: true },
    ]),
  ).toBe(44)
})
test('skips inactive items', () => {
  expect(
    stockValue([
      { name: 'Pen', price: 2, qty: 10, active: false },
      { name: 'Mug', price: 8, qty: 3, active: true },
    ]),
  ).toBe(24)
})
```
:::

## Modules: `import` and `export`

Real apps have hundreds of files. A **module** is simply one file whose variables are *private* by
default; you choose what to share with `export`, and other files pull it in with `import`. This keeps
names from clashing and makes dependencies explicit.

```ts
// math.ts
export function add(a: number, b: number) { return a + b }   // named export
export const PI = 3.14159
export default function square(n: number) { return n * n }   // default export (max one per file)
```

```ts
// app.ts
import square, { add, PI } from './math'   // default import (any name) + named imports in { }
import { add as plus } from './math'       // rename on import
import { useState } from 'react'           // from a package in node_modules (no ./)

console.log(add(1, 2), square(3), PI)
```

- `'./math'` starting with `./` or `../` = a file in your project. In Vite projects the extension
  is usually left off; Node.js on its own wants the full file name (`'./math.ts'` or `'./math.js'`).
- `'react'` without a dot = a **package** installed with npm.
- **Named exports** must be imported with the exact name in `{ }`. Most teams prefer them because
  renaming and searching are easier.

## What is a `.tsx` file?

File extensions tell the tools what's inside:

| Extension | Contains |
|---|---|
| `.js` | JavaScript |
| `.ts` | TypeScript |
| `.jsx` | JavaScript + **JSX** |
| `.tsx` | TypeScript + **JSX** — what React components in this academy use |
| `.d.ts` | Only type declarations, no code |

**JSX** is HTML-like syntax inside JavaScript. It isn't valid JavaScript on its own — Vite translates
each tag into a function call (`<h1>Hi</h1>` becomes `jsx('h1', { children: 'Hi' })`).

```tsx
// Greeting.tsx
interface GreetingProps {
  name: string
}

export function Greeting({ name }: GreetingProps) {
  return <h1 className="title">Hello, {name}!</h1>   // { } inside JSX = a JS expression
}
```

Reading it with what you now know: an exported function named `Greeting`, taking an object whose
shape is `GreetingProps`, returning JSX. `{name}` inserts a value just like `${name}` in a template
literal. **Components & JSX** explains the rules in full.

:::quiz id=fe-31-q10 xp=10
A file contains `export function Card() { return <div>Hi</div> }` and type annotations. What should
it be called?
- [ ] `Card.ts`
- [x] `Card.tsx`
- [ ] `Card.js`
- [ ] `Card.html`
> It contains both TypeScript and JSX (`<div>…</div>`), so it needs `.tsx`. In a `.ts` file the
> compiler doesn't expect JSX and reports a confusing error at the `<`. Use `.ts` for files without
> JSX (utilities, API clients, types).
:::

:::quiz id=fe-31-q11 xp=10
`math.ts` contains `export function add(…)` (a named export, no default). Which import works?
- [ ] `import add from './math'`
- [x] `import { add } from './math'`
- [ ] `import { Add } from './math'`
- [ ] `import add from 'math'`
> Named exports are imported inside `{ }` with the **exact** (case-sensitive) name. Without braces
> you're asking for the *default* export, which this file doesn't have. `'math'` without `./` would
> look for an npm package called `math`, not your file.
:::

## Syntax cheat sheet

| What | Syntax | Example |
|---|---|---|
| Constant | `const name = value` | `const max = 10` |
| Reassignable variable | `let name = value` | `let i = 0` |
| String | `'…'` `"…"` `` `…${x}…` `` | `` `Hi ${name}` `` |
| Equality | `===` / `!==` | `a === b` |
| And / or / not | `&&` `\|\|` `!` | `isAdmin && !isBanned` |
| If | `if (c) { } else if (d) { } else { }` | `if (x > 0) { … }` |
| Ternary | `c ? a : b` | `n === 1 ? 'item' : 'items'` |
| For loop | `for (let i = 0; i < n; i++) { }` | |
| For…of | `for (const x of list) { }` | `for (const u of users) { … }` |
| While | `while (c) { }` | `while (queue.length) { … }` |
| Function | `function f(a, b) { return … }` | `function add(a, b) { return a + b }` |
| Arrow function | `(a) => expr` / `(a) => { … }` | `const dbl = (n) => n * 2` |
| Array | `[a, b]`, `list[0]`, `list.length` | `['x', 'y'][1]` → `'y'` |
| Object | `{ key: value }`, `obj.key`, `obj['key']` | `user.name` |
| Type annotation | `name: Type` | `let id: number` |
| Optional property | `key?: Type` | `email?: string` |
| Interface | `interface T { key: Type }` | `interface User { name: string }` |
| Union | `A \| B` | `string \| null` |
| Export / import | `export …` / `import { x } from './f'` | `import { useState } from 'react'` |

## Common beginner errors and what they mean

Error messages look scary, but they always say **what** went wrong and **where** (file and line).
Read the first line slowly.

| Message | What it means | Typical fix |
|---|---|---|
| `ReferenceError: total is not defined` | You used a name that doesn't exist here — a typo, or a variable declared in another block. | Check spelling/case; declare it with `const`/`let` where it's visible. |
| `TypeError: Cannot read properties of undefined (reading 'name')` | The thing **before** `.name` is `undefined`. | Find why it's missing (data not loaded yet? wrong key?); guard with `if` or `?.`. |
| `TypeError: Assignment to constant variable.` | You reassigned a `const`. | Use `let`, or create a new variable. |
| `TypeError: x is not a function` | You called `x()` but `x` is a value, or `undefined` (often a typo or wrong import). | Check the name and the import. |
| `SyntaxError: Identifier 'x' has already been declared` | You declared the same name twice with `let`/`const` in the same scope. | Rename one, or assign with `x = …` instead of declaring again. |
| `SyntaxError: Unexpected token '}'` | The code isn't valid grammar — usually a missing or extra bracket, comma or quote *near* that spot. | Look at the line before; let the editor highlight matching brackets. |
| `Type 'string' is not assignable to type 'number'.` (TS) | You put a value of the wrong type somewhere. | Convert it (`Number(x)`) or fix the annotation. |
| `Property 'nmae' does not exist on type 'User'. Did you mean 'name'?` (TS) | A typo or a property the interface doesn't declare. | Fix the spelling or add it to the interface. |
| `'user' is possibly 'undefined'.` (TS) | TS sees a path where the value may be missing. | Check it first: `if (!user) return`. |

:::tip title="Read the stack trace from the top"
Below the message is a **stack trace**: the chain of function calls that led to the error, newest
first. The first line pointing at *your* file (not `node_modules`) is almost always where to look.
In the browser console, click the `file.tsx:12` link to jump straight there.
:::

:::quiz id=fe-31-q12 xp=10
Your page crashes with `TypeError: Cannot read properties of undefined (reading 'title')` on the line
`const t = post.title`. What is undefined?
- [ ] `title`
- [x] `post`
- [ ] `t`
- [ ] The whole file
> The message says it tried to read the property `'title'` *from* something undefined — and the
> thing before `.title` is `post`. So `post` has no value at that moment (often because data hasn't
> arrived from the server yet). The fix is to find out why, and to guard: `if (!post) return …`.
:::

:::job title="What day one looks like"
Nobody will test you on operator precedence trivia. What teams expect is that you can **read** an
unfamiliar file — imports at the top, an interface, a few functions, some JSX — and explain what it
does, then run it and read the error when it breaks. Projects also enforce style with **ESLint**
(catches bugs such as `==` or unused variables) and **Prettier** (formatting). Let them fix the small
stuff on save; spend your attention on logic.
:::

:::pro title="How seniors write the basics"
- `const` by default, `let` rarely, `var` never; `===` always.
- Small functions with clear names (`isOverdue`, `formatPrice`) that **return** values rather than
  print them — they're easy to test and reuse.
- Annotate the edges (function parameters, return types of exported functions, API data) and let
  TypeScript infer the inside.
- Turn on `"strict": true` in `tsconfig.json` — it's the setting that makes TypeScript catch the
  `undefined` crashes.
:::

:::lab id=fe-31-lab1 xp=30
title: Run JavaScript and TypeScript on your machine
You'll install **Node.js** (a program that runs JavaScript outside the browser), run a JS file and
then a TS file.

**1. Install Node.js 22 LTS or newer** from https://nodejs.org (or with a version manager such as
`nvm` / `fnm`). Check it in a terminal:

```bash
node --version
```

Expected: `v22.18.0` or higher (e.g. `v24.x` or `v26.x`).

**2. Create a folder and a JavaScript file:**

```bash
mkdir syntax-primer
cd syntax-primer
```

Create `hello.js` with this content:

```js
// hello.js
const name = 'DevQuest'
const scores = [12, 30, 8]

function total(list) {
  let sum = 0
  for (const n of list) {
    sum += n
  }
  return sum
}

const best = scores.length > 0 ? Math.max(...scores) : 0
console.log(`Hello, ${name}!`)
console.log(`Total: ${total(scores)}, best: ${best}`)
console.log(1 === '1', 1 == '1')
```

Run it:

```bash
node hello.js
```

Expected output:

```text
Hello, DevQuest!
Total: 50, best: 30
false true
```

**3. Now TypeScript.** Create `greet.ts`:

```ts
// greet.ts
interface User {
  name: string
  email?: string
}

function describe(user: User): string {
  return user.email ? `${user.name} <${user.email}>` : user.name
}

const users: User[] = [{ name: 'Ada', email: 'ada@example.com' }, { name: 'Linus' }]
for (const u of users) {
  console.log(describe(u))
}
```

Run it. Node 22.18+ strips the type annotations and runs the result:

```bash
node greet.ts
```

Expected output:

```text
Ada <ada@example.com>
Linus
```

:::tip
On an older Node 22 you'll get an "Unknown file extension .ts" error — run
`node --experimental-strip-types greet.ts` instead, or upgrade Node.
:::

**4. Let the type checker catch a bug.** Node only *strips* types; it doesn't check them. Install
the TypeScript compiler into the folder and run a check:

```bash
npm init -y
npm install --save-dev typescript
npx tsc --noEmit --strict greet.ts
```

Expected: no output (no errors). Now change the last user to `{ nmae: 'Linus' }` and run
`npx tsc --noEmit --strict greet.ts` again. Expected (wording may vary slightly):

```text
greet.ts(11,69): error TS2353: Object literal may only specify known properties, and 'nmae' does not exist in type 'User'.
```

Fix the typo and run it once more until it's clean.

:::info
The line/column numbers `(11,69)` assume you copied the file exactly. Checked with TypeScript 7.0
and Node 26; other versions may word messages slightly differently — see
https://www.typescriptlang.org/docs/ if something doesn't match.
:::
 When you're done you can delete the folder.

- [ ] `node --version` prints v22.18 or higher
- [ ] `node hello.js` prints the three expected lines
- [ ] `node greet.ts` prints the two expected lines
- [ ] `npx tsc --noEmit --strict greet.ts` reported the `nmae` typo, and is clean after fixing it
:::

:::cards id=fe-31-cards1 xp=15 title="Syntax primer"
Q: `let` vs `const`?
A: `const` can't be reassigned (use it by default); `let` can. `var` is legacy — don't use it.
Q: Why three kinds of string quotes?
A: `'…'` and `"…"` are identical (so you can nest one inside the other). Backticks make template literals: `${…}` interpolation and multi-line text.
Q: `===` vs `==`?
A: `===` compares type and value with no conversion. `==` converts types first (`1 == '1'` is true). Always use `===`.
Q: Name the six falsy values.
A: `false`, `0`, `''`, `null`, `undefined`, `NaN` (plus the rare `-0` and `0n`). Everything else (including `[]`, `{}`, `'0'`) is truthy.
Q: What is `'5' + 1`? And `'5' - 1`?
A: `'51'` (a string — `+` joins as soon as one side is text) and `4` (`-` converts to numbers). Use `Number(x)` to convert explicitly.
Q: `undefined` vs `null`?
A: `undefined` = no value was given (automatic). `null` = deliberately empty (written by a programmer).
Q: What does an arrow function with braces return if you forget `return`?
A: `undefined`. Only the brace-less form `(n) => n * 2` returns automatically.
Q: What's the first index of an array?
A: 0. The last is `list.length - 1`.
Q: What does `email?: string` mean in an interface?
A: The property is optional — it may be missing, so its type is `string | undefined`.
Q: Named vs default export?
A: Named: `export function add`, imported as `import { add }` (exact name). Default: one per file, imported without braces under any name.
Q: What is a `.tsx` file?
A: TypeScript plus JSX — the file type for React components.
Q: "Cannot read properties of undefined (reading 'x')" means…?
A: The value *before* `.x` is undefined. Find why, then guard with `if` or `?.`.
:::

## Recap

- JavaScript runs in the browser; TypeScript is JavaScript plus type annotations that are checked, then removed.
- Use `const` by default, `let` when you reassign, never `var`; names are camelCase and case-sensitive.
- Strings: `'…'` and `"…"` are the same; backticks give template literals with `${…}` and multiple lines.
- Use `===` / `!==`; know the six falsy values; the ternary `c ? a : b` is an `if/else` that produces a value.
- Loops: `for` for counting, `for…of` for arrays, `while` for "until"; watch for off-by-one errors.
- Functions take parameters and `return` values; arrow functions with braces need an explicit `return`.
- Arrays are indexed from 0; objects hold named keys; missing things are `undefined`, deliberate emptiness is `null`.
- Read TS annotations as "name is a Type"; `?` means optional; interfaces describe object shapes.
- Modules share code with `export` / `import`; `.tsx` = TypeScript + JSX for React components.
- Error messages say what and where — read the first line, then the first stack-trace line in your own code.
