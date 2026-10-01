# Changelog

<!-- rman:documented-up-to 35f9992482fd5b9627010853f59f24ac9cf89ab6 -->

## v2.8.0 (2026-10-01)

### ✨ Features

- **progress:** keep failed packages on the list, naming what failed (35f9992)

### 🐛 Bug Fixes

- **progress:** capture a function step's child output instead of printing it (c973f7c)
- **run:** one console patch per run, not per step - the recap was being swallowed (50297c1)
- **progress:** a row forgets its last line when the work changes (70e7bc4)

---

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
