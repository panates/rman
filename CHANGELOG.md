# Changelog

<!-- rman:documented-up-to 0774edfd142e11c7821d2f5e702525a958bf13d3 -->

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
