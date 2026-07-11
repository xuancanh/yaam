#!/usr/bin/env node
import process from 'node:process'
import { main } from '../dist/cli.js'

main(process.argv.slice(2)).then(
  code => { process.exitCode = code },
  err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  },
)
