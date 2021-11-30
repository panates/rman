#!/usr/bin/env node
import {run} from '../dist/cli.js';

// eslint-disable-next-line
run().catch(e => console.error(e));
