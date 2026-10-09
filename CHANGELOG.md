# Changelog

<!-- rman:documented-up-to d461177b60eeb94b78e1b5fde9da7211dfe66a56 -->

## v2.22.0 (2026-10-09)

### ✨ Features

- **version:** a package kept out of publishing takes no version (d461177)

---

## v2.21.1 (2026-10-09)

### 🐛 Bug Fixes

- **clean:** remove a symbolic link as a link, never follow it into another package (773fc4a)

---

## v2.21.0 (2026-10-09)

### ✨ Features

- **run:** a failed package's recap shows the failing step's output, the passing steps a line each (5fbe1f3)

### 🐛 Bug Fixes

- **cli:** a failing command says its reason once (f16df7e)

---

## v2.20.0 (2026-10-09)

### ✨ Features

- **run:** a step object takes its own if, and a step knows what the run was scoped to (b9723e3)

---

## v2.19.1 (2026-10-08)

### 🐛 Bug Fixes

- **publish:** a target's plan holds only the packages that ship to it (8261b69)

---

## v2.19.0 (2026-10-08)

### ✨ Features

- **deps:** one table per package, with column headers (8e36ef9)
- **cli:** a preset that cannot be found is a warning and a question, not an error (fa2df86)

### 🐛 Bug Fixes

- **publish:** wait for the registry to serve what was published before building images (398024c)

---

## v2.18.1 (2026-10-08)

### 🐛 Bug Fixes

- **version:** a prerelease moving to another identifier keeps its version (a2ce750)

### 🤖 Continuous Integration

- **release:** alpha and beta branches release prereleases named after themselves (4fac239)

---

## v2.18.0 (2026-10-08)

### ✨ Features

- **node:** packageManager is keyed by technology - packageManager: { node: pnpm } (3be302d)

### 🐛 Bug Fixes

- **publish:** build the docker image after the registries, and say why it failed (0441151)

### 🧹 Chores

- drop dependencies nothing uses (5f8f183)
- **deps:** update dependencies within their majors (70bc980)

---

## v2.17.0 (2026-10-08)

### ✨ Features

- **node:** copyAssets - the files tsc does not emit, copied into its outDir (27496e4)

---

## v2.16.0 (2026-10-07)

### ✨ Features

- **version,publish:** a permanent prerelease line - version.preid and publish.npm.latestPrereleases (3967663)

---

## v2.15.2 (2026-10-07)

### 🐛 Bug Fixes

- **cli:** keep a command's own output when the status line is live (c5f6b69)
- **deps:** say "All dependencies are up to date" when nothing moves (b547cda)

---

## v2.15.1 (2026-10-06)

### 🐛 Bug Fixes

- **version:** --push sends this release's tags, branch and tags in one atomic push (c097120)

---

## v2.15.0 (2026-10-06)

### ✨ Features

- **info,version:** report the loaded platforms, and put groupKey in version --json (e82c19a)

### 📚 Documentation

- verify the reference against 2.14.0 (5b167cc)

---

## v2.14.0 (2026-10-06)

### ✨ Features

- **deps:** list and upgrade dependencies, replacing npm-check-updates (bcb336a)

---

## v2.13.0 (2026-10-06)

### ✨ Features

- **list:** registry host, "-" for a skipped target, and a Group column (6132b5d)

### 🐛 Bug Fixes

- **changelog:** a package that moved keeps its history (4c8e243)

---

## v2.12.0 (2026-10-06)

### ✨ Features

- **list:** a Publish column, grey where publish would skip the package (f3bbd43)

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
