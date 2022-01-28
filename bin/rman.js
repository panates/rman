#!/usr/bin/env node
import {runCli} from '../esm/cli.mjs';

// eslint-disable-next-line
runCli().catch(e => console.error(e));
