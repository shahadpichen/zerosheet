#!/usr/bin/env bash

# This focused verifier answers four separate Milestone 12 questions:
# 1. Does the storage-independent sheet core behave correctly?
# 2. Can its 100 x 100 encryption round trip finish and verify every value?
# 3. Do the sheet core and browser integration compile into production assets?
# 4. Did a separately licensed Univer Pro import enter the reviewed OSS scope?
# Keeping these checks behind one command makes the milestone reproducible for
# a learner and prevents a future dependency change from being mistaken for a
# harmless editor feature.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

echo "Running selective-protection and synchronization tests..."
pnpm --filter @zerosheet/sheet-core test

echo "Measuring and verifying the 100 x 100 encrypted batch..."
pnpm sheet:benchmark:sync

echo "Building the encryption core and lazy-loaded Univer editor..."
pnpm --filter @zerosheet/sheet-core build
pnpm --filter @zerosheet/web build

# The current commercial-use decision covers the pinned Apache-2.0 packages.
# Univer Pro has a different product/license boundary, so adding it must be a
# visible architecture and license decision rather than an accidental import.
if rg --glob '*.ts' --glob '*.tsx' --glob 'package.json' '"@univerjs-pro/' \
  apps/web packages/sheet-core; then
  echo "Unexpected Univer Pro import found; perform a license review first." >&2
  exit 1
fi

echo "Milestone 12 editor verification passed."
