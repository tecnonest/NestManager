#!/usr/bin/env node
import { run } from '../src/nest/cli.mjs'

const { ok, output } = run()

if (output) (ok ? process.stdout : process.stderr).write(output + '\n')
process.exit(ok ? 0 : 1)
