// Shared by the shipped host bundle and isolated feature smoke tests.
exports.hostBuildOptions = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node20.18'],
  external: ['vscode', '@huggingface/transformers', '@huggingface/hub', 'onnxruntime-node', 'sharp', 'pdf-parse'],
};
