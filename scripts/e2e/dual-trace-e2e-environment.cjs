// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

"use strict";

const {
  PATHS,
  prepareRunWorkspace,
  resolveTooling,
  secureEvidenceTree,
  writeJson,
} = require("./dual-trace-e2e-paths.cjs");
const {
  DUMMY_OPENAI_API_KEY,
  childEnvironments,
  configureServices,
  validateBackendHealth,
} = require("./dual-trace-e2e-services.cjs");

module.exports = {
  PATHS,
  DUMMY_OPENAI_API_KEY,
  childEnvironments,
  configureServices,
  prepareRunWorkspace,
  resolveTooling,
  secureEvidenceTree,
  validateBackendHealth,
  writeJson,
};
