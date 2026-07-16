// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const path = require('node:path');

const cache = new Map();

function loadTraceType(repoRoot) {
  const normalizedRoot = path.resolve(repoRoot);
  if (cache.has(normalizedRoot)) return cache.get(normalizedRoot);

  const protobufPath = require.resolve('protobufjs', {
    paths: [path.join(normalizedRoot, 'backend')],
  });
  const protobuf = require(protobufPath);
  const perfettoRoot = path.join(normalizedRoot, 'perfetto');
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    if (target.startsWith('protos/')) return path.join(perfettoRoot, target);
    return protobuf.util.path.resolve(origin, target);
  };
  root.loadSync([
    path.join(perfettoRoot, 'protos/perfetto/trace/trace.proto'),
    path.join(perfettoRoot, 'protos/third_party/android/art/heap_graph.proto'),
    path.join(perfettoRoot, 'protos/perfetto/trace/gpu/gpu_interned_data.proto'),
  ]);
  root.resolveAll();
  const traceType = root.lookupType('perfetto.protos.Trace');
  cache.set(normalizedRoot, traceType);
  return traceType;
}

function encodeTrace(repoRoot, packets) {
  const traceType = loadTraceType(repoRoot);
  const message = traceType.fromObject({packet: packets});
  const validationError = traceType.verify(message);
  if (validationError) throw new Error(`Invalid Perfetto Trace protobuf: ${validationError}`);
  return Buffer.from(traceType.encode(message).finish());
}

function collectPacketSequenceIds(repoRoot, traceBuffer) {
  const traceType = loadTraceType(repoRoot);
  const trace = traceType.decode(traceBuffer);
  return new Set(
    trace.packet
      .map((packet) => packet.trustedPacketSequenceId)
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

module.exports = {collectPacketSequenceIds, encodeTrace, loadTraceType};
