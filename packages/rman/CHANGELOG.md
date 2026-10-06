# Changelog

<!-- rman:documented-up-to f3bbd437f7b9d8f7c630299d9477e95a06cd1fab -->

## v2.12.0 (2026-10-06)

### ✨ Features

- **list:** a Publish column, grey where publish would skip the package (f3bbd43)

### 🔧 Refactoring

- move LiveRegion and ProgressPanel to core/classes [no-release] (9664c09)

---

## v2.11.3 (2026-10-05)

### 🐛 Bug Fixes

- **publish:** a failed publish blocks only what a consumer's install needs (a1427a6)

---

## v2.11.2 (2026-10-05)

### 🐛 Bug Fixes

- **publish:** decide from the manifest publish writes, and keep --json stdout one document (c9603c1)

---

## v2.11.1 (2026-10-05)

### 🐛 Bug Fixes

- **publish:** decide private from the manifest that will be published (d026cc8)

---

## v2.11.0 (2026-10-05)

### ✨ Features

- **cli:** global --json and --log-file for a run's log (37f1782)
- **run:** render a run through reporters; lead plain lines with their package (96fd26a)

### 🐛 Bug Fixes

- **version:** print a named group as a value, and (default)/(root) as notes (f9cfa7e)
- **run:** with no progress panel, run every step without a terminal and print its lines (43a58a7)
- **run:** an unmarked step waits, and a package's own exec keeps the configured topo (1b2781c)

---

## v2.10.1 (2026-10-02)

### 🐛 Bug Fixes

- **version:** a named group with one member still names itself in the plan (b93aaa1)

---

## v2.10.0 (2026-10-02)

### ✨ Features

- **changelog:** changelog.groupFiles - put a named group's file where it belongs (e51cfb8)

---

## v2.9.0 (2026-10-02)

### ✨ Features

- **run:** a step can say where the package starts waiting for its dependencies (273f82f)
- **run:** export runOptions/readRunOptions, so a plugin can alias "run <script>" (ba78cac)
- **run:** a command can hand its per-package work to rman's own scheduler (97715ee)

### 🐛 Bug Fixes

- **graph:** order packages topologically, and refuse a cycle instead of ignoring it (d1c4ebd)
- **run:** a step object is one `command` taking both forms, and topo is a boolean (f08c70e)
- **run:** a swept package's log line no longer repeats the command's name (2c7c590)
- **clean:** sweep compiled output anywhere in a package, not only under src/test (516971a)

### 🧪 Tests

- **run:** pin the topo barrier with a rendezvous, not a sleep (30e8b87)

---

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
