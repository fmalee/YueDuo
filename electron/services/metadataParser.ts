/**
 * 元数据解析（方案 §2.4，对齐 Python metadata_parser）：
 * 实现放在 shared/metadataParser.ts —— 渲染层元数据栏按编辑器前 10 行本地预览，
 * 主进程扫描/保存/写回也按同一口径解析，两边共用同一份正则，避免两套解析漂移。
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），便于脚本单测。
 */
export { findTopic, parseMetadata, splitTags } from '../../shared/metadataParser'
