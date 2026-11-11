# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The plugin shell: the plugin `inference.core`, its TUI `inference.core.tui`, the `inference` namespace, the status RPC `inference.core`, the tools RPC `inference.core.tools` and `/inference-status`.
- Three local tools, all `read` and none calling a network service: `inference_status`, `inference_capabilities` and `inference_plan`.
- One registry that drives the model tools, the tools RPC methods and classes, the default permission block, the Jelly declaration and the generated docs.
- Strict plugin-domain contracts, exported as JSON Schema: `SourceInput`, `ArtifactRef`, `EvidenceRef`, `Coverage`, `Usage`, `InferenceResult` and the extract, decide, read and plan inputs.
- Strict options (`access`, `modules`, `profiles`, `routing`, `limits`, `spend`, `data`, `cache`, `allowUntestedHost`); a key-like option is refused.
- The plugin-owned `/connect` entry "OpenRouter for Inference" (`inference-openrouter`). Status reports only whether it is connected; this version never reads the key.
- A dated, documentation-derived capability fixture for `cloudflare/clairic`, `scaledown/extract`, `inception/mercury-decide`, `levanto/sage-2` and `typesafe/jev-1.14`, with every route disabled and no prices.
