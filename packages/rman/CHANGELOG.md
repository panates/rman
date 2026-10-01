# Changelog

<!-- rman:documented-up-to b3682f27db37948f0f400e64dae1455c6299322d -->

## v2.7.0 (2026-10-01)

### ✨ Features

- **progress:** show the command each row is running, at the end of the line (b3682f2)

### 🐛 Bug Fixes

- **progress:** put the running command's repository back on screen (b72b0a4)

---

## v2.6.1 (2026-10-01)

### 🐛 Bug Fixes

- **progress:** one region draws at a time, so the bottom lines stop swapping (0774edf)

---

## v2.6.0 (2026-09-30)

### ✨ Features

- **changelog:** one changelog per release group, and the root's own (a0b2bdc)
- **changelog:** a progress panel, --rebuild, and one report line per file (b60cf89)

### 🐛 Bug Fixes

- **changelog:** count the commits, which is the only thing that moves (bc1183e)
- **progress:** fill the bar from step progress, not from finished items (298353d)

---

## v2.5.0 (2026-09-30)

### ✨ Features

- export mergeConfig, for a config assembled in JavaScript (3fe2d95)

### 🧹 Chores

- write a changelog, from v2.0.0 onward (ff77d48)

---

## v2.4.0 (2026-09-30)

### ✨ Features

- **version:** reach in-group dependents on a patch, not only the changed packages (28cec7c)
- **version:** version.cascade, a floor under a group's release width (cb98422)

---

## v2.3.1 (2026-09-30)

### 🐛 Bug Fixes

- **cli:** keep the inherited environment when a status region forces a pipe (d9ffe68)

---

## v2.3.0 (2026-09-30)

### ✨ Features

- **cli:** a live status line around every command that does work (d25bdbc)
- **cli:** let a contributed command take the build and test aliases (086ee0d)

---

## v2.2.0 (2026-09-29)

### ✨ Features

- **version:** a "version.stamp" entry may be optional (9a6045c)

---

## v2.1.0 (2026-09-29)

### ✨ Features

- **config:** a "[glob]" selector reaches the root of a single-package repository (49b6fa9)
- **changelog:** a section per standard commit type, no repeated message, a sha on every line (016f3bc)

---

## v2.0.1 (2026-09-29)

### 🐛 Bug Fixes

- **run:** print a failed package's captured log as captured, not in red (c6619d4)

---

## v2.0.0 (2026-09-29)

### 🐛 Bug Fixes

- **publish:** ask the registry a package actually publishes to (c5daa3a)

### 🧪 Tests

- **changelog:** stop selecting release headings by the letter "v" (a76cafd)
