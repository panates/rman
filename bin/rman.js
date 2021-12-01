#!/usr/bin/env node
import {run} from '../esm/cli.mjs';

// eslint-disable-next-line
run().catch(e => console.error(e));
