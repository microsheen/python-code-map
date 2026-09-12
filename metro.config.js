const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// wasm 主要通过 public/ 托管（expo export 会原样拷贝）。
// 这里额外让 Metro 认识 .wasm 资源，作为 Image.resolveAssetSource 的兜底方案。
config.resolver.assetExts.push('wasm');

module.exports = config;
