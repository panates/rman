#!/usr/bin/env node
import { runCli } from '../esm/cli.js';

runCli().catch(() => 0);
