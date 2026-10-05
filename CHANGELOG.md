# Changelog

<!-- rman:documented-up-to c9603c1fca75b7d72f7dcf2b11fc0a5a64b20e81 -->

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

- **run:** with no progress panel, run every step without a terminal and print its lines (43a58a7)
- **run:** an unmarked step waits, and a package's own exec keeps the configured topo (1b2781c)

---

## v2.10.0 (2026-10-02)

### ✨ Features

- **changelog:** changelog.groupFiles - put a named group's file where it belongs (e51cfb8)

---

## v2.9.0 (2026-10-02)

### ✨ Features

- **run:** a step can say where the package starts waiting for its dependencies (273f82f)
- **run:** a command can hand its per-package work to rman's own scheduler (97715ee)

### 🐛 Bug Fixes

- **graph:** order packages topologically, and refuse a cycle instead of ignoring it (d1c4ebd)
- **run:** a step object is one `command` taking both forms, and topo is a boolean (f08c70e)

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
